// 实时摇骰：在投掷者本机运行物理，手跟随指针移动，骰子在掌心里真实碰撞。
// 松手后只预演到骰子第一次碰碗之前：碰撞是混沌的，本机与房主的仿真在碰碗后约 0.1 秒就完全分叉
// （实测 scripts/diag-drift.mjs），之后的画面必须以房主的权威轨迹为准
import { PhysWorld, HAND, STRIDE, mulberry32, tiltQuat, BOWL, KIND, RECORD_FPS } from './physics.js';

const HOLD_DT = 1 / 240;
const OMEGA = 28; // 手跟随指针的弹簧频率（临界阻尼）
const VOMEGA = 22; // 掌心上下晃动的弹簧频率
const PRE_MAX = 0.6; // 松手后最多预演多久
const PRE_MARGIN = 1 / 60; // 停在碰碗前这么久

export class HandController {
  constructor() {
    this.pw = null;
    this.mode = 'idle'; // idle | hold
    this.frame = new Float32Array(STRIDE);
    this.acc = 0;
  }

  get active() {
    return this.mode !== 'idle';
  }

  /** 抓起骰子：at 为掌心起始位置（xz），target 为指针对应位置 */
  grab(at) {
    this.stop();
    this.pw = new PhysWorld();
    const p = clampReach({ x: at.x, y: HAND.y, z: at.z });
    this.pos = { ...p };
    this.vel = { x: 0, y: 0, z: 0 };
    this.acc3 = { x: 0, z: 0 };
    this.vy = 0;
    this.baseY = HAND.y;
    this.ext = { x: 0, y: 0, z: 0 };
    this.target = { ...p };
    this.pw.fillHand(p, mulberry32((Math.random() * 2 ** 31) | 0));
    this.pw.handVel = this.vel;
    this.mode = 'hold';
    this.acc = 0;
    this.sounds = [];
    this.pw.writeFrame(this.frame);
  }

  setTarget(xz) {
    if (this.mode !== 'hold') return;
    const p = clampReach({ x: xz.x, y: HAND.y, z: xz.z });
    this.target.x = p.x;
    this.target.z = p.z;
  }

  /** 每帧调用；返回本帧新产生的碰撞声 */
  update(dtReal) {
    if (!this.pw) return [];
    const out = [];
    const onSound = (e) => out.push(e);
    this.acc = Math.min(this.acc + dtReal, 1 / 20);
    if (this.mode === 'hold') {
      while (this.acc >= HOLD_DT) {
        this.acc -= HOLD_DT;
        this.stepHand();
        this.pw.step(HOLD_DT, onSound);
        this.pw.contain();
      }
    }
    this.pw.writeFrame(this.frame);
    return out;
  }

  stepHand() {
    // 临界阻尼弹簧追随指针，速度上限 HAND.maxSpeed
    const p = this.pos, v = this.vel, t = this.target;
    const ax = OMEGA * OMEGA * (t.x - p.x) - 2 * OMEGA * v.x + this.ext.x;
    const az = OMEGA * OMEGA * (t.z - p.z) - 2 * OMEGA * v.z + this.ext.z;
    v.x += ax * HOLD_DT;
    v.z += az * HOLD_DT;
    const sp = Math.hypot(v.x, v.z);
    if (sp > HAND.maxSpeed) {
      v.x *= HAND.maxSpeed / sp;
      v.z *= HAND.maxSpeed / sp;
    }
    p.x += v.x * HOLD_DT;
    p.z += v.z * HOLD_DT;
    // 竖直方向是一根弹簧，承接手机体感的上下晃动
    const ay = VOMEGA * VOMEGA * (HAND.y - (this.baseY ?? HAND.y)) - 2 * 0.5 * VOMEGA * this.vy + this.ext.y;
    this.vy = Math.max(-120, Math.min(120, this.vy + ay * HOLD_DT));
    this.baseY = Math.max(HAND.y - 1.2, Math.min(HAND.y + 2, (this.baseY ?? HAND.y) + this.vy * HOLD_DT));
    // 换向时的加速度让掌心轻轻一抬：短促的位移冲击能把骰子掀起来（实测比弹簧式的"掂"更有效）
    const lift = Math.min(0.8, Math.hypot(ax, az) / 40000);
    p.y = this.baseY + lift;
    this.acc3.x += (ax - this.acc3.x) * 0.2;
    this.acc3.z += (az - this.acc3.z) * 0.2;
    this.pw.handVel = { x: v.x, y: this.vy, z: v.z };
    this.pw.moveHand({ ...p }, tiltQuat(this.acc3.x, this.acc3.z));
  }

  /** 手机体感：外加在手上的加速度（世界坐标，cm/s²），不再更新时调用 setExternal(null) */
  setExternal(a) {
    if (this.mode !== 'hold') return;
    this.ext = a ? { x: a.x, y: a.y, z: a.z } : { x: 0, y: 0, z: 0 };
  }

  /** 手速 0..1（用于界面上的"力度"显示） */
  speed01() {
    if (this.mode !== 'hold') return 0;
    return Math.min(1, Math.hypot(this.vel.x, this.vel.z) / HAND.maxSpeed);
  }

  /** 掌心在碗外？松手会直接落到桌上 */
  outside() {
    return Math.hypot(this.pos.x, this.pos.z) > BOWL.rimR - 1;
  }

  /**
   * 松手：返回 { init, pre }。init 是交给房主的初始状态（6 × [p,q,v,w]）；
   * pre 是本机预演的开头一段轨迹 { frames, fps, holdAt }：骰子飞出、落到碗上方，holdAt（秒）停在第一次碰碗/桌之前。
   * toss：额外的水平抛出速度（cm/s），每颗骰子略有差异
   */
  release(toss = null) {
    if (this.mode !== 'hold') return null;
    const pw = this.pw;
    pw.release({ x: this.vel.x, y: 0, z: this.vel.z });
    if (toss) {
      for (const b of pw.dice) {
        const v = b.linvel();
        const j = 0.8 + Math.random() * 0.4;
        b.setLinvel({ x: v.x + toss.x * j + (Math.random() - 0.5) * 12, y: v.y, z: v.z + toss.z * j + (Math.random() - 0.5) * 12 }, true);
        const w = b.angvel();
        b.setAngvel({ x: w.x + (Math.random() - 0.5) * 30, y: w.y + (Math.random() - 0.5) * 30, z: w.z + (Math.random() - 0.5) * 30 }, true);
      }
    }
    const init = pw.getState();
    // 预演：记录 60fps 帧，直到第一次碰到碗或桌面（最多 PRE_MAX 秒）
    const dt = pw.T.dt;
    const fdt = 1 / RECORD_FPS;
    const list = [pw.writeFrame(new Float32Array(STRIDE))];
    let hit = Infinity;
    const onSound = (e) => {
      if (e.k === KIND.bowl || e.k === KIND.table) hit = Math.min(hit, e.t);
    };
    const t0 = pw.t;
    while (hit === Infinity && pw.t - t0 < PRE_MAX) {
      pw.step(dt, onSound);
      if (pw.t - t0 >= list.length * fdt - 1e-9) list.push(pw.writeFrame(new Float32Array(STRIDE)));
    }
    const tHit = Math.min(PRE_MAX, hit - t0);
    const frames = new Float32Array(list.length * STRIDE);
    list.forEach((f, i) => frames.set(f, i * STRIDE));
    this.stop();
    return { init, pre: { frames, fps: RECORD_FPS, holdAt: Math.max(0, tHit - PRE_MARGIN) } };
  }

  stop() {
    this.pw?.free();
    this.pw = null;
    this.mode = 'idle';
  }
}

function clampReach(p) {
  const r = Math.hypot(p.x, p.z);
  if (r > HAND.reach) {
    p.x *= HAND.reach / r;
    p.z *= HAND.reach / r;
  }
  return p;
}
