// 体感摇骰校准：掌心从碗心附近随机一点起手，按手机晃动的加速度摇 1~2 秒，
// 然后"甩出"（力度随甩的猛烈程度）或"停下轻抛"，交给房主的权威仿真，统计出碗率与点数分布。
// 参数与 main.js 的 shakeToss 保持一致。用法：node scripts/shake-toss.mjs [次数]
import { initPhysics, simulateThrow } from '../js/physics.js';
import { HandController } from '../js/hand.js';

await initPhysics();
const N = Number(process.argv[2] || 200);
const SHAKE_START = 6;
const FLICK_MIN = 20;

function toss(how, strength) {
  const flick = how !== 'calm';
  const k = flick ? Math.min(1, Math.max(0, (strength - FLICK_MIN) / 25)) : Math.min(1, Math.max(0, (strength - SHAKE_START) / 12));
  const sp = flick ? 25 + 55 * k : 35 + 40 * k;
  const az = Math.random() * Math.PI * 2;
  const j = 0.85 + Math.random() * 0.3;
  return { x: -Math.cos(az) * sp * j, z: -Math.sin(az) * sp * j };
}

function run(how, strength) {
  const h = new HandController();
  const a0 = Math.random() * Math.PI * 2, r0 = 5 * Math.sqrt(Math.random());
  h.grab({ x: Math.cos(a0) * r0, z: Math.sin(a0) * r0 });
  const peak = 8 + Math.random() * 14; // 手机晃动峰值 m/s²
  const f = 3 + Math.random() * 3;
  const secs = 0.8 + Math.random() * 1.2;
  const dir = Math.random() * Math.PI * 2;
  const dt = 1 / 60;
  // 甩出发生在摇动途中，停下则多等一会儿
  const end = how === 'calm' ? secs + 0.3 : secs;
  for (let t = 0; t < end; t += dt) {
    const a = t < secs ? peak * Math.sin(2 * Math.PI * f * t) * 250 : 0;
    h.setExternal({ x: Math.cos(dir) * a, y: 0, z: Math.sin(dir) * a });
    h.update(dt);
  }
  const { init } = h.release(toss(how, strength ?? peak * 0.64));
  return simulateThrow({ init });
}

const cases = [
  ['停下轻抛', 'calm', null],
  ['轻甩 22', 'flick', 22],
  ['中甩 32', 'flick', 32],
  ['猛甩 45', 'flick', 45],
];
for (const [name, how, s] of cases) {
  const counts = [0, 0, 0, 0, 0, 0, 0];
  let voids = 0;
  for (let i = 0; i < N; i++) {
    const sim = run(how, s);
    if (sim.out) voids++;
    else for (const v of sim.dice) counts[v]++;
  }
  const total = counts.reduce((a, b) => a + b, 0);
  const exp = total / 6;
  const chi = counts.slice(1).reduce((a, c) => a + (c - exp) ** 2 / exp, 0);
  console.log(`${name}: 出碗率 ${((voids / N) * 100).toFixed(1)}%  点数 1..6 = ${counts.slice(1).join(' ')}  χ²=${chi.toFixed(2)}（p=0.05 临界 11.07）`);
}
process.exit(0);
