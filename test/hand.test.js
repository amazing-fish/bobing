import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initPhysics, HAND, topFace } from '../js/physics.js';
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
  const init = h.release();
  assert.equal(init.length, 78);
  assert.equal(h.mode, 'predict');
  h.stop();
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
