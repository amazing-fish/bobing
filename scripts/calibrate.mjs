// 物理校准：统计不同力度下的出碗率、点数分布、平均时长与计算耗时
// 用法：node scripts/calibrate.mjs [每档次数]
//   环境变量 TUNE='{"swirlMax":80}' 覆盖参数；RANDOM_SEEDS=1 使用随机种子
import { initPhysics, simulateThrow, encodeFrames } from '../js/physics.js';

await initPhysics();
const N = Number(process.argv[2] || 200);
const tune = process.env.TUNE ? JSON.parse(process.env.TUNE) : {};
const randomSeeds = process.env.RANDOM_SEEDS === '1';
const faces = [0, 0, 0, 0, 0, 0, 0];
let totalDice = 0;
const alignHist = { '<0.8': 0, '0.8-0.9': 0, '0.9-0.97': 0, '>=0.97': 0 };

for (const power of (process.env.POWERS || '0.1,0.3,0.5,0.75,1').split(',').map(Number)) {
  let out = 0, dieOut = 0, dur = 0, maxDur = 0, cpu = 0, sounds = 0, bytes = 0, timeouts = 0;
  for (let i = 0; i < N; i++) {
    const t0 = performance.now();
    const seed = randomSeeds ? undefined : i * 7919 + Math.round(power * 1000);
    const r = simulateThrow({ power, seat: i % 6, seats: 6, seed, tune });
    cpu += performance.now() - t0;
    if (r.out) out++;
    dieOut += r.outMask.filter(Boolean).length;
    dur += r.duration;
    maxDur = Math.max(maxDur, r.duration);
    if (r.duration > 8.9) timeouts++;
    sounds += r.sounds.length;
    bytes += encodeFrames(r.frames).length;
    const a = r.minAlign;
    alignHist[a < 0.8 ? '<0.8' : a < 0.9 ? '0.8-0.9' : a < 0.97 ? '0.9-0.97' : '>=0.97']++;
    if (!r.out) for (const d of r.dice) faces[d]++, totalDice++;
  }
  console.log(
    `power ${power.toFixed(1)}: 作废率 ${((out / N) * 100).toFixed(1).padStart(5)}%  出碗骰 ${(dieOut / N).toFixed(2)}/次  ` +
      `时长 均${(dur / N).toFixed(2)}s 最长${maxDur.toFixed(2)}s 超时${timeouts}  计算 ${(cpu / N).toFixed(1)}ms  ` +
      `音效 ${(sounds / N).toFixed(1)}  轨迹 ${(bytes / N / 1024).toFixed(1)}KB`,
  );
}
const exp = totalDice / 6;
const chi = faces.slice(1).reduce((a, n) => a + (n - exp) ** 2 / exp, 0);
console.log('点数分布', faces.slice(1).map((n) => ((n / totalDice) * 100).toFixed(1) + '%').join(' '), `χ²=${chi.toFixed(2)} (df=5, 95% 临界 11.07)`);
console.log('最斜骰子对齐度分布', alignHist);
