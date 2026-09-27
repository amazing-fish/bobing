// 物理仿真：Rapier 刚体 + 碗的三角网格碰撞体。房主端一次性算完整条轨迹，再广播给所有人回放。
// 单位：厘米、克、秒（重力 981 cm/s²）
import RAPIER from '../vendor/rapier/rapier.mjs';

export const DIE = { size: 1.8, radius: 0.16, density: 1.2 };
export const BOWL = { flatR: 4.5, rimR: 13.4, bottomY: 1.2, rimY: 8.2, thick: 0.6, segs: 64 };
export const TABLE_HALF = 42;
export const RECORD_FPS = 60;
export const PICKUP_MS = 380; // 一键掷骰回放前"抓起骰子"的过渡时长

// 可调参数（经 scripts/calibrate.mjs 校准）
export const TUNE = {
  dt: 1 / 120,
  bowlFriction: 0.15,
  bowlRestitution: 0.5,
  dieFriction: 0.25,
  dieRestitution: 0.45,
  linDamp: 0.02,
  angDamp: 0.1,
  flickMin: 20, // 一键掷骰 / 电脑：力度 0 → 1 对应的甩出速度 cm/s
  flickMax: 200,
  releaseBoost: 0.2, // 松手时额外传给骰子的手速比例
  releaseDrop: 25, // 松手时向下的基础速度
  releaseDropK: 0.25, // 甩得越快，向下砸得越猛
};

let ready = null;
export function initPhysics() {
  ready ??= RAPIER.init();
  return ready;
}

// ---------- 碗的轮廓（渲染与碰撞共用） ----------
function innerWall(t) {
  // t: 0..1，从平底边缘到碗口；越往上越陡
  const { flatR, rimR, bottomY, rimY } = BOWL;
  return [flatR + (rimR - flatR) * t, bottomY + (rimY - bottomY) * t ** 2.2];
}

let profileCache = null;
/**
 * 碗的旋转轮廓：从内底中心出发 → 内壁 → 碗沿 → 外壁 → 圈足 → 外底中心。
 * @returns {{points: [number, number][], innerEnd: number}} innerEnd 为内表面最后一个点的下标
 */
export function bowlProfile() {
  if (profileCache) return profileCache;
  const { flatR, rimR, bottomY, rimY, thick } = BOWL;
  const pts = [];
  for (let i = 0; i <= 6; i++) pts.push([(flatR * i) / 6, bottomY]);
  const wall = [];
  for (let i = 1; i <= 28; i++) wall.push(innerWall(i / 28));
  pts.push(...wall);
  const innerEnd = pts.length - 1;

  // 碗沿：半圆弧从内口翻到外口
  const cx = rimR + thick / 2;
  for (let i = 1; i < 10; i++) {
    const a = Math.PI - (Math.PI * i) / 10;
    pts.push([cx + (thick / 2) * Math.cos(a), rimY + (thick / 2) * Math.sin(a)]);
  }
  // 外壁：内壁沿法线向外偏移 thick，自上而下
  const offset = (t) => {
    const e = 1e-3;
    const [x0, y0] = innerWall(Math.max(0, t - e));
    const [x1, y1] = innerWall(Math.min(1, t + e));
    const tx = x1 - x0;
    const ty = y1 - y0;
    const len = Math.hypot(tx, ty);
    const [x, y] = innerWall(t);
    return [x + (thick * ty) / len, y - (thick * tx) / len];
  };
  for (let i = 28; i >= 2; i--) pts.push(offset(i / 28));
  // 圈足
  pts.push([6.4, 0.55], [6.6, 0.12], [6.5, 0], [5.9, 0], [5.8, 0.25], [0, 0.25]);
  profileCache = { points: pts, innerEnd };
  return profileCache;
}

/** 碗内表面在高度 y 处的半径（用于判断是否掉出碗外） */
export function innerRadiusAt(y) {
  const { flatR, rimR, bottomY, rimY } = BOWL;
  if (y <= bottomY) return flatR;
  if (y >= rimY) return rimR;
  const t = ((y - bottomY) / (rimY - bottomY)) ** (1 / 2.2);
  return flatR + (rimR - flatR) * t;
}

function bowlTrimesh() {
  const { points } = bowlProfile();
  const segs = BOWL.segs;
  const verts = [];
  const ringStart = [];
  for (const [r, y] of points) {
    ringStart.push(verts.length / 3);
    if (r < 1e-6) {
      verts.push(0, y, 0);
    } else {
      for (let j = 0; j < segs; j++) {
        const a = (j / segs) * Math.PI * 2;
        verts.push(r * Math.cos(a), y, r * Math.sin(a));
      }
    }
  }
  const idx = [];
  const at = (i, j) => (points[i][0] < 1e-6 ? ringStart[i] : ringStart[i] + (j % segs));
  for (let i = 0; i < points.length - 1; i++) {
    const axisA = points[i][0] < 1e-6;
    const axisB = points[i + 1][0] < 1e-6;
    for (let j = 0; j < segs; j++) {
      const a = at(i, j), b = at(i, j + 1), c = at(i + 1, j), d = at(i + 1, j + 1);
      if (!axisA) idx.push(a, b, c);
      if (!axisB) idx.push(b, d, c);
      if (axisA && axisB) break;
    }
  }
  return { vertices: new Float32Array(verts), indices: new Uint32Array(idx) };
}

// ---------- 随机数 ----------
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- 读点数 ----------
// 骰面顺序与 three.js BoxGeometry 材质分组一致：+x,-x,+y,-y,+z,-z，对面之和为 7
export const FACE_VALUES = [1, 6, 2, 5, 3, 4];

/** 返回朝上的点数及其对齐程度（1 = 完全平放） */
export function topFace(q) {
  const { x, y, z, w } = q;
  // 旋转后各本地轴的世界 y 分量
  const ux = 2 * (x * y + w * z);
  const uy = 1 - 2 * (x * x + z * z);
  const uz = 2 * (y * z - w * x);
  const cands = [ux, -ux, uy, -uy, uz, -uz];
  let best = 0;
  for (let i = 1; i < 6; i++) if (cands[i] > cands[best]) best = i;
  return { value: FACE_VALUES[best], align: cands[best] };
}

/** 让本地 +y 朝上显示给定点数、再绕竖直轴转 yaw 的四元数 */
export function quatForValue(value, yaw = 0) {
  const s = Math.SQRT1_2;
  const base = {
    1: [0, 0, s, s], // +x → +y
    6: [0, 0, -s, s],
    2: [0, 0, 0, 1],
    5: [1, 0, 0, 0],
    3: [-s, 0, 0, s], // +z → +y
    4: [s, 0, 0, s],
  }[value];
  const [bx, by, bz, bw] = base;
  const hy = Math.sin(yaw / 2), hw = Math.cos(yaw / 2);
  // q = yawQ * base
  return { x: hw * bx + hy * bz, y: hw * by + hy * bw, z: hw * bz - hy * bx, w: hw * bw - hy * by };
}

// ---------- 仿真世界 ----------
// 手：一只可开合的"掌心"，运动学刚体（八边形围壁 + 底 + 顶），摇骰时骰子在里面真实碰撞
// 实测（scripts/calibrate.mjs）：松手手速 ≤120 cm/s 几乎不出碗，~190 约 17% 作废，240 约 75% 作废
// 掌心形状经 scripts/shake-metric.mjs 调过：比平底直壁的盒子更容易让骰子翻滚
export const HAND = { apothem: 5.5, height: 4.6, flatR: 2.6, slopeH: 2.2, friction: 1.0, y: 12.5, reach: 19, maxSpeed: 210 };
export const STRIDE = 49; // 每帧：6 颗骰子 + 手，各 [px,py,pz,qx,qy,qz,qw]
const HOLD_DT = 1 / 240;
export const KIND = { die: 0, bowl: 1, table: 2, hand: 3 };

/** 物理世界：碗、桌、围栏、6 颗骰子、手。实时摇骰与权威仿真共用 */
export class PhysWorld {
  constructor(tune = {}) {
    const T = (this.T = { ...TUNE, ...tune });
    const world = (this.world = new RAPIER.World({ x: 0, y: -981, z: 0 }));
    world.timestep = T.dt;
    world.lengthUnit = 100;
    world.numSolverIterations = 6;
    this.events = new RAPIER.EventQueue(true);
    this.kinds = new Map();
    this.lastPair = new Map();
    this.t = 0;

    const fixed = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    const { vertices, indices } = bowlTrimesh();
    this.tag(world.createCollider(RAPIER.ColliderDesc.trimesh(vertices, indices).setFriction(T.bowlFriction).setRestitution(T.bowlRestitution), fixed), KIND.bowl);
    this.tag(world.createCollider(RAPIER.ColliderDesc.cuboid(TABLE_HALF, 2, TABLE_HALF).setTranslation(0, -2, 0).setFriction(0.7).setRestitution(0.12), fixed), KIND.table);
    for (const [x, z, hx, hz] of [[TABLE_HALF, 0, 1, TABLE_HALF], [-TABLE_HALF, 0, 1, TABLE_HALF], [0, TABLE_HALF, TABLE_HALF, 1], [0, -TABLE_HALF, TABLE_HALF, 1]]) {
      this.tag(world.createCollider(RAPIER.ColliderDesc.cuboid(hx, 6, hz).setTranslation(x, 6, z).setRestitution(0.2), fixed), KIND.table);
    }

    // 手：像捧起的掌心——平底 + 一圈向外翘起的斜坡 + 8 面围壁 + 顶盖。
    // 斜坡和较大的摩擦让滑到边上的骰子被"掀"起来翻个面，而不是贴着壁滑动
    const hand = (this.hand = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, 40, 0)));
    const { apothem: a, height: h, flatR, slopeH, friction } = HAND;
    const wall = 0.5;
    const tan8 = Math.tan(Math.PI / 8);
    const side = 2 * a * tan8 + wall;
    const yawQ = (th) => ({ x: 0, y: Math.sin(th / 2), z: 0, w: Math.cos(th / 2) });
    const mul = (p, q) => ({
      x: p.w * q.x + p.x * q.w + p.y * q.z - p.z * q.y,
      y: p.w * q.y - p.x * q.z + p.y * q.w + p.z * q.x,
      z: p.w * q.z + p.x * q.y - p.y * q.x + p.z * q.w,
      w: p.w * q.w - p.x * q.x - p.y * q.y - p.z * q.z,
    });
    this.handColliders = [
      RAPIER.ColliderDesc.cuboid(flatR * 1.1, wall / 2, flatR * 1.1).setTranslation(0, -wall / 2, 0),
      RAPIER.ColliderDesc.cuboid(a + wall, wall / 2, a + wall).setTranslation(0, h + wall / 2, 0),
    ];
    const run = a - flatR;
    const phi = Math.atan2(slopeH, run);
    const L = Math.hypot(run, slopeH);
    const tilt = { x: -Math.sin(phi / 2), y: 0, z: 0, w: Math.cos(phi / 2) };
    for (let i = 0; i < 8; i++) {
      const ang = (i / 8) * Math.PI * 2;
      const th = Math.PI / 2 - ang;
      const c = Math.cos(ang), s = Math.sin(ang);
      // 斜坡：中心在坡面中点，沿法线向下偏半个板厚
      const rm = flatR + run / 2 + Math.sin(phi) * (wall / 2);
      const ym = slopeH / 2 - Math.cos(phi) * (wall / 2);
      const halfW = (flatR + run) * tan8 + wall;
      this.handColliders.push(
        RAPIER.ColliderDesc.cuboid(halfW, wall / 2, L / 2 + 0.2)
          .setTranslation(c * rm, ym, s * rm)
          .setRotation(mul(yawQ(th), tilt)),
      );
      this.handColliders.push(
        RAPIER.ColliderDesc.cuboid(side / 2, h / 2 + wall, wall / 2)
          .setTranslation(c * (a + wall / 2), h / 2, s * (a + wall / 2))
          .setRotation(yawQ(th)),
      );
    }
    this.handColliders = this.handColliders.map((d) => {
      const c = world.createCollider(d.setFriction(friction).setFrictionCombineRule(RAPIER.CoefficientCombineRule.Max).setRestitution(0.3), hand);
      this.tag(c, KIND.hand);
      return c;
    });
    this.handOpen = true;
    this.setHandEnabled(false);

    const hd = DIE.size / 2;
    this.dice = [];
    for (let i = 0; i < 6; i++) {
      const b = world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic().setTranslation(i * 2.5 - 6, BOWL.bottomY + hd, 0).setCcdEnabled(true).setLinearDamping(T.linDamp).setAngularDamping(T.angDamp),
      );
      const c = world.createCollider(
        RAPIER.ColliderDesc.cuboid(hd, hd, hd)
          .setDensity(DIE.density)
          .setFriction(T.dieFriction)
          .setRestitution(T.dieRestitution)
          .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
          .setContactForceEventThreshold(12000),
        b,
      );
      this.tag(c, KIND.die);
      this.dice.push(b);
    }
  }

  tag(collider, kind) {
    this.kinds.set(collider.handle, kind);
    return collider;
  }

  setHandEnabled(on) {
    for (const c of this.handColliders) c.setEnabled(on);
    this.handOpen = !on;
  }

  /** 把骰子装进手里（掌心上方随机朝向），并把手瞬移到 pos */
  fillHand(pos, rng) {
    this.hand.setTranslation(pos, true);
    this.hand.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
    this.setHandEnabled(true);
    const slots = [[0, 0]];
    const ringR = Math.min(HAND.apothem - DIE.size * 0.8, 2.9);
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 + rng() * 0.4;
      slots.push([Math.cos(a) * ringR, Math.sin(a) * ringR]);
    }
    this.dice.forEach((b, i) => {
      const [dx, dz] = slots[i];
      const lift = i === 0 ? 0 : HAND.slopeH * Math.max(0, (ringR - HAND.flatR) / (HAND.apothem - HAND.flatR));
      b.setTranslation({ x: pos.x + dx, y: pos.y + DIE.size / 2 + 0.25 + lift + rng() * 0.3, z: pos.z + dz }, true);
      b.setRotation(quatForValue(1 + Math.floor(rng() * 6), rng() * Math.PI * 2), true);
      b.setLinvel({ x: 0, y: 0, z: 0 }, true);
      b.setAngvel({ x: (rng() - 0.5) * 6, y: (rng() - 0.5) * 6, z: (rng() - 0.5) * 6 }, true);
    });
  }

  /** 运动学手的下一步位姿（在 step 前调用） */
  moveHand(pos, rot) {
    this.hand.setNextKinematicTranslation(pos);
    if (rot) this.hand.setNextKinematicRotation(rot);
  }

  /** 张开手：关闭碰撞体，并把手的速度按比例传给骰子（甩出去的动作） */
  release(handVel) {
    this.setHandEnabled(false);
    const { releaseBoost: k, releaseDrop, releaseDropK } = this.T;
    const hs = Math.hypot(handVel.x, handVel.z);
    for (const b of this.dice) {
      const v = b.linvel();
      b.setLinvel({ x: v.x + handVel.x * k, y: Math.min(v.y, 0) - releaseDrop - hs * releaseDropK, z: v.z + handVel.z * k }, true);
    }
  }

  /** 摇骰时防止极端情况下骰子穿出掌心 */
  contain() {
    const p = this.hand.translation();
    const lim = HAND.apothem - DIE.size * 0.5;
    for (const b of this.dice) {
      const q = b.translation();
      const dx = q.x - p.x, dz = q.z - p.z, dy = q.y - p.y;
      if (Math.hypot(dx, dz) > HAND.apothem + 1 || dy < -1 || dy > HAND.height + 1) {
        b.setTranslation({ x: p.x + Math.max(-lim, Math.min(lim, dx * 0.5)), y: p.y + DIE.size / 2 + 0.2, z: p.z + Math.max(-lim, Math.min(lim, dz * 0.5)) }, true);
        b.setLinvel(this.handVel ?? { x: 0, y: 0, z: 0 }, true);
      }
    }
  }

  getState() {
    const out = [];
    for (const b of this.dice) {
      const p = b.translation(), r = b.rotation(), v = b.linvel(), w = b.angvel();
      out.push(p.x, p.y, p.z, r.x, r.y, r.z, r.w, v.x, v.y, v.z, w.x, w.y, w.z);
    }
    return out;
  }

  setState(s) {
    this.dice.forEach((b, i) => {
      const o = i * 13;
      b.setTranslation({ x: s[o], y: s[o + 1], z: s[o + 2] }, true);
      b.setRotation({ x: s[o + 3], y: s[o + 4], z: s[o + 5], w: s[o + 6] }, true);
      b.setLinvel({ x: s[o + 7], y: s[o + 8], z: s[o + 9] }, true);
      b.setAngvel({ x: s[o + 10], y: s[o + 11], z: s[o + 12] }, true);
    });
  }

  /** 推进一步，碰撞产生的声音事件交给 onSound({t,k,s}) */
  step(dt, onSound) {
    this.world.timestep = dt;
    this.world.step(this.events);
    this.t += dt;
    const t = this.t;
    // 接触力 ≈ 冲量/步长，按步长归一化，保证 120Hz/240Hz 下音量一致
    const norm = 150000 * (this.T.dt / dt);
    this.events.drainContactForceEvents((ev) => {
      const h1 = ev.collider1(), h2 = ev.collider2();
      const k1 = this.kinds.get(h1), k2 = this.kinds.get(h2);
      const k = k1 === KIND.die && k2 === KIND.die ? 0 : Math.max(k1, k2);
      // 手里摇骰时碰撞极密，限流到听感自然的程度
      const inHand = !this.handOpen;
      const key = inHand ? -1 : h1 < h2 ? h1 * 4096 + h2 : h2 * 4096 + h1;
      if (t - (this.lastPair.get(key) ?? -1) < (inHand ? 0.045 : 0.05)) return;
      const s = Math.min(1, ev.totalForceMagnitude() / norm);
      if (s < (inHand ? 0.08 : 0.04)) return;
      this.lastPair.set(key, t);
      onSound?.({ t: +t.toFixed(3), k, s: +s.toFixed(2) });
    });
  }

  isCalm() {
    for (const b of this.dice) {
      const v = b.linvel(), w = b.angvel();
      if (v.x * v.x + v.y * v.y + v.z * v.z > 0.36 || w.x * w.x + w.y * w.y + w.z * w.z > 0.25) return false;
    }
    return true;
  }

  /** 写入一帧（6 颗骰子 + 手）到 out[offset..] */
  writeFrame(out, offset = 0) {
    this.dice.forEach((b, i) => {
      const p = b.translation(), r = b.rotation();
      out.set([p.x, p.y, p.z, r.x, r.y, r.z, r.w], offset + i * 7);
    });
    const p = this.hand.translation(), r = this.hand.rotation();
    out.set([p.x, p.y, p.z, r.x, r.y, r.z, r.w], offset + 42);
    return out;
  }

  free() {
    this.world.free();
    this.events.free();
  }
}

/** 由手的加速度得到轻微倾斜（摇骰时掌心随动作倾侧，骰子更容易翻滚） */
export function tiltQuat(ax, az, k = 0.00025, max = 0.3) {
  const mag = Math.hypot(ax, az);
  if (mag < 1e-6) return { x: 0, y: 0, z: 0, w: 1 };
  const ang = Math.min(max, mag * k);
  // 转轴 = up × a = (az, 0, -ax)
  const s = Math.sin(ang / 2) / mag;
  return { x: az * s, y: 0, z: -ax * s, w: Math.cos(ang / 2) };
}

// ---------- 权威仿真 ----------
/**
 * 模拟一次投掷（在房主端运行，结果广播给所有人回放）
 * 两种方式：
 *  - init：真人手势。客户端实时摇骰后松手，发来松手瞬间 6 颗骰子的状态（已含甩出速度）
 *  - power：一键掷骰 / 电脑玩家。按力度生成"抓起 → 摇 → 甩出"的完整手部动作
 * @param {{init?: number[], power?: number, seat?: number, seats?: number, seed?: number, tune?: object}} opts
 * @returns {{frames: Float32Array, frameCount: number, holdFrames: number, fps: number, dice: number[], outMask: boolean[], out: boolean, minAlign: number, sounds: {t:number,k:number,s:number}[], duration: number, seed: number}}
 *   frames 每帧 STRIDE 个数（6 颗骰子 + 手）；holdFrames 之前手可见。sounds.k：0 骰-骰，1 骰-碗，2 骰-桌，3 骰-手
 */
export function simulateThrow(opts = {}) {
  const seed = opts.seed ?? Math.floor(Math.random() * 2 ** 31);
  const rng = mulberry32(seed);
  const pw = new PhysWorld(opts.tune);
  const frameList = [];
  const sounds = [];
  const onSound = (e) => sounds.push(e);
  const record = () => frameList.push(pw.writeFrame(new Float32Array(STRIDE)));
  let holdFrames = 0;
  let nextFrameT = 0;
  const frameDt = 1 / RECORD_FPS;

  if (opts.init) {
    const init = sanitizeInit(opts.init, rng);
    if (!init) throw new Error('投掷数据无效');
    pw.setState(init);
    record();
  } else {
    const power = Math.min(1, Math.max(0, opts.power ?? 0.5));
    const seats = Math.max(1, opts.seats ?? 1);
    // 与镜头机位一致（main.js seatAz）：座位 0 在 +z 方向
    const path = scriptedHand(rng, power, Math.PI / 2 + ((opts.seat ?? 0) / seats) * Math.PI * 2, pw.T);
    pw.fillHand(path.pos(0), rng);
    record();
    nextFrameT = frameDt;
    let prev = path.pos(0);
    let prevV = { x: 0, y: 0, z: 0 };
    for (let t = HOLD_DT; t <= path.release + 1e-9; t += HOLD_DT) {
      const p = path.pos(t);
      const v = { x: (p.x - prev.x) / HOLD_DT, y: (p.y - prev.y) / HOLD_DT, z: (p.z - prev.z) / HOLD_DT };
      const a = { x: (v.x - prevV.x) / HOLD_DT, z: (v.z - prevV.z) / HOLD_DT };
      pw.handVel = v;
      pw.moveHand(p, tiltQuat(a.x, a.z));
      pw.step(HOLD_DT, onSound);
      pw.contain();
      prev = p;
      prevV = v;
      if (pw.t >= nextFrameT - 1e-9) {
        record();
        nextFrameT += frameDt;
      }
    }
    holdFrames = frameList.length;
    pw.release(prevV);
  }

  // 松手后：骰子自由下落进碗，直到停稳
  const T = pw.T;
  const t0 = pw.t;
  let calm = 0;
  let nudged = false;
  const maxT = t0 + 9;
  if (opts.init) nextFrameT = frameDt;
  while (pw.t < maxT) {
    pw.step(T.dt, onSound);
    if (pw.t >= nextFrameT - 1e-9) {
      record();
      nextFrameT += frameDt;
    }
    calm = pw.isCalm() ? calm + T.dt : 0;
    if (calm > 0.25) {
      // 骰子斜靠（碗壁/互相叠压）时轻推一下，模拟"碗晃一晃"
      const leaning = pw.dice.filter((b) => topFace(b.rotation()).align < 0.9);
      if (leaning.length && !nudged) {
        nudged = true;
        for (const b of leaning) {
          const m = b.mass();
          b.applyImpulse({ x: (rng() - 0.5) * 30 * m, y: 35 * m, z: (rng() - 0.5) * 30 * m }, true);
          b.applyTorqueImpulse({ x: (rng() - 0.5) * 4 * m, y: 0, z: (rng() - 0.5) * 4 * m }, true);
        }
        calm = 0;
        continue;
      }
      break;
    }
  }
  record();

  const dice = [];
  const outMask = [];
  let minAlign = 1;
  for (const b of pw.dice) {
    const p = b.translation();
    const top = topFace(b.rotation());
    dice.push(top.value);
    minAlign = Math.min(minAlign, top.align);
    const r = Math.hypot(p.x, p.z);
    outMask.push(r > BOWL.rimR + DIE.size * 0.3 || (p.y < BOWL.bottomY + 0.2 && r > BOWL.flatR + 2));
  }
  pw.free();

  const frames = new Float32Array(frameList.length * STRIDE);
  frameList.forEach((f, i) => frames.set(f, i * STRIDE));
  return {
    frames,
    frameCount: frameList.length,
    holdFrames,
    fps: RECORD_FPS,
    dice,
    outMask,
    out: outMask.some(Boolean),
    minAlign,
    sounds,
    duration: (frameList.length - 1) / RECORD_FPS,
    seed,
  };
}

/**
 * 一键掷骰 / 电脑玩家的手部动作：从座位一侧抓起 → 左右摇晃 → 向碗心方向甩出
 * 力度越大，甩出速度越快，越容易出碗
 */
function scriptedHand(rng, power, seatAngle, T) {
  const r0 = 7 + rng() * 3;
  const start = { x: Math.cos(seatAngle) * r0, y: HAND.y, z: Math.sin(seatAngle) * r0 };
  const rr = 1.5 + rng() * 3;
  const ra = seatAngle + (rng() - 0.5) * 1.2;
  const rel = { x: Math.cos(ra) * rr, y: HAND.y + 0.5, z: Math.sin(ra) * rr };
  const shakeT = 0.9 + rng() * 0.5;
  const flickT = 0.14;
  const release = shakeT + flickT;
  const freq = 5 + rng() * 1.5;
  const amp = 1.5 + rng();
  const dir = rng() * Math.PI;
  const dx = Math.cos(dir), dz = Math.sin(dir);
  // 甩出方向：从出手点指向碗心偏对侧，速度随力度增加（手只做水平甩动，下砸速度在松手时给出）
  const speed = T.flickMin + (T.flickMax - T.flickMin) * power;
  const aim = Math.atan2(-rel.z, -rel.x) + (rng() - 0.5) * 0.8;
  const vRel = { x: Math.cos(aim) * speed, y: 0, z: Math.sin(aim) * speed };
  const ease = (k) => k * k * (3 - 2 * k);
  const pos = (t) => {
    if (t <= shakeT) {
      const k = ease(Math.min(1, t / shakeT));
      const env = Math.min(1, t / 0.2) * (1 - 0.3 * k);
      const s = Math.sin(t * freq * Math.PI * 2) * amp * env;
      return {
        x: start.x + (rel.x - vRel.x * flickT * 0.5 - start.x) * k + dx * s,
        y: HAND.y + Math.abs(Math.sin(t * freq * Math.PI * 2)) * 0.6 * env,
        z: start.z + (rel.z - vRel.z * flickT * 0.5 - start.z) * k + dz * s,
      };
    }
    // 甩出：匀加速到 vRel，末端恰好到达出手点
    const u = Math.min(flickT, t - shakeT);
    const f = (u * u) / (2 * flickT);
    const base = { x: rel.x - vRel.x * flickT * 0.5, y: HAND.y, z: rel.z - vRel.z * flickT * 0.5 };
    return { x: base.x + vRel.x * f, y: base.y + vRel.y * f, z: base.z + vRel.z * f };
  };
  return { pos, release };
}

/**
 * 校验并清洗客户端发来的松手状态（6 × [p, q, v, w]），再加入少量随机扰动，
 * 防止客户端预先算好一个"必中"的初始状态
 */
export function sanitizeInit(init, rng = Math.random) {
  if (!Array.isArray(init) || init.length !== 78 || !init.every(Number.isFinite)) return null;
  const s = init.slice();
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  for (let i = 0; i < 6; i++) {
    const o = i * 13;
    const r = Math.hypot(s[o], s[o + 2]);
    const maxR = HAND.reach + HAND.apothem;
    if (r > maxR) {
      s[o] *= maxR / r;
      s[o + 2] *= maxR / r;
    }
    s[o + 1] = clamp(s[o + 1], HAND.y - 1, HAND.y + HAND.height + 2);
    const qn = Math.hypot(s[o + 3], s[o + 4], s[o + 5], s[o + 6]) || 1;
    for (let k = 3; k < 7; k++) s[o + k] /= qn;
    const v = Math.hypot(s[o + 7], s[o + 8], s[o + 9]);
    if (v > 450) for (let k = 7; k < 10; k++) s[o + k] *= 450 / v;
    const w = Math.hypot(s[o + 10], s[o + 11], s[o + 12]);
    if (w > 80) for (let k = 10; k < 13; k++) s[o + k] *= 80 / w;
    for (let k = 7; k < 10; k++) s[o + k] += (rng() - 0.5) * 3;
    for (let k = 10; k < 13; k++) s[o + k] += (rng() - 0.5) * 1.2;
  }
  return s;
}

// ---------- 轨迹编码（网络传输用） ----------
export function encodeFrames(frames) {
  const q = new Int16Array(frames.length);
  for (let i = 0; i < frames.length; i++) {
    const comp = i % 7;
    q[i] = Math.round(comp < 3 ? frames[i] * 100 : frames[i] * 32767);
  }
  const bytes = new Uint8Array(q.buffer);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function decodeFrames(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const q = new Int16Array(bytes.buffer);
  const out = new Float32Array(q.length);
  for (let i = 0; i < q.length; i++) out[i] = i % 7 < 3 ? q[i] / 100 : q[i] / 32767;
  return out;
}
