// three.js 场景：瓷碗、骰子、红桌布、灯光；负责回放物理轨迹
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { bowlProfile, innerRadiusAt, BOWL, DIE, FACE_VALUES, TABLE_HALF, HAND, STRIDE, quatForValue } from './physics.js';
import { dieFaceTexture, bowlOuterTexture, bowlInnerTexture, bowlBottomTexture, tableTexture } from './textures.js';

const HOLD_DELAY = 120; // 观战时手部数据的渲染延迟，用于插值平滑

/** 在帧序列里按帧号插值出一帧（位置线性、旋转球面插值） */
function sampleFrames(frames, f, out) {
  const n = frames.length / STRIDE;
  const i0 = Math.max(0, Math.min(n - 1, Math.floor(f)));
  const i1 = Math.min(n - 1, i0 + 1);
  mixFrames(frames.subarray(i0 * STRIDE, i0 * STRIDE + STRIDE), frames.subarray(i1 * STRIDE, i1 * STRIDE + STRIDE), Math.max(0, Math.min(1, f - i0)), out);
  return out;
}

const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();
function mixFrames(a, b, k, out) {
  for (let o = 0; o < STRIDE; o += 7) {
    for (let j = 0; j < 3; j++) out[o + j] = a[o + j] + (b[o + j] - a[o + j]) * k;
    _qa.set(a[o + 3], a[o + 4], a[o + 5], a[o + 6]).normalize();
    _qb.set(b[o + 3], b[o + 4], b[o + 5], b[o + 6]).normalize();
    _qa.slerp(_qb, k);
    out[o + 3] = _qa.x;
    out[o + 4] = _qa.y;
    out[o + 5] = _qa.z;
    out[o + 6] = _qa.w;
  }
  return out;
}

/** 碗内（或桌面）在半径 r 处的表面高度 */
function surfaceY(r) {
  if (r <= BOWL.flatR) return BOWL.bottomY;
  if (r >= BOWL.rimR + BOWL.thick) return 0;
  if (r >= BOWL.rimR) return BOWL.rimY + BOWL.thick / 2;
  let lo = BOWL.bottomY, hi = BOWL.rimY;
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2;
    if (innerRadiusAt(mid) < r) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** 由旋转轮廓生成车削网格；inner 模式 v 从碗心到碗口为 0→1，outer 模式从碗口到圈足为 1→0 */
function buildLathe(points, i0, i1, segs, mode) {
  const n = i1 - i0 + 1;
  const s = [0];
  for (let i = i0 + 1; i <= i1; i++) s.push(s.at(-1) + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]));
  let L = s.at(-1);
  if (mode === 'outer') {
    const footK = points.slice(i0, i1 + 1).findIndex((p) => p[1] === 0);
    if (footK > 0) L = s[footK];
  }
  const pos = [], nor = [], uv = [], idx = [];
  for (let k = 0; k < n; k++) {
    const i = i0 + k;
    const prev = points[Math.max(i0, i - 1)];
    const next = points[Math.min(i1, i + 1)];
    let dr = next[0] - prev[0], dy = next[1] - prev[1];
    const len = Math.hypot(dr, dy) || 1;
    dr /= len;
    dy /= len;
    const [r, y] = points[i];
    const v = mode === 'inner' ? s[k] / L : Math.max(0, 1 - s[k] / L);
    for (let j = 0; j <= segs; j++) {
      const a = (j / segs) * Math.PI * 2;
      const c = Math.cos(a), sn = Math.sin(a);
      pos.push(r * c, y, r * sn);
      nor.push(-dy * c, dr, -dy * sn);
      uv.push(j / segs, v);
    }
  }
  for (let k = 0; k < n - 1; k++) {
    for (let j = 0; j < segs; j++) {
      const a = k * (segs + 1) + j, b = a + 1, c = a + segs + 1, d = c + 1;
      idx.push(a, b, c, b, d, c);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

export class Stage {
  constructor(canvas) {
    this.canvas = canvas;
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    this.renderer = renderer;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x230505);
    scene.fog = new THREE.Fog(0x230505, 60, 120);
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environmentIntensity = 0.5;
    this.scene = scene;

    this.camera = new THREE.PerspectiveCamera(38, 1, 0.5, 300);
    this.camera.position.set(0, 38, 30);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.target.set(0, 3, 0);
    this.controls.enableDamping = true;
    this.controls.enablePan = false;
    this.controls.minPolarAngle = 0.15;
    this.controls.maxPolarAngle = 1.2;
    this.controls.enabled = false;
    this.free = false;
    this.fitDist = 45;
    this.cam = { az: Math.PI / 2, polar: 0.9, dist: 45, ty: 3 };
    this.shot = { kind: 'overview' };
    this.camFrom = null;

    this.anim = null; // 回放中的投掷
    this.live = null; // 本机实时摇骰的当前帧
    this.hold = []; // 观战：他人摇骰的采样缓冲
    this.fallback = null; // 观战数据中断时退回的姿态
    this.blend = null; // 姿态切换时的短暂过渡
    this.cur = new Float32Array(STRIDE); // 当前显示的姿态
    this.tmp = new Float32Array(STRIDE);
    this.raycaster = new THREE.Raycaster();
    this.onTick = null;
    this.lastT = performance.now();

    this.addLights();
    this.addTable();
    this.addBowl();
    this.addHand();
    this.addDice();
    window.addEventListener('resize', () => this.resize());
    this.resize();
    renderer.setAnimationLoop((t) => this.tick(t));
  }

  addLights() {
    const s = this.scene;
    s.add(new THREE.HemisphereLight(0xfff3e0, 0x3a0a0a, 0.7));
    const key = new THREE.DirectionalLight(0xfff0dc, 2.4);
    key.position.set(14, 34, 10);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    const sc = key.shadow.camera;
    sc.left = sc.bottom = -24;
    sc.right = sc.top = 24;
    sc.near = 5;
    sc.far = 80;
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.03;
    key.shadow.radius = 3;
    s.add(key);
    const warm = new THREE.PointLight(0xffb070, 300, 90, 2);
    warm.position.set(-18, 22, -14);
    s.add(warm);
  }

  addTable() {
    const size = TABLE_HALF * 2 + 40;
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(size, size),
      new THREE.MeshStandardMaterial({ map: tableTexture(), roughness: 0.92, metalness: 0 }),
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.receiveShadow = true;
    this.scene.add(mesh);
  }

  addBowl() {
    const { points, innerEnd } = bowlProfile();
    const porcelain = { roughness: 0.16, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.06, side: THREE.DoubleSide };
    const inner = new THREE.Mesh(
      buildLathe(points, 0, innerEnd, 96, 'inner'),
      new THREE.MeshPhysicalMaterial({ map: bowlInnerTexture(), ...porcelain }),
    );
    const outer = new THREE.Mesh(
      buildLathe(points, innerEnd, points.length - 1, 96, 'outer'),
      new THREE.MeshPhysicalMaterial({ map: bowlOuterTexture(), ...porcelain }),
    );
    for (const m of [inner, outer]) {
      m.castShadow = true;
      m.receiveShadow = true;
    }
    const decal = new THREE.Mesh(
      new THREE.CircleGeometry(BOWL.flatR * 0.8, 64),
      new THREE.MeshStandardMaterial({
        map: bowlBottomTexture(),
        transparent: true,
        roughness: 0.2,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
      }),
    );
    decal.rotation.x = -Math.PI / 2;
    decal.position.y = BOWL.bottomY + 0.01;
    decal.receiveShadow = true;
    const bowl = new THREE.Group();
    bowl.add(inner, outer, decal);
    this.scene.add(bowl);
  }

  /** 半透明的"掌心"外壳 + 落点指示环 */
  addHand() {
    // 外形与碰撞体一致：平底 → 翘起的掌缘 → 围壁 → 合拢的顶
    const a = HAND.apothem + 0.6, h = HAND.height;
    const prof = [new THREE.Vector2(0.001, -0.5), new THREE.Vector2(HAND.flatR, -0.5)];
    for (let i = 1; i <= 6; i++) {
      const k = i / 6;
      prof.push(new THREE.Vector2(HAND.flatR + (a - HAND.flatR) * Math.sin((k * Math.PI) / 2), -0.5 + (HAND.slopeH + 0.3) * k * k));
    }
    for (let i = 1; i <= 8; i++) {
      const t = (i / 8) * (Math.PI / 2);
      prof.push(new THREE.Vector2(0.001 + Math.cos(t) * a, HAND.slopeH + (h - HAND.slopeH + 0.6) * Math.sin(t)));
    }
    const shell = new THREE.Mesh(
      new THREE.LatheGeometry(prof, 40),
      new THREE.MeshPhysicalMaterial({ color: 0xffd9a0, transparent: true, opacity: 0.22, roughness: 0.3, clearcoat: 1, depthWrite: false, side: THREE.DoubleSide }),
    );
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(a * 0.98, 0.14, 8, 48),
      new THREE.MeshStandardMaterial({ color: 0xe7b75a, metalness: 0.8, roughness: 0.3, transparent: true, opacity: 0.85 }),
    );
    ring.rotation.x = Math.PI / 2;
    ring.position.y = h / 2;
    shell.renderOrder = 2;
    this.handMesh = new THREE.Group();
    this.handMesh.add(shell, ring);
    this.handMesh.visible = false;
    this.scene.add(this.handMesh);

    this.aim = new THREE.Mesh(
      new THREE.RingGeometry(1.4, 1.9, 40),
      // 碗壁是曲面，平面圆环会被挡住一半，因此不做深度测试、始终画在最上层
      new THREE.MeshBasicMaterial({ color: 0x5fd07a, transparent: true, opacity: 0.75, depthWrite: false, depthTest: false }),
    );
    this.aim.renderOrder = 10;
    this.aim.rotation.x = -Math.PI / 2;
    this.aim.visible = false;
    this.scene.add(this.aim);
  }

  addDice() {
    const geo = new RoundedBoxGeometry(DIE.size, DIE.size, DIE.size, 4, DIE.radius);
    const mats = FACE_VALUES.map(
      (v) => new THREE.MeshPhysicalMaterial({ map: dieFaceTexture(v), roughness: 0.32, clearcoat: 0.7, clearcoatRoughness: 0.15 }),
    );
    this.dice = [];
    for (let i = 0; i < 6; i++) {
      const m = new THREE.Mesh(geo, mats);
      m.castShadow = true;
      m.receiveShadow = true;
      this.scene.add(m);
      this.dice.push(m);
    }
    this.setRest([4, 4, 4, 1, 2, 6]);
  }

  /** 把骰子摆在碗底，显示给定点数 */
  setRest(values) {
    this.anim = null;
    this.live = null;
    this.hold = [];
    this.fallback = null;
    this.blend = null;
    const f = this.cur;
    values.forEach((v, i) => {
      const a = (i / 6) * Math.PI * 2 + 0.4;
      const r = i === 0 ? 0 : 2.3;
      const q = quatForValue(v, a * 1.7);
      f.set([Math.cos(a) * r, BOWL.bottomY + DIE.size / 2, Math.sin(a) * r, q.x, q.y, q.z, q.w], i * 7);
    });
    f.set([0, -50, 0, 0, 0, 0, 1], 42);
    this.showPose(f, false);
  }

  // ---------- 镜头导演 ----------
  // 所有人看到同样的机位：轮到谁就站到谁的座位后方俯看碗；骰子停稳后切到正上方看点数。
  // 机位只由对局状态决定，因此各端无需额外同步就能保持一致。"自由视角"下可以自己拖动旋转。
  /** @param {{kind: 'overview'|'seat'|'result', az?: number}} shot */
  setShot(shot, ms = 900) {
    if (!shot) return;
    this.shot = shot;
    if (this.free) return;
    this.camFrom = { ...this.cam, t0: performance.now(), ms };
  }

  setFreeCamera(on) {
    this.free = on;
    this.controls.enabled = on;
    if (on) {
      this.controls.target.set(0, this.cam.ty, 0);
    } else {
      // 从当前位置平滑回到导演机位
      const p = this.camera.position;
      const dx = p.x, dz = p.z, dy = p.y - this.controls.target.y;
      const dist = Math.hypot(dx, dy, dz);
      this.cam = { az: Math.atan2(dz, dx), polar: Math.acos(Math.max(-1, Math.min(1, dy / dist))), dist, ty: this.controls.target.y };
      this.setShot(this.shot);
    }
  }

  /** 机位参数（相对碗心的球坐标） */
  shotParams(shot, now) {
    const d = this.fitDist;
    if (shot.kind === 'overview') return { az: this.cam.az + 0.00012 * (now - (this.lastCamT ?? now)), polar: 0.9, dist: d * 1.05, ty: 3 };
    if (shot.kind === 'result') return { az: shot.az ?? this.cam.az, polar: 0.32, dist: d * 0.72, ty: 1.5 };
    return { az: shot.az, polar: 0.78, dist: d, ty: 3 };
  }

  updateCamera(now) {
    if (this.free) {
      this.controls.update();
      return;
    }
    const goal = this.shotParams(this.shot, now);
    const f = this.camFrom;
    let c = goal;
    if (f && this.shot.kind !== 'overview') {
      const k = Math.min(1, (now - f.t0) / f.ms);
      const e = k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2;
      // 方位角走最短的一边
      let daz = goal.az - f.az;
      daz = Math.atan2(Math.sin(daz), Math.cos(daz));
      c = { az: f.az + daz * e, polar: f.polar + (goal.polar - f.polar) * e, dist: f.dist + (goal.dist - f.dist) * e, ty: f.ty + (goal.ty - f.ty) * e };
      if (k >= 1) this.camFrom = null;
    }
    this.cam = c;
    this.lastCamT = now;
    const s = Math.sin(c.polar);
    this.camera.position.set(Math.cos(c.az) * s * c.dist, c.ty + Math.cos(c.polar) * c.dist, Math.sin(c.az) * s * c.dist);
    this.camera.lookAt(0, c.ty, 0);
  }

  resize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    const cam = this.camera;
    cam.aspect = w / h;
    // 让碗和周围桌面完整入镜：竖屏时按水平视角计算距离，并收紧留白让碗尽量占满宽度
    const R = cam.aspect < 1 ? 15.5 : 18.5;
    const vf = (cam.fov * Math.PI) / 180;
    const hf = 2 * Math.atan(Math.tan(vf / 2) * cam.aspect);
    const d = R / Math.sin(Math.min(vf, hf) / 2);
    this.fitDist = d;
    if (this.free) {
      const dir = cam.position.clone().sub(this.controls.target).normalize();
      cam.position.copy(this.controls.target).addScaledVector(dir, d);
    }
    this.controls.minDistance = d * 0.45;
    this.controls.maxDistance = d * 1.5;
    // 雾随相机距离缩放，否则竖屏拉远后整个场景被雾吞掉
    this.scene.fog.near = d * 1.2;
    this.scene.fog.far = d * 3;
    cam.updateProjectionMatrix();
  }

  /**
   * 屏幕坐标 → 掌心的水平位置（xz）。取指针在碗底平面上的落点：
   * 指着哪儿，骰子就落向哪儿（落点圆环正好在指针下）；射线朝上时返回 null
   */
  pointerToHand(clientX, clientY) {
    const r = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -(BOWL.bottomY + 2));
    const hit = new THREE.Vector3();
    return this.raycaster.ray.intersectPlane(plane, hit) ? { x: hit.x, z: hit.z } : null;
  }

  // ---------- 姿态来源：回放 > 本机实时 > 观战缓冲 > 静止 ----------
  /** 过渡 ms 毫秒，从当前显示姿态切换到新来源 */
  startBlend(ms) {
    this.blend = { from: this.cur.slice(), t0: performance.now(), ms };
  }

  /** 本机实时摇骰/预测的帧；传 null 结束 */
  setLive(frame, handVisible) {
    if (frame && !this.live) this.startBlend(220);
    this.live = frame;
    this.liveHand = handVisible;
    if (frame) {
      this.hold = [];
      this.fallback = null;
    }
  }

  /** 观战：收到他人摇骰的采样 */
  pushHold(frame) {
    const now = performance.now();
    if (!this.hold.length || now - this.hold.at(-1).t > 600) this.startBlend(250);
    this.hold.push({ t: now, f: frame });
    if (this.hold.length > 12) this.hold.shift();
    this.fallback = null;
  }

  /** 落点指示：null 隐藏 */
  setAim(xz) {
    if (!xz) {
      this.aim.visible = false;
      return;
    }
    const r = Math.hypot(xz.x, xz.z);
    const inside = r < BOWL.rimR - 1;
    this.aim.visible = true;
    this.aim.position.set(xz.x, surfaceY(r) + 0.08, xz.z);
    this.aim.material.color.set(inside ? 0x5fd07a : 0xe0452c);
  }

  /**
   * 回放一次投掷轨迹
   * @param roll {frames, fps, holdFrames, sounds}
   * @param {{startAt?: number, lead?: number, blend?: number, arc?: boolean}} o
   *   startAt：从轨迹的第几秒开始（投掷者本机已预测过的部分）；lead：开始前的过渡时长（毫秒，时钟暂停）
   */
  playRoll(roll, onSound, o = {}) {
    if (this.anim) this.anim.resolve();
    this.live = null;
    this.hold = [];
    this.fallback = null;
    const startAt = o.startAt ?? 0;
    this.startBlend(o.blend ?? 150);
    return new Promise((resolve) => {
      const sounds = roll.sounds;
      let soundIdx = 0;
      while (soundIdx < sounds.length && sounds[soundIdx].t < startAt) soundIdx++;
      this.anim = { roll, start: performance.now(), startAt, lead: o.lead ?? 0, arc: !!o.arc, soundIdx, onSound, resolve };
    });
  }

  /** 计算本帧要显示的目标姿态；返回 [frame, 手是否可见] */
  targetPose(now) {
    const a = this.anim;
    if (a) {
      const el = now - a.start;
      const { frames, fps } = a.roll;
      const n = frames.length / STRIDE;
      const t = a.startAt + Math.max(0, el - a.lead) / 1000;
      const sounds = a.roll.sounds;
      while (a.soundIdx < sounds.length && sounds[a.soundIdx].t <= t) a.onSound?.(sounds[a.soundIdx++]);
      const f = t * fps;
      sampleFrames(frames, f, this.tmp);
      if (f >= n - 1) {
        this.anim = null;
        a.resolve();
      }
      return [this.tmp, f < (a.roll.holdFrames || 0)];
    }
    if (this.live) return [this.live, this.liveHand];
    if (this.hold.length) {
      const rt = now - HOLD_DELAY;
      const h = this.hold;
      if (now - h.at(-1).t > 1500) {
        // 观战数据中断：让骰子落回碗底
        this.fallback = this.fallback || this.restFrom(h.at(-1).f);
        this.hold = [];
        this.startBlend(400);
        return [this.fallback, false];
      }
      let i = h.length - 1;
      while (i > 0 && h[i - 1].t > rt) i--;
      if (i === 0 || h[i].t <= rt) return [h[Math.max(0, i)].f, true];
      const A = h[i - 1], B = h[i];
      return [mixFrames(A.f, B.f, (rt - A.t) / (B.t - A.t), this.tmp), true];
    }
    if (this.fallback) return [this.fallback, false];
    return null;
  }

  /** 由一帧生成"平放在碗底"的姿态（保留朝上的面） */
  restFrom(f) {
    const out = this.cur.slice();
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + 0.4;
      const r = i === 0 ? 0 : 2.3;
      out.set([Math.cos(a) * r, BOWL.bottomY + DIE.size / 2, Math.sin(a) * r], i * 7);
      out.set(f.subarray(i * 7 + 3, i * 7 + 7), i * 7 + 3);
    }
    return out;
  }

  showPose(f, handVisible) {
    for (let d = 0; d < 6; d++) {
      const o = d * 7;
      this.dice[d].position.set(f[o], f[o + 1], f[o + 2]);
      this.dice[d].quaternion.set(f[o + 3], f[o + 4], f[o + 5], f[o + 6]).normalize();
    }
    this.handMesh.visible = handVisible;
    if (handVisible) {
      this.handMesh.position.set(f[42], f[43], f[44]);
      this.handMesh.quaternion.set(f[45], f[46], f[47], f[48]).normalize();
    }
    if (f !== this.cur) this.cur.set(f);
  }

  tick() {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastT) / 1000);
    this.lastT = now;
    this.onTick?.(dt);
    const target = this.targetPose(now);
    if (target) {
      let [f, handVisible] = target;
      const b = this.blend;
      if (b) {
        const k = Math.min(1, (now - b.t0) / b.ms);
        if (k >= 1) this.blend = null;
        else {
          const e = k * k * (3 - 2 * k);
          const mixed = mixFrames(b.from, f, e, new Float32Array(STRIDE));
          // 一键掷骰的"抓起"过渡：骰子划一道弧线进入掌心
          if (this.anim?.arc) for (let d = 0; d < 6; d++) mixed[d * 7 + 1] += Math.sin(e * Math.PI) * 3;
          mixed.set(f.subarray(42, 49), 42);
          f = mixed;
        }
      }
      this.showPose(f, handVisible);
    }
    this.updateCamera(now);
    this.renderer.render(this.scene, this.camera);
  }
}
