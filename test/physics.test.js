import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initPhysics, simulateThrow, encodeFrames, decodeFrames, topFace, quatForValue, sanitizeInit, PhysWorld, mulberry32, FACE_VALUES, STRIDE, HAND } from '../js/physics.js';

await initPhysics();

function lastDice(r) {
  const last = r.frames.subarray((r.frameCount - 1) * STRIDE);
  return [0, 1, 2, 3, 4, 5].map((i) => topFace({ x: last[i * 7 + 3], y: last[i * 7 + 4], z: last[i * 7 + 5], w: last[i * 7 + 6] }).value);
}

/** 模拟客户端：在掌心里摇一会儿再松手，返回松手状态 */
function shakeAndRelease(seed, vel) {
  const pw = new PhysWorld();
  const start = { x: 2, y: HAND.y, z: -1 };
  pw.fillHand(start, mulberry32(seed));
  for (let i = 1; i <= 120; i++) {
    const p = { x: 2 + Math.sin((i / 120) * Math.PI * 6) * 2, y: HAND.y, z: -1 };
    pw.handVel = { x: 0, y: 0, z: 0 };
    pw.moveHand(p);
    pw.step(1 / 240);
    pw.contain();
  }
  pw.release(vel);
  const s = pw.getState();
  pw.free();
  return s;
}

test('一键掷骰：同一种子可复现，含摇骰阶段且骰子不会穿出掌心', () => {
  const a = simulateThrow({ power: 0.5, seed: 42, seat: 1, seats: 8 });
  const b = simulateThrow({ power: 0.5, seed: 42, seat: 1, seats: 8 });
  assert.deepEqual(a.dice, b.dice);
  assert.equal(a.frames.length, a.frameCount * STRIDE);
  assert.ok(a.holdFrames > 30, `holdFrames=${a.holdFrames}`);
  for (let f = 0; f < a.holdFrames; f++) {
    const o = f * STRIDE;
    for (let d = 0; d < 6; d++) {
      const dx = a.frames[o + d * 7] - a.frames[o + 42];
      const dz = a.frames[o + d * 7 + 2] - a.frames[o + 44];
      assert.ok(Math.hypot(dx, dz) < HAND.apothem + 0.5, `frame ${f} die ${d} 在掌心外`);
    }
  }
  assert.ok(a.sounds.some((s) => s.k === 3), '摇骰时应有骰子碰手的声音');
  assert.deepEqual(lastDice(a), a.dice);
});

test('手势松手：权威仿真接受状态并停稳', () => {
  const init = shakeAndRelease(3, { x: -40, y: 0, z: 20 });
  const r = simulateThrow({ init, seed: 11 });
  assert.equal(r.holdFrames, 0);
  assert.ok(r.duration > 0.3 && r.duration < 9.2);
  assert.deepEqual(lastDice(r), r.dice);
  // 首帧即松手瞬间：与客户端状态基本一致
  for (let d = 0; d < 6; d++) assert.ok(Math.abs(r.frames[d * 7] - init[d * 13]) < 0.01);
});

test('轻轻松手不会出碗', () => {
  for (let s = 0; s < 12; s++) assert.equal(simulateThrow({ init: shakeAndRelease(100 + s, { x: 0, y: 0, z: 0 }), seed: s }).out, false);
});

test('清洗客户端状态：拒绝非法数据，钳制越界值', () => {
  assert.equal(sanitizeInit([1, 2, 3]), null);
  assert.equal(sanitizeInit(new Array(78).fill(NaN)), null);
  const bad = new Array(78).fill(0);
  for (let i = 0; i < 6; i++) {
    bad[i * 13] = 500; // 远在桌外
    bad[i * 13 + 1] = 0.1; // 贴着碗底，企图直接摆好点数
    bad[i * 13 + 6] = 1;
    bad[i * 13 + 7] = 9999; // 超速
  }
  const s = sanitizeInit(bad, () => 0.5);
  for (let i = 0; i < 6; i++) {
    const o = i * 13;
    assert.ok(Math.hypot(s[o], s[o + 2]) <= HAND.reach + HAND.apothem + 1e-6);
    assert.ok(s[o + 1] >= HAND.y - 1);
    assert.ok(Math.hypot(s[o + 7], s[o + 8], s[o + 9]) <= 451);
  }
});

test('轨迹编码往返误差很小', () => {
  const r = simulateThrow({ power: 0.5, seed: 3 });
  const back = decodeFrames(encodeFrames(r.frames));
  assert.equal(back.length, r.frames.length);
  let maxErr = 0;
  for (let i = 0; i < back.length; i++) maxErr = Math.max(maxErr, Math.abs(back[i] - r.frames[i]));
  assert.ok(maxErr < 0.01, `maxErr=${maxErr}`);
});

test('读点数：各面朝上，quatForValue 与 topFace 一致', () => {
  const s = Math.SQRT1_2;
  assert.equal(topFace({ x: 0, y: 0, z: s, w: s }).value, FACE_VALUES[0]);
  assert.equal(topFace({ x: 0, y: 0, z: 0, w: 1 }).value, FACE_VALUES[2]);
  assert.equal(topFace({ x: -s, y: 0, z: 0, w: s }).value, FACE_VALUES[4]);
  for (let v = 1; v <= 6; v++) {
    for (const yaw of [0, 1.1, 2.7]) {
      const t = topFace(quatForValue(v, yaw));
      assert.equal(t.value, v);
      assert.ok(t.align > 0.999);
    }
  }
});
