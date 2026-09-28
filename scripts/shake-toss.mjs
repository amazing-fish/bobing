// 体感摇骰校准：掌心停在碗心上方，按手机晃动的加速度摇 1~2 秒，停下后带轻抛松手，
// 再交给房主的权威仿真，统计出碗率与点数分布。用法：node scripts/shake-toss.mjs [次数]
import { initPhysics, simulateThrow, sanitizeInit } from '../js/physics.js';
import { HandController } from '../js/hand.js';

await initPhysics();
const N = Number(process.argv[2] || 200);
const SHAKE_START = 6;
const counts = [0, 0, 0, 0, 0, 0, 0];
let voids = 0;
for (let i = 0; i < N; i++) {
  const h = new HandController();
  h.grab({ x: 0, z: 0 });
  const peak = 8 + Math.random() * 14; // 手机晃动峰值 m/s²
  const f = 3 + Math.random() * 3;
  const secs = 0.8 + Math.random() * 1.2;
  const dir = Math.random() * Math.PI * 2;
  const dt = 1 / 60;
  for (let t = 0; t < secs + 0.4; t += dt) {
    const a = t < secs ? peak * Math.sin(2 * Math.PI * f * t) * 250 : 0;
    h.setExternal({ x: Math.cos(dir) * a, y: 0, z: Math.sin(dir) * a });
    h.update(dt);
  }
  const k = Math.min(1, Math.max(0, (peak * 0.64 - SHAKE_START) / 12));
  const az = Math.random() * Math.PI * 2;
  const sp = 45 + 45 * k;
  const init = h.release({ x: -Math.cos(az) * sp, z: -Math.sin(az) * sp });
  h.stop();
  const sim = simulateThrow({ init: sanitizeInit(init) });
  if (sim.out) voids++;
  else for (const v of sim.dice) counts[v]++;
}
const total = counts.reduce((a, b) => a + b, 0);
const exp = total / 6;
const chi = counts.slice(1).reduce((a, c) => a + (c - exp) ** 2 / exp, 0);
console.log(`出碗率 ${((voids / N) * 100).toFixed(1)}%  点数 1..6 = ${counts.slice(1).join(' ')}  χ²=${chi.toFixed(2)}（5 自由度，p=0.05 临界 11.07）`);
process.exit(0);
