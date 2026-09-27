// 摇骰手感指标：模拟指针左右摇晃，统计掌心里骰子的翻面次数与平均角速度
// 用法：node scripts/shake-metric.mjs    环境变量 HANDCFG='{"apothem":5.5}' 覆盖 HAND 参数
import { initPhysics, HAND, topFace } from '../js/physics.js';
import { HandController } from '../js/hand.js';

await initPhysics();
Object.assign(HAND, process.env.HANDCFG ? JSON.parse(process.env.HANDCFG) : {});

function run(amp, freq, secs = 1.5) {
  const h = new HandController();
  h.grab({ x: 2, z: 0 });
  const dt = 1 / 60;
  let flips = 0, prev = null, wsum = 0, n = 0;
  for (let t = 0; t < secs; t += dt) {
    h.setTarget({ x: 2 + amp * Math.sin(2 * Math.PI * freq * t), z: 0.3 * amp * Math.cos(2 * Math.PI * freq * 0.7 * t) });
    h.update(dt);
    const tops = h.pw.dice.map((b) => topFace(b.rotation()).value);
    if (prev) tops.forEach((v, i) => v !== prev[i] && flips++);
    prev = tops;
    for (const b of h.pw.dice) {
      const w = b.angvel();
      wsum += Math.hypot(w.x, w.y, w.z);
      n++;
    }
  }
  h.stop();
  return { flips: flips / 6 / secs, w: wsum / n };
}

console.log('HAND', JSON.stringify(HAND));
for (const [amp, freq] of [[1.5, 3], [3, 4], [4, 5]]) {
  let f = 0, w = 0;
  const R = 6;
  for (let i = 0; i < R; i++) {
    const r = run(amp, freq);
    f += r.flips;
    w += r.w;
  }
  console.log(`摇幅 ${amp}cm ${freq}Hz：每颗骰子每秒翻面 ${(f / R).toFixed(2)} 次，平均角速度 ${(w / R).toFixed(1)} rad/s`);
}
