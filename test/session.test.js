// 房主会话：用假的连接对象测试摇骰画面转发、手势投掷与电脑玩家（Node 下仿真走主线程）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HostSession, ClientSession } from '../js/session.js';
import { Emitter } from '../js/net.js';
import { initPhysics, encodeFrames, decodeFrames, PhysWorld, mulberry32, HAND, STRIDE } from '../js/physics.js';

await initPhysics();

const KA = 'key-of-a-0123456789';
const KB = 'key-of-b-0123456789';

function fakeConn() {
  const h = {};
  return {
    open: true,
    sent: [],
    on(ev, fn) {
      h[ev] = fn;
    },
    send(m) {
      this.sent.push(structuredClone(m));
    },
    close() {
      this.open = false;
      h.close?.();
    },
    recv(m) {
      h.data(m);
    },
    of(type) {
      return this.sent.filter((m) => m.type === type);
    },
  };
}

function releaseState() {
  const pw = new PhysWorld();
  pw.fillHand({ x: 1, y: HAND.y, z: 1 }, mulberry32(4));
  for (let i = 0; i < 60; i++) {
    pw.moveHand({ x: 1 + Math.sin(i / 8) * 2, y: HAND.y, z: 1 });
    pw.step(1 / 240);
  }
  pw.release({ x: -30, y: 0, z: 10 });
  const s = pw.getState();
  pw.free();
  return s;
}

async function until(fn, ms = 8000) {
  const t = Date.now();
  while (!fn()) {
    if (Date.now() - t > ms) throw new Error('等待超时');
    await new Promise((r) => setTimeout(r, 20));
  }
}

function setup() {
  const host = new HostSession({ mode: 'host', me: { id: 'h', name: '房主' } });
  const a = fakeConn();
  const b = fakeConn();
  host.onConn(a);
  host.onConn(b);
  a.recv({ type: 'hello', id: 'a', name: 'A', key: KA });
  b.recv({ type: 'hello', id: 'b', name: 'B', key: KB });
  host.start();
  host.game.state.turn = host.game.players.findIndex((p) => p.id === 'a');
  return { host, a, b };
}

test('只转发当前玩家的摇骰画面，且不回发给本人', () => {
  const { host, a, b } = setup();
  const emitted = [];
  host.on('hold', (x) => emitted.push(x));
  const frame = new Float32Array(STRIDE).fill(0.5);
  a.recv({ type: 'hold', f: encodeFrames(frame), s: [[3, 0.6], [9, 1], 'x'] });
  assert.equal(b.of('hold').length, 1);
  assert.equal(a.of('hold').length, 0);
  assert.deepEqual(b.of('hold')[0].s, [[3, 0.6]], '非法声音事件被过滤');
  assert.equal(decodeFrames(b.of('hold')[0].f).length, STRIDE);
  assert.equal(emitted.length, 1);
  // 不是自己的回合：忽略
  b.recv({ type: 'hold', f: encodeFrames(frame), s: [] });
  assert.equal(a.of('hold').length, 0);
  // 长度不对：忽略
  a.recv({ type: 'hold', f: encodeFrames(new Float32Array(14)), s: [] });
  assert.equal(b.of('hold').length, 1);
  host.close();
});

test('手势投掷：房主权威仿真并广播，结算后换人；忙碌时下一位的投掷排队', async () => {
  const { host, a, b } = setup();
  a.recv({ type: 'throw', init: releaseState() });
  await until(() => b.of('roll').length === 1);
  const roll = b.of('roll')[0];
  assert.equal(roll.mode, 'init');
  assert.equal(roll.holdFrames, 0);
  assert.equal(decodeFrames(roll.frames).length, roll.frameCount * STRIDE);
  assert.equal(roll.outcome.playerId, 'a');
  assert.equal(a.of('roll').length, 1, '投掷者也收到权威结果');
  const next = roll.after.players[roll.after.turn].id;
  assert.notEqual(next, 'a');
  // 回放期间下一位已经出手：先排队
  if (next === 'b') {
    b.recv({ type: 'throw', power: 0.3 });
    assert.equal(host.queued?.playerId, 'b');
  }
  // 不是自己回合的投掷被忽略
  a.recv({ type: 'throw', power: 0.5 });
  assert.notEqual(host.queued?.playerId, 'a');
  host.close();
});

test('非法投掷数据不会结算，并恢复可投掷', async () => {
  const { host, a } = setup();
  const warns = [];
  host.on('warn', (w) => warns.push(w));
  a.recv({ type: 'throw', init: [1, 2, 3] });
  await until(() => warns.length === 1);
  assert.match(warns[0], /投掷失败/);
  assert.equal(host.busy, false);
  assert.equal(host.game.currentPlayer().id, 'a');
  host.close();
});

test('电脑玩家：自动完成抓起—摇—甩，带手部轨迹', async () => {
  const host = new HostSession({ mode: 'local', me: { id: 'h', name: '我' } });
  const rolls = [];
  host.on('roll', (r) => rolls.push(r));
  host.addBot();
  host.start();
  host.game.state.turn = 1;
  host.scheduleBot();
  await until(() => rolls.length === 1);
  assert.equal(rolls[0].mode, 'script');
  assert.ok(rolls[0].holdFrames > 30);
  assert.equal(rolls[0].frames.length, rolls[0].frameCount * STRIDE);
  host.close();
});

test('客人意外断线：保留座位，重连后不打扰对局；主动离开立即下线', () => {
  const { host, a } = setup();
  const logs = () => host.game.state.log.map((l) => l.text).join('|');
  a.close();
  const pa = host.game.players.find((p) => p.id === 'a');
  assert.equal(pa.online, true, '断线后座位先保留');
  assert.equal(host.game.currentPlayer().id, 'a', '不跳过其回合');
  const a2 = fakeConn();
  host.onConn(a2);
  a2.recv({ type: 'hello', id: 'a', name: 'A', key: KA });
  assert.equal(a2.of('welcome').length, 1);
  assert.equal(host.grace.size, 0, '重连后取消下线计时');
  assert.doesNotMatch(logs(), /A 离开了|A 回到了牌桌/);
  a2.recv({ type: 'leave' });
  assert.equal(pa.online, false, '主动离开立即下线');
  assert.match(logs(), /A 离开了/);
  host.close();
});

test('心跳带版本号；客人要同步时房主回最新状态；房主从后台醒来不误判客人掉线', () => {
  const { host, a } = setup();
  a.recv({ type: 'ping' });
  assert.equal(a.of('pong').at(-1).rev, host.rev);
  a.recv({ type: 'sync' });
  assert.equal(a.of('state').at(-1).rev, host.rev);
  // 模拟房主锁屏 60 秒：lastSeen 很旧，但 lastTick 更旧
  for (const e of host.conns.values()) e.lastSeen = Date.now() - 60000;
  host.lastTick = Date.now() - 60000;
  host.checkPresence();
  assert.equal(a.open, true, '不应踢掉客人');
  assert.ok(a.of('ping').length >= 1);
  // 真正失联（房主一直醒着）才断开
  for (const e of host.conns.values()) e.lastSeen = Date.now() - 60000;
  host.checkPresence();
  assert.equal(a.open, false);
  host.close();
});

test('冒用身份：别人的 id（对局状态里可见）配错的密钥、房主或电脑的 id，都不能入座', () => {
  const { host, a } = setup();
  host.addBot();
  const bot = host.game.players.find((p) => p.isBot).id;
  for (const [id, key] of [['a', 'wrong-key-0123456789'], ['h', 'any-key-0123456789ab'], [bot, 'any-key-0123456789ab'], ['c', 'short']]) {
    const evil = fakeConn();
    host.onConn(evil);
    evil.recv({ type: 'hello', id, name: '内鬼', key });
    assert.equal(evil.of('denied').length, 1, `${id} 被拒绝`);
    assert.equal(evil.of('welcome').length, 0);
  }
  assert.equal(host.conns.get('a').conn, a, '原来的 A 没被顶掉');
  assert.equal(a.open, true);
  // 同一连接重复发入座请求（前一个欢迎丢了）：再回一次欢迎，不刷日志
  const logs = host.game.state.log.length;
  a.recv({ type: 'hello', id: 'a', name: 'A', key: KA });
  assert.equal(a.of('welcome').length, 2);
  assert.equal(host.game.state.log.length, logs);
  host.close();
});

test('客人：入座请求丢了会重发，直到收到欢迎', async () => {
  const link = new Emitter();
  link.open = true;
  link.kind = 'relay';
  link.sent = [];
  link.close = () => (link.open = false);
  let hellos = 0;
  link.send = (m) => {
    link.sent.push(m);
    // 前两次入座请求"丢了"
    if (m.type === 'hello' && ++hellos === 3) setTimeout(() => link.emit('data', { type: 'welcome', rev: 1, state: { phase: 'lobby', players: [], turn: 0 } }));
  };
  const c = new ClientSession({ me: { id: 'g', name: '客', key: KA }, code: 'ABCDEFGHJK', join: async () => link });
  await c.open();
  assert.equal(c.status, 'online');
  assert.equal(hellos, 3);
  assert.equal(link.sent[0].key, KA, '入座请求带着本人密钥');
  c.close(false);
});
