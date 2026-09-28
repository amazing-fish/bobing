// 诊断：投掷者本机预测与房主权威轨迹（带防作弊扰动）随时间的偏差。用法：node scripts/diag-drift.mjs [次数]
import { initPhysics, simulateThrow, STRIDE, PhysWorld } from '../js/physics.js';
import { HandController } from '../js/hand.js';

await initPhysics();
const N = Number(process.argv[2] || 40);
const TS = [0.05, 0.1, 0.15, 0.2, 0.3, 0.4, 0.6];
const posErr = TS.map(() => []), angErr = TS.map(() => []);
const firstHit = [];
for (let i = 0; i < N; i++) {
  const h = new HandController();
  h.grab({ x: 0, z: 0 });
  const dir = Math.random() * Math.PI * 2;
  for (let t = 0; t < 1.2; t += 1 / 60) {
    h.setTarget({ x: Math.cos(dir) * 5 * Math.sin(t * 20), z: Math.sin(dir) * 5 * Math.sin(t * 20) });
    h.update(1 / 60);
  }
  const { init } = h.release({ x: -40 - Math.random() * 40, z: 10 });
  const sim = simulateThrow({ init: init.map((v) => Math.round(v * 1000) / 1000) });
  firstHit.push(sim.sounds.find((s) => s.k === 1 || s.k === 2)?.t ?? NaN);
  // 本机"继续预测"：同一初始状态、不带房主的扰动，逐帧推进
  const pw = new PhysWorld();
  pw.release({ x: 0, y: 0, z: 0 });
  pw.setState(init);
  const local = [];
  for (let t = 0; t < 0.7; t += 1 / 60) {
    local.push(pw.writeFrame(new Float32Array(STRIDE)));
    for (let k = 0; k < 2; k++) pw.step(pw.T.dt);
  }
  pw.free();
  TS.forEach((t, j) => {
    const fi = Math.round(t * 60);
    const L = local[fi], A = sim.frames.subarray(fi * STRIDE, fi * STRIDE + STRIDE);
    let pe = 0, ae = 0;
    for (let d = 0; d < 6; d++) {
      const o = d * 7;
      pe = Math.max(pe, Math.hypot(L[o] - A[o], L[o + 1] - A[o + 1], L[o + 2] - A[o + 2]));
      const dot = Math.abs(L[o + 3] * A[o + 3] + L[o + 4] * A[o + 4] + L[o + 5] * A[o + 5] + L[o + 6] * A[o + 6]);
      ae = Math.max(ae, (2 * Math.acos(Math.min(1, dot)) * 180) / Math.PI);
    }
    posErr[j].push(pe);
    angErr[j].push(ae);
  });
}
const med = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1];
const p90 = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length * 0.9)];
console.log('首次碰碗/桌 t: 中位', med(firstHit).toFixed(3), 's  p10', firstHit.slice().sort((a, b) => a - b)[Math.floor(N * 0.1)].toFixed(3));
TS.forEach((t, j) => console.log(`t=${t}s  位置偏差 中位 ${med(posErr[j]).toFixed(2)}cm p90 ${p90(posErr[j]).toFixed(2)}  角度 中位 ${med(angErr[j]).toFixed(1)}° p90 ${p90(angErr[j]).toFixed(1)}°`));
