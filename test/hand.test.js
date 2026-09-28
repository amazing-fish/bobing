import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initPhysics, HAND, topFace, simulateThrow, STRIDE } from '../js/physics.js';
import { HandController } from '../js/hand.js';

await initPhysics();

function shake(h, secs, fn) {
  const dt = 1 / 60;
  let flips = 0, prev = null;
  for (let t = 0; t < secs; t += dt) {
    fn(t);
    h.update(dt);
    const tops = h.pw.dice.map((b) => topFace(b.rotation()).value);
    if (prev) tops.forEach((v, i) => v !== prev[i] && flips++);
    prev = tops;
    for (const b of h.pw.dice) {
      const p = b.translation();
      assert.ok(Math.hypot(p.x - h.pos.x, p.z - h.pos.z) < HAND.apothem + 1, '骰子不应离开掌心');
    }
  }
  return flips / 6 / secs;
}

test('拖动摇骰：骰子在掌心里翻面', () => {
  const h = new HandController();
  h.grab({ x: 0, z: 0 });
  const rate = shake(h, 1.5, (t) => h.setTarget({ x: 4 * Math.sin(2 * Math.PI * 5 * t), z: 0 }));
  assert.ok(rate > 1.5, `每颗骰子每秒翻面 ${rate.toFixed(2)} 次`);
  const { init, pre } = h.release();
  assert.equal(init.length, 78);
  assert.equal(h.mode, 'idle', '松手后本机不再继续仿真');
  assert.ok(pre.holdAt > 0 && pre.holdAt <= 0.6, `悬停于 ${pre.holdAt}s`);
  assert.ok(pre.frames.length / STRIDE >= Math.floor(pre.holdAt * pre.fps) + 1);
});

test('松手预演只到碰碗之前：与房主权威轨迹（带防作弊扰动）在这一段几乎重合', () => {
  let worst = 0;
  for (let n = 0; n < 12; n++) {
    const h = new HandController();
    h.grab({ x: (n % 3) - 1, z: 0 });
    const dir = n * 0.7;
    for (let t = 0; t < 1; t += 1 / 60) {
      h.setTarget({ x: Math.cos(dir) * 5 * Math.sin(t * 20), z: Math.sin(dir) * 5 * Math.sin(t * 20) });
      h.update(1 / 60);
    }
    const { init, pre } = h.release({ x: -40 - n * 8, z: 10 });
    const sim = simulateThrow({ init: init.map((v) => Math.round(v * 1000) / 1000) });
    const fi = Math.floor(pre.holdAt * pre.fps);
    const L = pre.frames.subarray(fi * STRIDE), A = sim.frames.subarray(fi * STRIDE);
    for (let d = 0; d < 6; d++) {
      const o = d * 7;
      worst = Math.max(worst, Math.hypot(L[o] - A[o], L[o + 1] - A[o + 1], L[o + 2] - A[o + 2]));
    }
  }
  // 碰碗之后几十毫秒内偏差就到厘米级、点数完全不同（scripts/diag-drift.mjs），所以只能预演到这里
  assert.ok(worst < 0.8, `悬停时刻与权威轨迹的最大位置偏差 ${worst.toFixed(2)} cm`);
});

test('手机体感：外加加速度也能摇动掌心与骰子', () => {
  const h = new HandController();
  h.grab({ x: 0, z: 0 });
  let maxDx = 0;
  const rate = shake(h, 1.5, (t) => {
    // 手机左右晃，约 4Hz、峰值 15 m/s²（×250 → cm/s²）
    h.setExternal({ x: 15 * 250 * Math.sin(2 * Math.PI * 4 * t), y: 0, z: 0 });
    maxDx = Math.max(maxDx, Math.abs(h.pos.x));
  });
  assert.ok(maxDx > 1 && maxDx < 8, `掌心摆幅 ${maxDx.toFixed(2)} cm`);
  assert.ok(rate > 0.5, `每颗骰子每秒翻面 ${rate.toFixed(2)} 次`);
  h.stop();
});
