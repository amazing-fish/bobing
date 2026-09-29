// 客人在某个房间里的身份 { id, key }：按房间号记在 localStorage，关掉标签页、浏览器杀掉后台页面、
// 从聊天软件重新打开链接，都能凭同一身份回到原座位（之前放在 sessionStorage，换个标签页就成了同名的新玩家）。
// 同一浏览器同时开两个标签页进同一房间：用 Web Locks 独占身份，第二个标签页拿不到锁就用新身份，
// 两边不会互相顶掉。
import { randomId } from './session.js';

const ROOMS_KEY = 'bobing.rooms';
const TAB_KEY = 'bobing.tab';
const MAX_ROOMS = 20;
const TTL_MS = 3 * 24 * 3600 * 1000;

function read(storage, k) {
  try {
    return JSON.parse(storage?.getItem(k) || '{}') || {};
  } catch {
    return {};
  }
}

function write(storage, k, v) {
  try {
    storage?.setItem(k, JSON.stringify(v));
  } catch {}
}

const valid = (x) => x && typeof x.id === 'string' && typeof x.key === 'string' && x.id && x.key.length >= 16;

/** 试着独占这个身份；拿到锁返回释放函数，被别的标签页占着返回 null。浏览器不支持时视为拿到 */
async function tryHold(locks, code, id) {
  if (!locks?.request) return () => {};
  let release;
  const held = new Promise((r) => (release = r));
  const got = await new Promise((resolve) => {
    locks
      .request(`bobing/${code}/${id}`, { ifAvailable: true }, (lock) => {
        resolve(!!lock);
        return lock ? held : undefined;
      })
      .catch(() => resolve(true));
  });
  return got ? release : null;
}

/**
 * 取得本标签页在房间 code 里的身份，并独占它直到调用 release()
 * @returns {Promise<{id: string, key: string, release: () => void}>}
 */
export async function seatIdentity(code, { local = globalThis.localStorage, session = globalThis.sessionStorage, locks = globalThis.navigator?.locks, now = Date.now() } = {}) {
  const rooms = read(local, ROOMS_KEY);
  const tab = read(session, TAB_KEY);
  // 先用本标签页上次用过的（刷新），再用这个浏览器上次在该房间的
  if (valid(rooms[code]) && now - (rooms[code].t || 0) >= TTL_MS) delete rooms[code];
  const candidates = [tab[code], rooms[code]].filter(valid);
  let me = null;
  let release = null;
  for (const c of candidates) {
    release = await tryHold(locks, code, c.id);
    if (release) {
      me = { id: c.id, key: c.key };
      break;
    }
  }
  if (!me) {
    me = { id: randomId(), key: randomId() };
    release = (await tryHold(locks, code, me.id)) || (() => {});
  }
  tab[code] = me;
  write(session, TAB_KEY, tab);
  // 只有房间里的"主身份"才记进 localStorage：第二个标签页的临时身份不覆盖它
  if (!valid(rooms[code]) || rooms[code].id === me.id) rooms[code] = { ...me, t: now };
  else rooms[code].t = now;
  const kept = Object.entries(rooms)
    .filter(([, v]) => valid(v) && now - (v.t || 0) < TTL_MS)
    .sort((a, b) => b[1].t - a[1].t)
    .slice(0, MAX_ROOMS);
  write(local, ROOMS_KEY, Object.fromEntries(kept));
  return { ...me, release };
}
