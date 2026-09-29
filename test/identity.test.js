// 客人身份：同一浏览器重进同一房间沿用原身份；同时开两个标签页不共用
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seatIdentity } from '../js/identity.js';

function mem() {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)) };
}

// 简化的 Web Locks：ifAvailable 时拿不到就回调 null
function fakeLocks() {
  const held = new Set();
  return {
    held,
    async request(name, opts, fn) {
      if (held.has(name)) return fn(null);
      held.add(name);
      try {
        return await fn({ name });
      } finally {
        held.delete(name);
      }
    },
  };
}

const CODE = 'ABCDEFGHJK';

test('关掉标签页再打开（新的 sessionStorage）：回到原来的身份', async () => {
  const local = mem(), locks = fakeLocks();
  const a = await seatIdentity(CODE, { local, session: mem(), locks });
  a.release();
  await Promise.resolve();
  const b = await seatIdentity(CODE, { local, session: mem(), locks });
  assert.equal(b.id, a.id);
  assert.equal(b.key, a.key);
  b.release();
});

test('刷新（同一 sessionStorage）：还是同一身份', async () => {
  const local = mem(), session = mem(), locks = fakeLocks();
  const a = await seatIdentity(CODE, { local, session, locks });
  a.release();
  await Promise.resolve();
  const b = await seatIdentity(CODE, { local, session, locks });
  assert.equal(b.id, a.id);
  b.release();
});

test('同时开两个标签页进同一房间：第二个用新身份，且不覆盖浏览器记住的原身份', async () => {
  const local = mem(), locks = fakeLocks();
  const a = await seatIdentity(CODE, { local, session: mem(), locks });
  const b = await seatIdentity(CODE, { local, session: mem(), locks });
  assert.notEqual(b.id, a.id);
  assert.ok(b.key.length >= 16);
  a.release();
  b.release();
  await Promise.resolve();
  const c = await seatIdentity(CODE, { local, session: mem(), locks });
  assert.equal(c.id, a.id, '之后再开，回到原身份');
  c.release();
});

test('不同房间各用各的身份；过期的记录会被清掉；存储不可用时照样给出身份', async () => {
  const local = mem(), locks = fakeLocks();
  const a = await seatIdentity(CODE, { local, session: mem(), locks, now: 1000 });
  const b = await seatIdentity('ZZZZZZZZZZ', { local, session: mem(), locks, now: 1000 });
  assert.notEqual(a.id, b.id);
  a.release();
  b.release();
  await Promise.resolve();
  const later = 1000 + 4 * 24 * 3600 * 1000;
  const c = await seatIdentity(CODE, { local, session: mem(), locks, now: later });
  assert.notEqual(c.id, a.id, '3 天前的身份不再沿用');
  c.release();
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  const d = await seatIdentity(CODE, { local: broken, session: broken, locks: fakeLocks() });
  assert.ok(d.id && d.key.length >= 16);
  d.release();
});

test('浏览器不支持 Web Locks：两个标签页不共用身份（否则后开的会把先开的顶下线），刷新仍能回来', async () => {
  const local = mem();
  const tab1 = mem();
  // null = 没有 navigator.locks（undefined 会触发参数默认值，用上真实的 navigator.locks）
  const broken = [
    null,
    { request: () => Promise.reject(new Error('SecurityError')) },
    {
      request() {
        throw new Error('SecurityError');
      },
    },
  ];
  for (const locks of broken) {
    const a = await seatIdentity(CODE, { local, session: tab1, locks });
    const b = await seatIdentity(CODE, { local, session: mem(), locks });
    assert.notEqual(a.id, b.id);
    const again = await seatIdentity(CODE, { local, session: tab1, locks });
    assert.equal(again.id, a.id, '同一标签页刷新沿用');
  }
});
