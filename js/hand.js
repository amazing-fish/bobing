// 实时摇骰：在投掷者本机运行物理，手跟随指针移动，骰子在掌心里真实碰撞；
// 松手后继续本地预测，直到房主的权威结果到达再平滑衔接
import { PhysWorld, HAND, STRIDE, mulberry32, tiltQuat, BOWL } from './physics.js';

const HOLD_DT = 1 / 240;
const OMEGA = 28; // 手跟随指针的弹簧频率（临界阻尼）
const VOMEGA = 22; // 掌心上下晃动的弹簧频率

export class HandController {
  constructor() {
    this.pw = null;
    this.mode = 'idle'; // idle | hold | predict
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
    } else if (this.mode === 'predict') {
      const dt = this.pw.T.dt;
      while (this.acc >= dt) {
        this.acc -= dt;
        this.pw.step(dt, onSound);
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

  /** 松手：返回交给房主的初始状态（6 × [p,q,v,w]） */
  release() {
    if (this.mode !== 'hold') return null;
    this.pw.release({ x: this.vel.x, y: 0, z: this.vel.z });
    this.mode = 'predict';
    this.acc = 0;
    return this.pw.getState();
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
