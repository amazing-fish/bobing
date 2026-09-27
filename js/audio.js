// WebAudio 合成音效：瓷碗清脆的叮当声、骰子互碰、落桌闷响、中奖提示
let ctx = null;
let master = null;
let noiseBuf = null;
let muted = false;
let lastAt = 0;
let burst = 0;

export function unlockAudio() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.8;
    master.connect(ctx.destination);
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 0.5, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  if (ctx.state === 'suspended') ctx.resume();
}

export function setMuted(m) {
  muted = m;
  if (master) master.gain.value = m ? 0 : 0.8;
}

export function isMuted() {
  return muted;
}

function ready() {
  return ctx && !muted && ctx.state === 'running';
}

function tone(freq, t, dur, gain, type = 'sine') {
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.value = freq;
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(gain, t + 0.002);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(master);
  o.start(t);
  o.stop(t + dur + 0.02);
}

function noise(t, dur, gain, type, freq, q = 1) {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  const g = ctx.createGain();
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f).connect(g).connect(master);
  src.start(t, Math.random() * 0.3);
  src.stop(t + dur + 0.02);
}

/** 碰撞音效；k：0 骰-骰，1 骰-碗，2 骰-桌，3 骰-手；s：0..1 强度 */
export function playImpact(k, s) {
  if (!ready()) return;
  const t = ctx.currentTime;
  // 同一时刻的碰撞过多时限流，避免爆音
  if (t - lastAt < 0.012) {
    if (++burst > 3) return;
  } else burst = 0;
  lastAt = t;
  const g = Math.min(1, 0.12 + s * 0.9);
  if (k === 1) {
    // 瓷碗：几组非谐泛音，衰减较长
    const base = 2300 + Math.random() * 900;
    tone(base, t, 0.35 + s * 0.4, 0.16 * g);
    tone(base * 1.51, t, 0.25 + s * 0.3, 0.09 * g);
    tone(base * 2.37, t, 0.15, 0.05 * g);
    noise(t, 0.03, 0.25 * g, 'highpass', 3500);
  } else if (k === 3) {
    // 骰子撞在掌心：闷一些的"咔哒"
    noise(t, 0.03, 0.28 * g, 'bandpass', 1800 + Math.random() * 900, 1.2);
    tone(900 + Math.random() * 400, t, 0.03, 0.05 * g, 'triangle');
  } else if (k === 0) {
    tone(1500 + Math.random() * 600, t, 0.05, 0.1 * g, 'triangle');
    noise(t, 0.035, 0.35 * g, 'bandpass', 3000 + Math.random() * 1500, 1.5);
  } else {
    noise(t, 0.09, 0.5 * g, 'lowpass', 700);
    tone(160 + Math.random() * 40, t, 0.08, 0.2 * g);
  }
}

/** 抓起骰子时的沙沙声 */
export function playShake() {
  if (!ready()) return;
  const t = ctx.currentTime;
  for (let i = 0; i < 5; i++) noise(t + i * 0.055, 0.04, 0.18, 'bandpass', 2600 + Math.random() * 1200, 2);
}

/** 中奖提示：level 0 普通奖，1 对堂/三红，2 状元 */
export function playChime(level) {
  if (!ready()) return;
  const t = ctx.currentTime;
  const scale = [523.25, 587.33, 659.25, 783.99, 880, 1046.5, 1174.66, 1318.5];
  const n = level === 2 ? 8 : level === 1 ? 5 : 3;
  for (let i = 0; i < n; i++) {
    tone(scale[i], t + i * 0.07, 0.6, 0.12);
    tone(scale[i] * 2, t + i * 0.07, 0.3, 0.03);
  }
  if (level === 2) {
    // 锣声
    tone(98, t, 2.2, 0.35);
    tone(98 * 2.76, t, 1.6, 0.12);
    tone(98 * 5.4, t, 1.0, 0.05);
    noise(t, 0.4, 0.2, 'lowpass', 1200);
  }
}

/** 骰子掉出碗外 / 没中 */
export function playFail() {
  if (!ready()) return;
  const t = ctx.currentTime;
  tone(330, t, 0.25, 0.1, 'triangle');
  tone(247, t + 0.12, 0.35, 0.1, 'triangle');
}
