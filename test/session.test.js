// 房主会话：用假的连接对象测试摇骰画面转发、手势投掷与电脑玩家（Node 下仿真走主线程）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HostSession } from '../js/session.js';
import { initPhysics, encodeFrames, decodeFrames, PhysWorld, mulberry32, HAND, STRIDE } from '../js/physics.js';

await initPhysics();

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
  a.recv({ type: 'hello', id: 'a', name: 'A' });
  b.recv({ type: 'hello', id: 'b', name: 'B' });
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
