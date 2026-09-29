// 入口：页面流程、界面渲染、蓄力投掷
import { initPhysics, encodeFrames, HAND, PICKUP_MS } from './physics.js';
import { PRIZES, PRIZE_BY_ID, ZY_LEVELS, totalCakes } from './rules.js';
import { defaultPool } from './game.js';
import { HostSession, ClientSession, friendlyError, randomId, normalizeCode, formatCode } from './session.js';
import { seatIdentity } from './identity.js';
import { HandController } from './hand.js';
import { unlockAudio, playImpact, playShake, playChime, playFail, setMuted, isMuted } from './audio.js';

const $ = (id) => document.getElementById(id);
const SEAT_COLORS = ['#e63b2e', '#f2a31b', '#2e8b57', '#2f6fd6', '#8e44ad', '#d6457a', '#16a3a3', '#7a5230'];
const POINTS = { zhuangyuan: 32, duitang: 16, sanhong: 8, sijin: 4, erju: 2, yixiu: 1 };
const PRESETS = {
  standard: defaultPool(),
  quick: { zhuangyuan: 1, duitang: 1, sanhong: 2, sijin: 2, erju: 4, yixiu: 8 },
};
const PIP_CELLS = { 1: [5], 2: [3, 7], 3: [3, 5, 7], 4: [1, 3, 7, 9], 5: [1, 3, 5, 7, 9], 6: [1, 3, 4, 6, 7, 9] };

let stage = null;
let session = null;
let view = null; // 当前展示的状态快照
let animating = false;
let pendingState = null;
let endShownFor = null;
const store = {
  get(k, d) {
    try {
      return localStorage.getItem(k) ?? d;
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, v);
    } catch {}
  },
};

// ---------- 启动 ----------
boot();

async function boot() {
  const loadingText = $('loading-text');
  try {
    const [{ Stage }] = await Promise.all([import('./scene.js'), initPhysics()]);
    stage = new Stage($('stage'));
    if (new URLSearchParams(location.search).has('debug')) window.__bobing = { stage, get hand() { return hand; }, get session() { return session; } };
  } catch (e) {
    console.error(e);
    loadingText.textContent = '三维场景加载失败：请使用支持 WebGL 的新版浏览器（Chrome / Edge / Safari / Firefox）。';
    return;
  }
  $('loading').hidden = true;
  setupHome();
  setupLobby();
  setupGame();
  setupDialogs();
  showScreen('home');
  // 邀请链接把房间号放在 # 后面（不会发给任何服务器）；也兼容旧的 ?room=
  const code = normalizeCode(new URLSearchParams(location.hash.slice(1)).get('room') || new URLSearchParams(location.search).get('room'));
  if (code) {
    $('in-code').value = formatCode(code);
    setMsg('home-msg', '已填好房间号，输入昵称后点“加入”', true);
  }
}

function showScreen(name) {
  for (const s of ['home', 'lobby', 'game']) $(`screen-${s}`).hidden = s !== name;
  if (name !== 'game') stage?.setShot({ kind: 'overview' });
}

function setMsg(id, text, info = false) {
  const el = $(id);
  el.textContent = text || '';
  el.classList.toggle('info', info);
}

// ---------- 首页 ----------
function setupHome() {
  const nameIn = $('in-name');
  nameIn.value = store.get('bobing.name', '');
  nameIn.addEventListener('change', () => store.set('bobing.name', nameIn.value.trim()));
  $('btn-create').onclick = () => startSession('host');
  $('btn-local').onclick = () => startSession('local');
  $('btn-join').onclick = () => startSession('client');
  $('in-code').addEventListener('keydown', (e) => e.key === 'Enter' && startSession('client'));
}

let releaseSeat = null; // 释放本标签页独占的客人身份（见 identity.js）

async function startSession(kind) {
  unlockAudio();
  const name = $('in-name').value.trim();
  if (!name) {
    setMsg('home-msg', '先给自己起个昵称吧');
    $('in-name').focus();
    return;
  }
  store.set('bobing.name', name);
  const code = normalizeCode($('in-code').value);
  if (kind === 'client' && !code) {
    setMsg('home-msg', '请输入 10 位房间号（如 ABCDE-FGHJK）');
    $('in-code').focus();
    return;
  }
  setButtonsBusy(true);
  // 客人：同一浏览器再进同一房间沿用原身份，回到原座位；房主每次开房都是新房间，用新身份即可
  releaseSeat?.();
  releaseSeat = null;
  let me = { id: randomId(), key: randomId(), name };
  if (kind === 'client') {
    const seat = await seatIdentity(code);
    releaseSeat = seat.release;
    me = { id: seat.id, key: seat.key, name };
  }
  setMsg('home-msg', kind === 'client' ? '正在寻找房间…' : kind === 'host' ? '正在创建房间…' : '', true);
  const s = kind === 'client' ? new ClientSession({ me, code }) : new HostSession({ mode: kind, me });
  bindSession(s);
  try {
    await s.open();
    session = s;
    keepAwake(true);
    if (s.code) history.replaceState(null, '', `${location.pathname}#room=${s.code}`);
    setMsg('home-msg', '');
    renderNet();
    render(s.state ? structuredClone(s.state) : view);
  } catch (e) {
    console.warn(e);
    s.close?.();
    releaseSeat?.();
    releaseSeat = null;
    setMsg('home-msg', friendlyError(e));
  } finally {
    setButtonsBusy(false);
  }
}

function setButtonsBusy(b) {
  for (const id of ['btn-create', 'btn-join', 'btn-local']) $(id).disabled = b;
}

function bindSession(s) {
  s.on('state', (st) => {
    if (s !== session && session) return;
    if (animating) pendingState = st;
    else render(st);
  });
  s.on('roll', (roll) => {
    if (session && s !== session) return;
    playRoll(roll);
  });
  s.on('hold', (h) => {
    if (s === session) onHold(h);
  });
  s.on('warn', (text) => flashMsg(text));
  s.on('net', () => s === session && renderNet());
  s.on('error', (text) => {
    if (s !== session) return;
    leave(text);
  });
}

/** 客人的连接状态：断线重连中给出提示；大厅里显示是直连还是经服务器中转 */
function renderNet() {
  const client = session?.mode === 'client';
  const el = $('net-status');
  el.hidden = !client || session.status !== 'reconnecting';
  const kind = client ? session.linkKind : null;
  $('link-kind').textContent = kind === 'p2p' ? '已与房主直连' : kind === 'relay' ? '经服务器中转（直连不可用，延迟稍高但不影响游戏）' : '';
  updateThrowButton();
}

// ---------- 防止手机息屏 ----------
// 息屏后浏览器会冻结页面、联机随之中断；在房间里时保持屏幕常亮（切回页面时重新申请）
let wake = null; // Promise<WakeLockSentinel>
function keepAwake(on) {
  if (!navigator.wakeLock) return;
  if (!on) {
    wake?.then((l) => l.release()).catch(() => {});
    wake = null;
    return;
  }
  if (wake || document.visibilityState !== 'visible') return;
  const p = navigator.wakeLock.request('screen');
  wake = p;
  p.then((l) => l.addEventListener('release', () => wake === p && (wake = null))).catch(() => wake === p && (wake = null));
}
document.addEventListener('visibilitychange', () => session && keepAwake(true));

function leave(msg = '') {
  session?.close();
  session = null;
  releaseSeat?.();
  releaseSeat = null;
  keepAwake(false);
  $('net-status').hidden = true;
  clearTimeout(grab?.timer);
  clearTimeout(awaiting?.timer);
  grab = null;
  awaiting = null;
  hand.stop();
  stage.setLive(null);
  stage.setAim(null);
  view = null;
  animating = false;
  pendingState = null;
  endShownFor = null;
  $('toast').hidden = true;
  $('dlg-end').open && $('dlg-end').close();
  history.replaceState(null, '', location.pathname);
  showScreen('home');
  setMsg('home-msg', msg);
}

function flashMsg(text) {
  const target = view?.phase === 'lobby' ? 'lobby-msg' : 'home-msg';
  if (view?.phase === 'lobby') setMsg(target, text);
  else showToast({ who: '', main: '', sub: text, cls: 'dim' }, 2200);
}

// ---------- 渲染 ----------
function render(st) {
  if (!st) return;
  const prevPhase = view?.phase;
  view = st;
  if (st.phase === 'lobby') {
    showScreen('lobby');
    renderLobby(st);
    if ($('dlg-end').open) $('dlg-end').close();
    endShownFor = null;
  } else {
    showScreen('game');
    if (prevPhase === 'lobby' && st.lastOutcome == null) stage.setRest([4, 4, 4, 1, 2, 6]);
    renderGame(st);
    if (!animating) directCamera(st);
    if (st.phase === 'ended' && endShownFor !== st.throws) {
      endShownFor = st.throws;
      showEnd(st);
    }
  }
  updateThrowButton();
}

/** 座位方位角：按当前玩家人数均分一圈，镜头站在该座位后方 */
function seatAz(st, playerId) {
  const i = st.players.findIndex((p) => p.id === playerId);
  return Math.PI / 2 + (Math.max(0, i) / Math.max(1, st.players.length)) * Math.PI * 2;
}

/** 镜头跟随：轮到谁就切到谁的座位；本局结束则俯看碗 */
function directCamera(st) {
  const cur = st.players[st.turn];
  if (st.phase === 'ended') stage.setShot({ kind: 'result', az: stage.shot.az ?? stage.cam.az });
  else if (cur) stage.setShot({ kind: 'seat', az: seatAz(st, cur.id) });
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function dieIcon(v, out = false) {
  const cells = PIP_CELLS[v] || [];
  let html = '';
  for (let i = 1; i <= 9; i++) html += cells.includes(i) ? '<i></i>' : '<s></s>';
  const cls = ['die-ico', v === 1 || v === 4 ? 'red' : '', v === 1 ? 'one' : '', out ? 'out' : ''].join(' ');
  return `<span class="${cls}" role="img" aria-label="${v}点">${html}</span>`;
}

function diceRow(dice, outMask = []) {
  return `<div class="dice-row">${dice.map((d, i) => dieIcon(d, outMask[i])).join('')}</div>`;
}

function badges(p, st) {
  const b = [];
  if (p.isBot) b.push('<span class="badge bot">电脑</span>');
  if (st.hostId === p.id && session?.mode !== 'local') b.push('<span class="badge host">房主</span>');
  if (p.id === session?.meId && session?.mode !== 'local') b.push('<span class="badge me">我</span>');
  if (!p.online) b.push('<span class="badge off">离线</span>');
  return b.join(' ');
}

function score(p) {
  return Object.entries(p.won).reduce((a, [k, n]) => a + (POINTS[k] || 0) * n, 0);
}

function wonText(p) {
  const parts = PRIZES.filter((x) => p.won[x.id]).map((x) => `${x.name}×${p.won[x.id]}`);
  return parts.join(' ') || '还没博到饼';
}

// ---------- 大厅 ----------
function setupLobby() {
  $('btn-copy').onclick = copyInvite;
  $('btn-add-bot').onclick = () => session?.addBot();
  $('btn-add-local').onclick = () => {
    const name = $('in-local-name').value.trim();
    session?.addLocalPlayer(name);
    $('in-local-name').value = '';
  };
  $('in-local-name').addEventListener('keydown', (e) => e.key === 'Enter' && $('btn-add-local').click());
  $('btn-start').onclick = () => {
    unlockAudio();
    session?.start();
  };
  $('btn-leave').onclick = () => leave();
  $('lobby-players').addEventListener('click', (e) => {
    const id = e.target.closest('[data-kick]')?.dataset.kick;
    if (id) session?.kick(id);
  });
  $('pool-editor').addEventListener('change', () => {
    const pool = {};
    for (const inp of $('pool-editor').querySelectorAll('input')) pool[inp.name] = Number(inp.value);
    session?.setPool(pool);
  });
  $('pool-presets').addEventListener('click', (e) => {
    const k = e.target.dataset.preset;
    if (k) session?.setPool(PRESETS[k]);
  });
}

function renderLobby(st) {
  const host = session?.isHost;
  const local = session?.mode === 'local';
  $('lobby-title').textContent = local ? '单机 / 同屏多人' : host ? '你的房间' : '已加入房间';
  $('share-box').hidden = local;
  $('room-code').textContent = formatCode(session?.code || st.code) || '-----';
  $('player-count').textContent = `${st.players.length} / 8`;
  $('lobby-players').innerHTML = st.players
    .map(
      (p) => `<li><span class="seat-dot" style="background:${SEAT_COLORS[p.seat % 8]}"></span>
        <span class="name">${esc(p.name)}</span>${badges(p, st)}
        ${host && p.id !== session.meId ? `<button class="kick" data-kick="${esc(p.id)}" aria-label="移除 ${esc(p.name)}">×</button>` : ''}</li>`,
    )
    .join('');
  $('host-tools').hidden = !host;
  $('local-add').hidden = !local;
  $('pool-presets').hidden = !host;
  const editor = $('pool-editor');
  if (!editor.contains(document.activeElement)) {
    editor.innerHTML = PRIZES.map((p) =>
      host
        ? `<label>${p.name}<input type="number" name="${p.id}" min="0" max="99" inputmode="numeric" value="${st.pool[p.id]}"></label>`
        : `<label>${p.name}<span class="ro">${st.pool[p.id]}</span></label>`,
    ).join('');
  }
  $('pool-total').textContent = `共 ${totalCakes(st.pool)} 个饼`;
  $('btn-start').hidden = !host;
  $('btn-start').disabled = st.players.length < 1 || totalCakes(st.pool) < 1;
  if (!host) setMsg('lobby-msg', '等待房主开始…', true);
  else if (!local && st.players.length < 2) setMsg('lobby-msg', '邀请朋友加入，或添加电脑玩家', true);
  else setMsg('lobby-msg', '');
}

async function copyInvite() {
  const url = `${location.origin}${location.pathname}#room=${session?.code}`;
  try {
    await navigator.clipboard.writeText(url);
    setMsg('lobby-msg', '邀请链接已复制', true);
  } catch {
    prompt('复制这个邀请链接：', url);
  }
}

// ---------- 对局 ----------
function setupGame() {
  $('btn-exit').onclick = () => {
    if (confirm(session?.isHost && session.mode === 'host' ? '你是房主，离开后房间会解散。确定离开？' : '确定离开牌桌？')) leave();
  };
  $('btn-panel').onclick = () => {
    const open = $('side').classList.toggle('open');
    $('btn-panel').setAttribute('aria-expanded', String(open));
  };
  const mute = $('btn-mute');
  setMuted(store.get('bobing.muted', '0') === '1');
  const syncMute = () => {
    mute.textContent = isMuted() ? '静音中' : '音效';
    mute.setAttribute('aria-pressed', String(isMuted()));
  };
  syncMute();
  mute.onclick = () => {
    unlockAudio();
    setMuted(!isMuted());
    store.set('bobing.muted', isMuted() ? '1' : '0');
    syncMute();
  };
  // 视角：跟随（默认，所有人同一机位）/ 自由（自己拖动）
  const camBtn = $('btn-cam');
  camBtn.onclick = () => {
    const free = !stage.free;
    stage.setFreeCamera(free);
    camBtn.textContent = free ? '视角:自由' : '视角:跟随';
    camBtn.setAttribute('aria-pressed', String(free));
    if (!free && view) directCamera(view);
  };
  setupThrow();
  setupMotion();
}

// ---------- 手机体感摇骰 ----------
// 手机上不再用手指按住拖动（容易触发长按菜单、误触即掷出）。两种方式：
// 1) 一键掷骰；2) 开启体感后，轮到你时直接晃手机：一晃就把骰子抓进掌心，晃动推着掌心走；
//    摇的过程中猛地一甩就立即掷出，力度随甩的猛烈程度；或者停下来顺势轻抛（也可以点"掷出"）。不需要按住屏幕。
const TOUCH = matchMedia('(pointer: coarse)').matches;
const SHAKE_START = 6; // 晃动强度（m/s²，平滑后）超过它才开始，避免拿起手机时误触发
const SHAKE_CALM = 3; // 低于它持续 CALM_MS 视为停下
const CALM_MS = 220;
const SHAKE_MIN_MS = 500; // 至少摇这么久才会因为停下而自动掷出
const SHAKE_MAX_MS = 6000;
// 甩出：瞬时加速度同时超过 FLICK_MIN，且是此前晃动强度的 FLICK_RATIO 倍（区别于持续的来回摇）
const FLICK_MIN = 20;
const FLICK_RATIO = 2.2;
const FLICK_AFTER_MS = 300; // 刚抓起时的晃动不算甩
let motion = { on: false, a: null, t: 0, energy: 0, peak: 0, calmSince: 0, flick: 0 };

function motionHint() {
  if (!TOUCH) return '在碗上<b>按住</b>抓起骰子 → <b>拖动</b>摇一摇 → <b>甩一下松手</b>';
  return motion.on ? '<b>晃动手机</b>摇骰子，<b>猛地一甩</b>掷出（停下也会轻抛）' : '点<b>一键掷骰</b>，或开启<b>体感摇骰</b>后晃手机';
}

function setupMotion() {
  const btn = $('btn-motion');
  $('throw-hint').innerHTML = motionHint();
  if (!('DeviceMotionEvent' in window) || !TOUCH) return;
  btn.hidden = false;
  const needPermission = typeof DeviceMotionEvent.requestPermission === 'function';
  const sync = () => {
    btn.textContent = motion.on ? '体感摇骰：开' : '体感摇骰：关';
    btn.setAttribute('aria-pressed', String(motion.on));
    $('throw-hint').innerHTML = motionHint();
  };
  btn.onclick = async () => {
    if (!motion.on && needPermission) {
      // iOS 13+ 需要在点击里申请权限
      try {
        if ((await DeviceMotionEvent.requestPermission()) !== 'granted') {
          flashMsg('没有获得运动传感器权限，可在系统设置中开启');
          return;
        }
      } catch {
        flashMsg('无法开启体感：浏览器拒绝了传感器权限');
        return;
      }
    }
    motion.on = !motion.on;
    motion.energy = 0;
    store.set('bobing.motion', motion.on ? '1' : '0');
    sync();
    if (motion.on) navigator.vibrate?.(20);
  };
  // 安卓不需要授权，记住上次的选择；iOS 每次需要点一下授权
  if (store.get('bobing.motion', '0') === '1' && !needPermission) motion.on = true;
  sync();

  let lp = null; // 含重力时的低通值（用于没有 acceleration 的设备）
  let lastT = 0;
  window.addEventListener('devicemotion', (e) => {
    if (!motion.on) return;
    let a = e.acceleration;
    if (!a || a.x == null) {
      const g = e.accelerationIncludingGravity;
      if (!g || g.x == null) return;
      lp = lp ? { x: lp.x * 0.9 + g.x * 0.1, y: lp.y * 0.9 + g.y * 0.1, z: lp.z * 0.9 + g.z * 0.1 } : { x: g.x, y: g.y, z: g.z };
      a = { x: g.x - lp.x, y: g.y - lp.y, z: g.z - lp.z };
    }
    const now = performance.now();
    const dt = Math.min(0.1, (now - (lastT || now)) / 1000) || 0.016;
    lastT = now;
    motion.a = { x: a.x || 0, y: a.y || 0, z: a.z || 0 };
    motion.t = now;
    // 晃动强度：加速度大小的指数平均（约 0.15 秒）
    const mag = Math.hypot(motion.a.x, motion.a.y, motion.a.z);
    const before = motion.energy;
    motion.energy += (mag - motion.energy) * Math.min(1, dt / 0.15);
    onShake(now, mag, before);
  });
}

/** 由晃动决定：开始摇（抓起骰子）→ 摇动中 → 甩出 / 停下（掷出） */
function onShake(now, mag, before) {
  const e = motion.energy;
  if (!grab) {
    if (e > SHAKE_START && canGrab() && !document.querySelector('dialog[open]')) startShakeGrab();
    return;
  }
  if (grab.kind !== 'shake') return;
  const held = now - grab.t0;
  if (held > FLICK_AFTER_MS && mag > FLICK_MIN && mag > before * FLICK_RATIO) {
    motion.flick = mag;
    return releaseGrab('flick');
  }
  motion.peak = Math.max(motion.peak, e);
  if (e > SHAKE_CALM) motion.calmSince = 0;
  else motion.calmSince ||= now;
  if (held > SHAKE_MIN_MS && motion.calmSince && now - motion.calmSince > CALM_MS) releaseGrab('calm');
  else if (held > SHAKE_MAX_MS) releaseGrab('calm');
}

function startShakeGrab() {
  unlockAudio();
  motion.peak = motion.energy;
  motion.calmSince = 0;
  motion.flick = 0;
  navigator.vibrate?.(30);
  // 掌心从碗心附近随机一点起手，晃动推着它走；弹簧的锚点也会慢慢游走（见 tickHand），每次出手位置都不同
  startGrab(null, wanderPoint(), 'shake');
}

/** 碗心附近的随机一点（半径 WANDER_R 内） */
const WANDER_R = 5;
function wanderPoint() {
  const a = Math.random() * Math.PI * 2;
  const r = WANDER_R * Math.sqrt(Math.random());
  return { x: Math.cos(a) * r, z: Math.sin(a) * r };
}

/** 把手机加速度（设备坐标，m/s²）换算成掌心在世界坐标里受到的加速度（cm/s²） */
function motionToWorld() {
  if (!motion.on || !motion.a || performance.now() - motion.t > 150) return null;
  const ang = ((screen.orientation?.angle ?? window.orientation ?? 0) * Math.PI) / 180;
  const { x, y, z } = motion.a;
  // 设备坐标 → 屏幕坐标（屏幕旋转后 x/y 轴对调）
  const sx = x * Math.cos(ang) - y * Math.sin(ang);
  const sy = x * Math.sin(ang) + y * Math.cos(ang);
  // 屏幕右 = 镜头右方，屏幕上 = 镜头前方（远离玩家），屏幕法线 = 竖直
  const az = stage.cam.az;
  const K = 250; // 1 m/s² 的晃动 → 掌心 250 cm/s² 的推力（经模拟调过，正常晃动约 ±3cm）
  return {
    x: (Math.sin(az) * sx - Math.cos(az) * sy) * K,
    y: z * K * 0.6,
    z: (-Math.cos(az) * sx - Math.sin(az) * sy) * K,
  };
}

/**
 * 体感出手时补的水平抛出速度：大致朝碗对面（远离玩家），方向随机偏转。
 * 甩出：力度随甩的猛烈程度，甩得太猛会出碗；停下：轻抛，力度随刚才摇得多猛
 */
function shakeToss(how) {
  const flick = how === 'flick';
  const k = flick
    ? Math.min(1, Math.max(0, (motion.flick - FLICK_MIN) / 25))
    : Math.min(1, Math.max(0, (motion.peak - SHAKE_START) / 12));
  const sp = flick ? 25 + 55 * k : 35 + 40 * k;
  const spread = flick ? 0.5 : 0.9; // 弧度
  // 镜头在玩家身后，朝碗心方向 = -(cos az, sin az)
  const az = stage.cam.az + (Math.random() * 2 - 1) * spread;
  const j = 0.85 + Math.random() * 0.3;
  return { x: -Math.cos(az) * sp * j, z: -Math.sin(az) * sp * j };
}

function renderGame(st) {
  $('pool-bar').innerHTML = PRIZES.map(
    (p) => `<span class="chip ${st.pool[p.id] ? '' : 'empty'} ${p.id === 'zhuangyuan' ? 'zy' : ''}">${p.name}<b>${st.pool[p.id]}</b></span>`,
  ).join('');

  const zy = st.zy;
  $('zy-box').innerHTML = zy
    ? `当前状元：<span class="zy-name">${esc(zy.name)}</span> · ${esc(zy.label)}${diceRow(zy.dice)}`
    : '状元尚未出现，4个4起可夺状元';

  const cur = st.players[st.turn];
  $('players').innerHTML = st.players
    .map((p) => {
      const cls = [p === cur && st.phase === 'playing' ? 'turn' : '', p.online ? '' : 'off'].join(' ');
      const crown = zy?.playerId === p.id ? ' 👑' : '';
      return `<li class="${cls}"><span class="seat-dot" style="background:${SEAT_COLORS[p.seat % 8]}"></span>
        <span class="pname">${esc(p.name)}${crown} ${badges(p, st)}</span><span class="score">${score(p)}</span>
        <span class="won">${wonText(p)}</span></li>`;
    })
    .join('');

  const log = $('log');
  log.innerHTML = st.log.slice(-30).reverse().map((l) => `<li>${esc(l.text)}</li>`).join('');

  const banner = $('turn-banner');
  if (st.phase === 'ended') {
    banner.textContent = '本局结束';
    banner.classList.remove('mine');
  } else if (cur) {
    const mine = session?.canThrow() && !cur.isBot;
    const who = session?.mode !== 'local' && cur.id === session?.meId ? '你' : cur.name;
    banner.textContent = cur.isBot ? `${cur.name}（电脑）正在掷骰…` : mine ? `轮到${who}掷骰` : `等待 ${cur.name} 掷骰…`;
    banner.classList.toggle('mine', !!mine);
  }
}

function canGrab() {
  return !!session && view?.phase === 'playing' && !animating && !awaiting && $('toast').hidden && !hand.active && session.canThrow();
}

function updateThrowButton() {
  const btn = $('btn-throw');
  const ok = canGrab();
  const shaking = grab?.kind === 'shake';
  btn.disabled = !ok && !shaking;
  btn.textContent =
    view?.phase === 'ended' ? '本局已结束'
    : shaking ? '掷出'
    : hand.mode === 'hold' ? '摇一摇，松手掷出'
    : ok ? '一键掷骰'
    : session?.status === 'reconnecting' ? '重连中…'
    : '等待其他玩家';
  $('throw-hint').hidden = !ok;
  $('power').hidden = hand.mode !== 'hold';
  stage.canvas.classList.toggle('grabbable', ok && !TOUCH);
}

// ---------- 手势摇骰 ----------
// 在碗上按住 → 骰子进掌心；拖动摇晃（骰子在掌心里真实碰撞）；甩动并松手 → 掷出
const hand = new HandController();
const HOLD_SEND_MS = 50;
const HOLD_MAX_MS = 12000; // 鼠标拖着不放时的兜底；体感摇骰另有 SHAKE_MAX_MS
let grab = null; // { pointerId, lastSend, timer, sounds }
let awaiting = null; // 已发出投掷请求，等待房主结果 { t, timer }
let lastBuzz = 0;

function setupThrow() {
  const canvas = stage.canvas;
  stage.onTick = tickHand;
  // 捕获阶段拦截，避免与视角旋转（OrbitControls）冲突：抓骰时不转视角
  window.addEventListener(
    'pointerdown',
    (e) => {
      if (e.target !== canvas) return;
      if (grab) {
        e.stopImmediatePropagation();
        return;
      }
      // 触屏不用手指抓骰（长按会弹系统菜单、轻碰就掷出）：用一键掷骰或体感摇骰
      if (e.pointerType === 'touch' || e.button !== 0 || !canGrab()) return;
      const xz = stage.pointerToHand(e.clientX, e.clientY);
      if (!xz || Math.hypot(xz.x, xz.z) > HAND.reach + 2) return;
      e.stopImmediatePropagation();
      e.preventDefault();
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {}
      startGrab(e.pointerId, xz);
    },
    true,
  );
  window.addEventListener(
    'pointermove',
    (e) => {
      if (!grab || e.pointerId !== grab.pointerId) return;
      e.stopImmediatePropagation();
      const xz = stage.pointerToHand(e.clientX, e.clientY);
      if (xz) hand.setTarget(xz);
    },
    true,
  );
  const end = (e) => {
    if (!grab || e.pointerId !== grab.pointerId) return;
    e.stopImmediatePropagation();
    releaseGrab();
  };
  window.addEventListener('pointerup', end, true);
  window.addEventListener('pointercancel', end, true);
  // 手机上长按不弹"复制/查词"菜单
  $('screen-game').addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  // 一键掷骰（也是键盘与读屏用户的入口）：自动完成抓起、摇晃、掷出
  $('btn-throw').addEventListener('click', autoThrow);
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' || e.repeat || $('screen-game').hidden || document.querySelector('dialog[open]')) return;
    e.preventDefault();
    autoThrow();
  });
}

function autoThrow() {
  if (grab?.kind === 'shake') return releaseGrab();
  if (!canGrab()) return;
  unlockAudio();
  lockThrow();
  session.throwDice({ power: 0.25 + Math.random() * 0.4 });
}

/** 发出投掷请求后锁定，直到结果到达；房主无响应时恢复 */
function lockThrow() {
  clearTimeout(awaiting?.timer);
  awaiting = {
    t: performance.now(),
    timer: setTimeout(() => {
      awaiting = null;
      hand.stop();
      stage.settle();
      flashMsg('房主没有响应，请再试一次');
      updateThrowButton();
    }, 7000),
  };
  updateThrowButton();
}

/** kind: 'drag' 鼠标拖动 | 'shake' 手机体感 */
function startGrab(pointerId, xz, kind = 'drag') {
  unlockAudio();
  hand.grab(xz);
  hand.setTarget(xz);
  grab = { kind, pointerId, t0: performance.now(), lastSend: 0, sounds: [], timer: setTimeout(releaseGrab, HOLD_MAX_MS) };
  stage.setLive(hand.frame, true);
  const cur = view.players[view.turn];
  const who = session.mode === 'local' ? cur.name : '你';
  $('turn-banner').textContent = kind === 'shake' ? `${who}：摇啊摇，甩一下掷出` : `${who}：摇一摇，甩出去`;
  updateThrowButton();
}

function tickHand(dt) {
  if (!hand.active) return;
  if (hand.mode === 'hold' && grab?.kind === 'shake') {
    hand.setExternal(motionToWorld());
    // 掌心的锚点慢慢游走：停下时落在哪儿、朝哪儿抛都带点随机
    const now = performance.now();
    if (now > (grab.wanderAt ?? 0)) {
      grab.wanderAt = now + 500 + Math.random() * 700;
      grab.goal = wanderPoint();
      grab.anchor ??= { x: hand.target.x, z: hand.target.z };
    }
    const k = Math.min(1, dt / 0.45);
    grab.anchor.x += (grab.goal.x - grab.anchor.x) * k;
    grab.anchor.z += (grab.goal.z - grab.anchor.z) * k;
    hand.setTarget(grab.anchor);
  } else if (hand.mode === 'hold') hand.setExternal(null);
  const sounds = hand.update(dt);
  for (const s of sounds) {
    playImpact(s.k, s.s);
    if (s.k === 3 && s.s > 0.25 && performance.now() - lastBuzz > 70) {
      lastBuzz = performance.now();
      navigator.vibrate?.(8);
    }
  }
  if (hand.mode !== 'hold') return;
  grab.sounds.push(...sounds.map((s) => [s.k, s.s]));
  stage.setAim({ x: hand.pos.x, z: hand.pos.z });
  if (grab.kind === 'shake') {
    // 体感：显示晃动强度；停在碗心上方，不会掉出碗外
    const k = Math.min(1, motion.energy / 18);
    $('power-fill').style.width = `${k * 100}%`;
    $('power-label').textContent = motion.calmSince ? '停下了，轻抛…' : k < 0.5 ? '摇啊摇…' : '摇得正欢，甩一下掷出';
    return sendHold();
  }
  const sp = hand.speed01();
  $('power-fill').style.width = `${sp * 100}%`;
  // 阈值对应实测出碗率：约 120 cm/s 以下安全，190 以上明显容易出碗
  $('power-label').textContent = hand.outside() ? '在碗外！松手会掉桌上' : sp < 0.3 ? '轻摇' : sp < 0.58 ? '摇得正好' : sp < 0.88 ? '用力' : '太猛，小心出碗';
  sendHold();
}

/** 摇骰画面同步给其他玩家（20Hz） */
function sendHold() {
  const now = performance.now();
  if (now - grab.lastSend < HOLD_SEND_MS) return;
  grab.lastSend = now;
  session.sendHold({ f: encodeFrames(hand.frame), s: grab.sounds.splice(0, 8) });
}

/** how：体感摇骰的出手方式 'flick' 甩出 | 'calm' 停下 | 'button' 点按钮 */
function releaseGrab(how = 'button') {
  if (!grab) return;
  clearTimeout(grab.timer);
  const toss = grab.kind === 'shake' ? shakeToss(how) : null;
  if (grab.kind === 'shake') navigator.vibrate?.(how === 'flick' ? 40 : 20);
  grab = null;
  const rel = hand.release(toss);
  stage.setAim(null);
  if (!rel) return updateThrowButton();
  // 本机只预演到骰子碰碗之前：碰撞之后本机与房主的仿真会分叉（结果对不上），
  // 所以在碗上方减速悬停，等房主的权威轨迹接上，之后看到的每一帧都与其他人一致
  stage.playPrelude(rel.pre);
  lockThrow();
  session.throwDice({ init: rel.init.map((v) => Math.round(v * 1000) / 1000) });
  clearTimeout(judgeHint);
  judgeHint = setTimeout(() => {
    if (awaiting && stage.pre) $('turn-banner').textContent = '等待房主判定…';
  }, 700);
}
let judgeHint = 0;

// ---------- 回放与结果 ----------
let rollGen = 0;
async function playRoll(roll) {
  const gen = ++rollGen;
  animating = true;
  pendingState = null;
  clearTimeout(judgeHint);
  $('toast').hidden = true;
  // 本机刚松手、预演悬停在碗上方：从预演停下的那一刻接上权威轨迹，速率由慢到快；
  // 观战者从最后看到的摇骰画面接上。必须确认这一掷确实是自己的（投掷请求可能被房主丢弃）
  const clock = stage.preludeClock();
  const mine = !!awaiting && !!clock && roll.mode === 'init' && (session?.mode === 'local' || roll.outcome.playerId === session?.meId);
  const opts = mine
    ? { startAt: Math.min(roll.duration, clock.t), rate0: clock.rate, ramp: 300, blend: 150 }
    : roll.mode === 'init'
      ? { blend: 200 }
      : { lead: PICKUP_MS, blend: PICKUP_MS, arc: true };
  clearTimeout(awaiting?.timer);
  awaiting = null;
  hand.stop();
  if (roll.before) render(roll.before);
  $('btn-throw').disabled = true;
  $('throw-hint').hidden = true;
  const cur = roll.before?.players.find((p) => p.id === roll.outcome.playerId);
  $('turn-banner').textContent = `${cur?.name ?? ''} 掷骰中…`;
  $('turn-banner').classList.remove('mine');
  if (roll.mode !== 'init') playShake();
  // 投掷时镜头站在投掷者身后（本机已在该机位则不动）
  const throwerAz = roll.before ? seatAz(roll.before, roll.outcome.playerId) : stage.cam.az;
  stage.setShot({ kind: 'seat', az: throwerAz }, 900);
  await stage.playRoll(roll, (ev) => playImpact(ev.k, ev.s), opts);
  // 回放中又来了下一掷（网络慢的一端可能收到重叠的结果）：旧的收尾交给新的
  if (gen !== rollGen) return;
  // 骰子停稳：推近俯看点数
  stage.setShot({ kind: 'result', az: throwerAz }, 1000);
  const info = describe(roll.outcome, roll.outMask);
  showToast(info, 2000);
  if (info.level >= 0) playChime(info.level);
  else playFail();
  if (info.level === 2) confetti();
  await wait(2000);
  if (gen !== rollGen) return;
  animating = false;
  render(pendingState || roll.after);
  pendingState = null;
}

/** 观战：他人正在摇骰 */
function onHold(h) {
  if (animating || hand.active) return;
  stage.pushHold(h.frame);
  for (const [k, s] of h.sounds) setTimeout(() => playImpact(k, s), Math.random() * HOLD_SEND_MS);
  const cur = view?.players[view.turn];
  if (cur) {
    $('turn-banner').textContent = `${cur.name} 正在摇骰…`;
    $('turn-banner').classList.remove('mine');
  }
}

function describe(o, outMask) {
  const who = o.name;
  const r = o.result;
  const a = o.award;
  const dice = diceRow(o.dice, outMask);
  switch (a.type) {
    case 'void':
      return { who, main: '出碗了', sub: '骰子掉出碗外，本轮作废', cls: 'dim', dice, level: -1 };
    case 'none':
      return { who, main: '没中', sub: '下次好运', cls: 'dim', dice, level: -1 };
    case 'prize':
      return { who, main: r.name, sub: `得一个${r.name}饼（${PRIZE_BY_ID[r.prize].alias}）`, dice, level: r.prize === 'duitang' || r.prize === 'sanhong' ? 1 : 0 };
    case 'exhausted':
      return { who, main: r.name, sub: `${r.name}饼已博完，可惜`, cls: 'dim', dice, level: -1 };
    case 'zy-new':
      return { who, main: r.name, sub: '夺得状元！', cls: 'big', dice, level: 2 };
    case 'zy-steal':
      return { who, main: r.name, sub: `从 ${a.from} 手中抢走状元！`, cls: 'big', dice, level: 2 };
    case 'zy-self':
      return { who, main: r.name, sub: '状元仍在你手中', cls: 'big', dice, level: 1 };
    case 'zy-keep':
      return { who, main: r.name, sub: `没能大过 ${a.holder} 的状元`, dice, level: 0 };
    default:
      return { who, main: '', sub: '', dice, level: -1 };
  }
}

let toastTimer = null;
function showToast(info, ms) {
  const t = $('toast');
  t.className = `toast ${info.cls || ''}`;
  t.innerHTML = `${info.who ? `<div class="t-who">${esc(info.who)}</div>` : ''}${info.main ? `<div class="t-main">${esc(info.main)}</div>` : ''}
    <div class="t-sub">${esc(info.sub)}</div>${info.dice || ''}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.hidden = true;
    updateThrowButton();
  }, ms);
}

function confetti() {
  const box = $('confetti');
  const colors = ['#f6d98a', '#e7b75a', '#e63b2e', '#fff3c9', '#ff8a3d'];
  for (let i = 0; i < 70; i++) {
    const el = document.createElement('i');
    el.style.left = `${Math.random() * 100}%`;
    el.style.background = colors[i % colors.length];
    el.style.setProperty('--dx', `${(Math.random() - 0.5) * 200}px`);
    el.style.setProperty('--r', `${Math.random() * 900 - 450}deg`);
    el.style.animationDuration = `${1.8 + Math.random() * 1.6}s`;
    el.style.animationDelay = `${Math.random() * 0.4}s`;
    box.appendChild(el);
  }
  setTimeout(() => (box.innerHTML = ''), 4000);
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------- 结算与规则 ----------
function showEnd(st) {
  const ranked = [...st.players].sort((a, b) => (b.id === st.zy?.playerId) - (a.id === st.zy?.playerId) || score(b) - score(a));
  $('end-zy').innerHTML = st.zy ? `状元：<b>${esc(st.zy.name)}</b>（${esc(st.zy.label)}）${diceRow(st.zy.dice)}` : '';
  $('end-rank').innerHTML = ranked
    .map((p, i) => `<tr><td>${i + 1}</td><td>${esc(p.name)}</td><td>${wonText(p)}</td><td>${score(p)}</td></tr>`)
    .join('');
  const host = session?.isHost;
  $('btn-rematch').hidden = !host;
  $('end-wait').hidden = host;
  $('dlg-end').showModal();
}

function setupDialogs() {
  document.addEventListener('click', (e) => {
    const id = e.target.closest('[data-open]')?.dataset.open;
    if (id) $(id).showModal();
  });
  $('btn-end-home').onclick = () => leave();
  $('btn-end-close').onclick = () => $('dlg-end').close();
  $('btn-rematch').onclick = () => {
    $('dlg-end').close();
    session?.rematch();
  };
  $('rules-body').innerHTML = `
    <h3>怎么玩</h3>
    <ol>
      <li>电脑上：轮到你时，在碗上按住鼠标抓起骰子，拖动摇一摇（骰子在掌心里真的会碰撞），再顺势一甩松手。也可以点“一键掷骰”或按空格。</li>
      <li>手机上：点“一键掷骰”；或开启“体感摇骰”，轮到你时直接晃手机，骰子在掌心里翻滚，停下来就掷出，不用按住屏幕。</li>
      <li>甩得越猛骰子越乱，也越容易蹦出碗外；在碗外松手会直接落到桌上。有骰子掉出碗外，本轮作废。</li>
      <li>状元可被更大的状元抢走；其余奖项博到即得。</li>
      <li>同时满足多个奖项，按最高奖项算；奖品拿完即止，最后的状元带走状元饼。</li>
    </ol>
    <h3>奖项从小到大</h3>
    <table class="prize-table">${[...PRIZES].reverse().map((p) => `<tr><td>${p.name}</td><td>${p.desc}</td><td>${p.count} 个</td></tr>`).join('')}</table>
    <h3>状元等级（从小到大）</h3>
    <table class="prize-table">${ZY_LEVELS.map((l) => `<tr><td>${l.name}</td><td>${l.desc}</td></tr>`).join('')}</table>
    <p class="hint">各地博饼的状元细则略有差异，这里按“博饼一图流”：六杯红全场最大，其次状元插金花。</p>`;
}
