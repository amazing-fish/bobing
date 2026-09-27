// 入口：页面流程、界面渲染、蓄力投掷
import { initPhysics, encodeFrames, HAND, PICKUP_MS } from './physics.js';
import { PRIZES, PRIZE_BY_ID, ZY_LEVELS, totalCakes } from './rules.js';
import { defaultPool } from './game.js';
import { HostSession, ClientSession, friendlyError, randomId } from './session.js';
import { HandController } from './hand.js';
import { unlockAudio, playImpact, playShake, playChime, playFail, setMuted, isMuted } from './audio.js';

const $ = (id) => document.getElementById(id);
const SEAT_COLORS = ['#e63b2e', '#f2a31b', '#2e8b57', '#2f6fd6', '#8e44ad', '#d6457a', '#16a3a3', '#7a5230'];
const POINTS = { zhuangyuan: 32, duitang: 16, sanhong: 8, sijin: 4, erju: 2, yixiu: 1 };
const PRESETS = {
  standard: defaultPool(),
  quick: { zhuangyuan: 1, duitang: 1, sanhong: 2, sijin: 2, erju: 4, yixiu: 8 },
};
const PIP_CELLS = { 1: [5], 2: [3, 7], 3: [3, 5, 7], 4: [1, 3, 7, 9], 5: [1, 3, 5, 7, 9], 6: [1, 3, 4, 6, 7, 9] };

let stage = null;
let session = null;
let view = null; // 当前展示的状态快照
let animating = false;
let pendingState = null;
let endShownFor = null;
const store = {
  get(k, d) {
    try {
      return localStorage.getItem(k) ?? d;
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, v);
    } catch {}
  },
};

// ---------- 启动 ----------
boot();

async function boot() {
  const loadingText = $('loading-text');
  try {
    const [{ Stage }] = await Promise.all([import('./scene.js'), initPhysics()]);
    stage = new Stage($('stage'));
    if (new URLSearchParams(location.search).has('debug')) window.__bobing = { stage, get hand() { return hand; }, get session() { return session; } };
  } catch (e) {
    console.error(e);
    loadingText.textContent = '三维场景加载失败：请使用支持 WebGL 的新版浏览器（Chrome / Edge / Safari / Firefox）。';
    return;
  }
  $('loading').hidden = true;
  setupHome();
  setupLobby();
  setupGame();
  setupDialogs();
  showScreen('home');
  const code = new URLSearchParams(location.search).get('room');
  if (code) {
    $('in-code').value = code.toUpperCase().slice(0, 5);
    setMsg('home-msg', '已填好房间号，输入昵称后点“加入”', true);
  }
}

function showScreen(name) {
  for (const s of ['home', 'lobby', 'game']) $(`screen-${s}`).hidden = s !== name;
  if (name !== 'game') stage?.setShot({ kind: 'overview' });
}

function setMsg(id, text, info = false) {
  const el = $(id);
  el.textContent = text || '';
  el.classList.toggle('info', info);
}

// ---------- 首页 ----------
function setupHome() {
  const nameIn = $('in-name');
  nameIn.value = store.get('bobing.name', '');
  nameIn.addEventListener('change', () => store.set('bobing.name', nameIn.value.trim()));
  $('btn-create').onclick = () => startSession('host');
  $('btn-local').onclick = () => startSession('local');
  $('btn-join').onclick = () => startSession('client');
  $('in-code').addEventListener('keydown', (e) => e.key === 'Enter' && startSession('client'));
}

function myIdentity() {
  // 身份放在 sessionStorage：刷新页面可凭同一 id 重回牌桌，同一浏览器开两个标签页也不会冲突
  let id = '';
  try {
    id = sessionStorage.getItem('bobing.id') || '';
    if (!id) {
      id = randomId();
      sessionStorage.setItem('bobing.id', id);
    }
  } catch {
    id ||= randomId();
  }
  const name = $('in-name').value.trim();
  return { id, name };
}

async function startSession(kind) {
  unlockAudio();
  const me = myIdentity();
  if (!me.name) {
    setMsg('home-msg', '先给自己起个昵称吧');
    $('in-name').focus();
    return;
  }
  store.set('bobing.name', me.name);
  const code = $('in-code').value.trim().toUpperCase();
  if (kind === 'client' && !/^[A-Z0-9]{5}$/.test(code)) {
    setMsg('home-msg', '请输入 5 位房间号');
    $('in-code').focus();
    return;
  }
  setButtonsBusy(true);
  setMsg('home-msg', kind === 'client' ? '正在连接房间…' : kind === 'host' ? '正在创建房间…' : '', true);
  const s = kind === 'client' ? new ClientSession({ me, code }) : new HostSession({ mode: kind, me });
  bindSession(s);
  try {
    await s.open();
    session = s;
    if (s.code) history.replaceState(null, '', `?room=${s.code}`);
    setMsg('home-msg', '');
    render(s.state ? structuredClone(s.state) : view);
  } catch (e) {
    console.warn(e);
    s.close?.();
    setMsg('home-msg', friendlyError(e));
  } finally {
    setButtonsBusy(false);
  }
}

function setButtonsBusy(b) {
  for (const id of ['btn-create', 'btn-join', 'btn-local']) $(id).disabled = b;
}

function bindSession(s) {
  s.on('state', (st) => {
    if (s !== session && session) return;
    if (animating) pendingState = st;
    else render(st);
  });
  s.on('roll', (roll) => {
    if (session && s !== session) return;
    playRoll(roll);
  });
  s.on('hold', (h) => {
    if (s === session) onHold(h);
  });
  s.on('warn', (text) => flashMsg(text));
  s.on('error', (text) => {
    if (s !== session) return;
    leave(text);
  });
}

function leave(msg = '') {
  session?.close();
  session = null;
  clearTimeout(grab?.timer);
  clearTimeout(awaiting?.timer);
  grab = null;
  awaiting = null;
  hand.stop();
  stage.setLive(null);
  stage.setAim(null);
  view = null;
  animating = false;
  pendingState = null;
  endShownFor = null;
  $('toast').hidden = true;
  $('dlg-end').open && $('dlg-end').close();
  history.replaceState(null, '', location.pathname);
  showScreen('home');
  setMsg('home-msg', msg);
}

function flashMsg(text) {
  const target = view?.phase === 'lobby' ? 'lobby-msg' : 'home-msg';
  if (view?.phase === 'lobby') setMsg(target, text);
  else showToast({ who: '', main: '', sub: text, cls: 'dim' }, 2200);
}

// ---------- 渲染 ----------
function render(st) {
  if (!st) return;
  const prevPhase = view?.phase;
  view = st;
  if (st.phase === 'lobby') {
    showScreen('lobby');
    renderLobby(st);
    if ($('dlg-end').open) $('dlg-end').close();
    endShownFor = null;
  } else {
    showScreen('game');
    if (prevPhase === 'lobby' && st.lastOutcome == null) stage.setRest([4, 4, 4, 1, 2, 6]);
    renderGame(st);
    if (!animating) directCamera(st);
    if (st.phase === 'ended' && endShownFor !== st.throws) {
      endShownFor = st.throws;
      showEnd(st);
    }
  }
  updateThrowButton();
}

/** 座位方位角：按当前玩家人数均分一圈，镜头站在该座位后方 */
function seatAz(st, playerId) {
  const i = st.players.findIndex((p) => p.id === playerId);
  return Math.PI / 2 + (Math.max(0, i) / Math.max(1, st.players.length)) * Math.PI * 2;
}

/** 镜头跟随：轮到谁就切到谁的座位；本局结束则俯看碗 */
function directCamera(st) {
  const cur = st.players[st.turn];
  if (st.phase === 'ended') stage.setShot({ kind: 'result', az: stage.cam.az });
  else if (cur) stage.setShot({ kind: 'seat', az: seatAz(st, cur.id) });
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function dieIcon(v, out = false) {
  const cells = PIP_CELLS[v] || [];
  let html = '';
  for (let i = 1; i <= 9; i++) html += cells.includes(i) ? '<i></i>' : '<s></s>';
  const cls = ['die-ico', v === 1 || v === 4 ? 'red' : '', v === 1 ? 'one' : '', out ? 'out' : ''].join(' ');
  return `<span class="${cls}" role="img" aria-label="${v}点">${html}</span>`;
}

function diceRow(dice, outMask = []) {
  return `<div class="dice-row">${dice.map((d, i) => dieIcon(d, outMask[i])).join('')}</div>`;
}

function badges(p, st) {
  const b = [];
  if (p.isBot) b.push('<span class="badge bot">电脑</span>');
  if (st.hostId === p.id && session?.mode !== 'local') b.push('<span class="badge host">房主</span>');
  if (p.id === session?.meId && session?.mode !== 'local') b.push('<span class="badge me">我</span>');
  if (!p.online) b.push('<span class="badge off">离线</span>');
  return b.join(' ');
}

function score(p) {
  return Object.entries(p.won).reduce((a, [k, n]) => a + (POINTS[k] || 0) * n, 0);
}

function wonText(p) {
  const parts = PRIZES.filter((x) => p.won[x.id]).map((x) => `${x.name}×${p.won[x.id]}`);
  return parts.join(' ') || '还没博到饼';
}

// ---------- 大厅 ----------
function setupLobby() {
  $('btn-copy').onclick = copyInvite;
  $('btn-add-bot').onclick = () => session?.addBot();
  $('btn-add-local').onclick = () => {
    const name = $('in-local-name').value.trim();
    session?.addLocalPlayer(name);
    $('in-local-name').value = '';
  };
  $('in-local-name').addEventListener('keydown', (e) => e.key === 'Enter' && $('btn-add-local').click());
  $('btn-start').onclick = () => {
    unlockAudio();
    session?.start();
  };
  $('btn-leave').onclick = () => leave();
  $('lobby-players').addEventListener('click', (e) => {
    const id = e.target.closest('[data-kick]')?.dataset.kick;
    if (id) session?.kick(id);
  });
  $('pool-editor').addEventListener('change', () => {
    const pool = {};
    for (const inp of $('pool-editor').querySelectorAll('input')) pool[inp.name] = Number(inp.value);
    session?.setPool(pool);
  });
  $('pool-presets').addEventListener('click', (e) => {
    const k = e.target.dataset.preset;
    if (k) session?.setPool(PRESETS[k]);
  });
}

function renderLobby(st) {
  const host = session?.isHost;
  const local = session?.mode === 'local';
  $('lobby-title').textContent = local ? '单机 / 同屏多人' : host ? '你的房间' : '已加入房间';
  $('share-box').hidden = local;
  $('room-code').textContent = session?.code || st.code || '-----';
  $('player-count').textContent = `${st.players.length} / 8`;
  $('lobby-players').innerHTML = st.players
    .map(
      (p) => `<li><span class="seat-dot" style="background:${SEAT_COLORS[p.seat % 8]}"></span>
        <span class="name">${esc(p.name)}</span>${badges(p, st)}
        ${host && p.id !== session.meId ? `<button class="kick" data-kick="${esc(p.id)}" aria-label="移除 ${esc(p.name)}">×</button>` : ''}</li>`,
    )
    .join('');
  $('host-tools').hidden = !host;
  $('local-add').hidden = !local;
  $('pool-presets').hidden = !host;
  const editor = $('pool-editor');
  if (!editor.contains(document.activeElement)) {
    editor.innerHTML = PRIZES.map((p) =>
      host
        ? `<label>${p.name}<input type="number" name="${p.id}" min="0" max="99" inputmode="numeric" value="${st.pool[p.id]}"></label>`
        : `<label>${p.name}<span class="ro">${st.pool[p.id]}</span></label>`,
    ).join('');
  }
  $('pool-total').textContent = `共 ${totalCakes(st.pool)} 个饼`;
  $('btn-start').hidden = !host;
  $('btn-start').disabled = st.players.length < 1 || totalCakes(st.pool) < 1;
  if (!host) setMsg('lobby-msg', '等待房主开始…', true);
  else if (!local && st.players.length < 2) setMsg('lobby-msg', '邀请朋友加入，或添加电脑玩家', true);
  else setMsg('lobby-msg', '');
}

async function copyInvite() {
  const url = `${location.origin}${location.pathname}?room=${session?.code}`;
  try {
    await navigator.clipboard.writeText(url);
    setMsg('lobby-msg', '邀请链接已复制', true);
  } catch {
    prompt('复制这个邀请链接：', url);
  }
}

// ---------- 对局 ----------
function setupGame() {
  $('btn-exit').onclick = () => {
    if (confirm(session?.isHost && session.mode === 'host' ? '你是房主，离开后房间会解散。确定离开？' : '确定离开牌桌？')) leave();
  };
  $('btn-panel').onclick = () => {
    const open = $('side').classList.toggle('open');
    $('btn-panel').setAttribute('aria-expanded', String(open));
  };
  const mute = $('btn-mute');
  setMuted(store.get('bobing.muted', '0') === '1');
  const syncMute = () => {
    mute.textContent = isMuted() ? '静音中' : '音效';
    mute.setAttribute('aria-pressed', String(isMuted()));
  };
  syncMute();
  mute.onclick = () => {
    unlockAudio();
    setMuted(!isMuted());
    store.set('bobing.muted', isMuted() ? '1' : '0');
    syncMute();
  };
  // 视角：跟随（默认，所有人同一机位）/ 自由（自己拖动）
  const camBtn = $('btn-cam');
  camBtn.onclick = () => {
    const free = !stage.free;
    stage.setFreeCamera(free);
    camBtn.textContent = free ? '视角:自由' : '视角:跟随';
    camBtn.setAttribute('aria-pressed', String(free));
    if (!free && view) directCamera(view);
  };
  setupThrow();
  setupMotion();
}

// ---------- 手机体感摇骰 ----------
// 按住碗 + 晃动手机：手机的加速度直接推动掌心，骰子在里面随之翻滚；松手掷出
let motion = { on: false, a: null, t: 0 };

function setupMotion() {
  const btn = $('btn-motion');
  const touch = matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;
  if (!('DeviceMotionEvent' in window) || !touch) return;
  btn.hidden = false;
  const sync = () => {
    btn.textContent = motion.on ? '体感摇骰：开' : '体感摇骰：关';
    btn.setAttribute('aria-pressed', String(motion.on));
    $('throw-hint').innerHTML = motion.on
      ? '<b>按住</b>碗里的骰子 → <b>晃动手机</b>摇一摇 → <b>松手</b>掷出'
      : '在碗上<b>按住</b>抓起骰子 → <b>拖动</b>摇一摇 → <b>甩一下松手</b>';
  };
  btn.onclick = async () => {
    if (!motion.on && typeof DeviceMotionEvent.requestPermission === 'function') {
      // iOS 13+ 需要在点击里申请权限
      try {
        if ((await DeviceMotionEvent.requestPermission()) !== 'granted') {
          flashMsg('没有获得运动传感器权限，可在系统设置中开启');
          return;
        }
      } catch {
        flashMsg('无法开启体感：浏览器拒绝了传感器权限');
        return;
      }
    }
    motion.on = !motion.on;
    store.set('bobing.motion', motion.on ? '1' : '0');
    sync();
    if (motion.on) navigator.vibrate?.(20);
  };
  // 安卓不需要授权，记住上次的选择；iOS 每次需要点一下授权
  if (store.get('bobing.motion', '0') === '1' && typeof DeviceMotionEvent.requestPermission !== 'function') motion.on = true;
  sync();

  let lp = null; // 含重力时的低通值（用于没有 acceleration 的设备）
  window.addEventListener('devicemotion', (e) => {
    if (!motion.on) return;
    let a = e.acceleration;
    if (!a || a.x == null) {
      const g = e.accelerationIncludingGravity;
      if (!g || g.x == null) return;
      lp = lp ? { x: lp.x * 0.9 + g.x * 0.1, y: lp.y * 0.9 + g.y * 0.1, z: lp.z * 0.9 + g.z * 0.1 } : { x: g.x, y: g.y, z: g.z };
      a = { x: g.x - lp.x, y: g.y - lp.y, z: g.z - lp.z };
    }
    motion.a = { x: a.x || 0, y: a.y || 0, z: a.z || 0 };
    motion.t = performance.now();
  });
}

/** 把手机加速度（设备坐标，m/s²）换算成掌心在世界坐标里受到的加速度（cm/s²） */
function motionToWorld() {
  if (!motion.on || !motion.a || performance.now() - motion.t > 150) return null;
  const ang = ((screen.orientation?.angle ?? window.orientation ?? 0) * Math.PI) / 180;
  const { x, y, z } = motion.a;
  // 设备坐标 → 屏幕坐标（屏幕旋转后 x/y 轴对调）
  const sx = x * Math.cos(ang) - y * Math.sin(ang);
  const sy = x * Math.sin(ang) + y * Math.cos(ang);
  // 屏幕右 = 镜头右方，屏幕上 = 镜头前方（远离玩家），屏幕法线 = 竖直
  const az = stage.cam.az;
  const K = 250; // 1 m/s² 的晃动 → 掌心 250 cm/s² 的推力（经模拟调过，正常晃动约 ±3cm）
  return {
    x: (Math.sin(az) * sx - Math.cos(az) * sy) * K,
    y: z * K * 0.6,
    z: (-Math.cos(az) * sx - Math.sin(az) * sy) * K,
  };
}

function renderGame(st) {
  $('pool-bar').innerHTML = PRIZES.map(
    (p) => `<span class="chip ${st.pool[p.id] ? '' : 'empty'} ${p.id === 'zhuangyuan' ? 'zy' : ''}">${p.name}<b>${st.pool[p.id]}</b></span>`,
  ).join('');

  const zy = st.zy;
  $('zy-box').innerHTML = zy
    ? `当前状元：<span class="zy-name">${esc(zy.name)}</span> · ${esc(zy.label)}${diceRow(zy.dice)}`
    : '状元尚未出现，4个4起可夺状元';

  const cur = st.players[st.turn];
  $('players').innerHTML = st.players
    .map((p) => {
      const cls = [p === cur && st.phase === 'playing' ? 'turn' : '', p.online ? '' : 'off'].join(' ');
      const crown = zy?.playerId === p.id ? ' 👑' : '';
      return `<li class="${cls}"><span class="seat-dot" style="background:${SEAT_COLORS[p.seat % 8]}"></span>
        <span class="pname">${esc(p.name)}${crown} ${badges(p, st)}</span><span class="score">${score(p)}</span>
        <span class="won">${wonText(p)}</span></li>`;
    })
    .join('');

  const log = $('log');
  log.innerHTML = st.log.slice(-30).reverse().map((l) => `<li>${esc(l.text)}</li>`).join('');

  const banner = $('turn-banner');
  if (st.phase === 'ended') {
    banner.textContent = '本局结束';
    banner.classList.remove('mine');
  } else if (cur) {
    const mine = session?.canThrow() && !cur.isBot;
    const who = session?.mode !== 'local' && cur.id === session?.meId ? '你' : cur.name;
    banner.textContent = cur.isBot ? `${cur.name}（电脑）正在掷骰…` : mine ? `轮到${who}掷骰` : `等待 ${cur.name} 掷骰…`;
    banner.classList.toggle('mine', !!mine);
  }
}

function canGrab() {
  return !!session && view?.phase === 'playing' && !animating && !awaiting && $('toast').hidden && !hand.active && session.canThrow();
}

function updateThrowButton() {
  const btn = $('btn-throw');
  const ok = canGrab();
  btn.disabled = !ok;
  btn.textContent = view?.phase === 'ended' ? '本局已结束' : hand.mode === 'hold' ? '摇一摇，松手掷出' : ok ? '一键掷骰' : '等待其他玩家';
  $('throw-hint').hidden = !ok;
  $('power').hidden = hand.mode !== 'hold';
  stage.canvas.classList.toggle('grabbable', ok);
}

// ---------- 手势摇骰 ----------
// 在碗上按住 → 骰子进掌心；拖动摇晃（骰子在掌心里真实碰撞）；甩动并松手 → 掷出
const hand = new HandController();
const HOLD_SEND_MS = 50;
const HOLD_MAX_MS = 12000;
let grab = null; // { pointerId, lastSend, timer, sounds }
let awaiting = null; // 已发出投掷请求，等待房主结果 { t, timer }
let lastBuzz = 0;

function setupThrow() {
  const canvas = stage.canvas;
  stage.onTick = tickHand;
  // 捕获阶段拦截，避免与视角旋转（OrbitControls）冲突：抓骰时不转视角
  window.addEventListener(
    'pointerdown',
    (e) => {
      if (e.target !== canvas) return;
      if (grab) {
        e.stopImmediatePropagation();
        return;
      }
      if (e.button !== 0 || !canGrab()) return;
      const xz = stage.pointerToHand(e.clientX, e.clientY);
      if (!xz || Math.hypot(xz.x, xz.z) > HAND.reach + 2) return;
      e.stopImmediatePropagation();
      e.preventDefault();
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {}
      startGrab(e.pointerId, xz);
    },
    true,
  );
  window.addEventListener(
    'pointermove',
    (e) => {
      if (!grab || e.pointerId !== grab.pointerId) return;
      e.stopImmediatePropagation();
      const xz = stage.pointerToHand(e.clientX, e.clientY);
      if (xz) hand.setTarget(xz);
    },
    true,
  );
  const end = (e) => {
    if (!grab || e.pointerId !== grab.pointerId) return;
    e.stopImmediatePropagation();
    releaseGrab();
  };
  window.addEventListener('pointerup', end, true);
  window.addEventListener('pointercancel', end, true);

  // 一键掷骰（也是键盘与读屏用户的入口）：自动完成抓起、摇晃、掷出
  $('btn-throw').addEventListener('click', autoThrow);
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' || e.repeat || $('screen-game').hidden || document.querySelector('dialog[open]')) return;
    e.preventDefault();
    autoThrow();
  });
}

function autoThrow() {
  if (!canGrab()) return;
  unlockAudio();
  lockThrow();
  session.throwDice({ power: 0.25 + Math.random() * 0.4 });
}

/** 发出投掷请求后锁定，直到结果到达；房主无响应时恢复 */
function lockThrow() {
  clearTimeout(awaiting?.timer);
  awaiting = {
    t: performance.now(),
    timer: setTimeout(() => {
      awaiting = null;
      hand.stop();
      stage.setLive(null);
      flashMsg('房主没有响应，请再试一次');
      updateThrowButton();
    }, 7000),
  };
  updateThrowButton();
}

function startGrab(pointerId, xz) {
  unlockAudio();
  hand.grab(xz);
  hand.setTarget(xz);
  grab = { pointerId, lastSend: 0, sounds: [], timer: setTimeout(releaseGrab, HOLD_MAX_MS) };
  stage.setLive(hand.frame, true);
  const cur = view.players[view.turn];
  $('turn-banner').textContent = `${session.mode === 'local' ? cur.name : '你'}：摇一摇，甩出去`;
  updateThrowButton();
}

function tickHand(dt) {
  if (!hand.active) return;
  if (hand.mode === 'hold') hand.setExternal(motionToWorld());
  const sounds = hand.update(dt);
  for (const s of sounds) {
    playImpact(s.k, s.s);
    if (s.k === 3 && s.s > 0.25 && performance.now() - lastBuzz > 70) {
      lastBuzz = performance.now();
      navigator.vibrate?.(8);
    }
  }
  if (hand.mode !== 'hold') return;
  grab.sounds.push(...sounds.map((s) => [s.k, s.s]));
  stage.setAim({ x: hand.pos.x, z: hand.pos.z });
  const sp = hand.speed01();
  $('power-fill').style.width = `${sp * 100}%`;
  if (motionToWorld() && sp < 0.3) {
    $('power-label').textContent = hand.outside() ? '在碗外！松手会掉桌上' : '晃动中…';
    return sendHold();
  }
  // 阈值对应实测出碗率：约 120 cm/s 以下安全，190 以上明显容易出碗
  $('power-label').textContent = hand.outside() ? '在碗外！松手会掉桌上' : sp < 0.3 ? '轻摇' : sp < 0.58 ? '摇得正好' : sp < 0.88 ? '用力' : '太猛，小心出碗';
  sendHold();
}

/** 摇骰画面同步给其他玩家（20Hz） */
function sendHold() {
  const now = performance.now();
  if (now - grab.lastSend < HOLD_SEND_MS) return;
  grab.lastSend = now;
  session.sendHold({ f: encodeFrames(hand.frame), s: grab.sounds.splice(0, 8) });
}

function releaseGrab() {
  if (!grab) return;
  clearTimeout(grab.timer);
  grab = null;
  const init = hand.release();
  stage.setAim(null);
  if (!init) return updateThrowButton();
  // 松手后继续本地预测（骰子立即飞出），同时请求房主给出权威结果
  stage.setLive(hand.frame, false);
  lockThrow();
  session.throwDice({ init: init.map((v) => Math.round(v * 1000) / 1000) });
}

// ---------- 回放与结果 ----------
async function playRoll(roll) {
  animating = true;
  pendingState = null;
  $('toast').hidden = true;
  // 本机刚松手：从已预测的进度接上权威轨迹；观战者从最后看到的摇骰画面接上
  const mine = !!awaiting && roll.mode === 'init';
  const opts = mine
    ? { startAt: Math.min(roll.duration, (performance.now() - awaiting.t) / 1000), blend: 180 }
    : roll.mode === 'init'
      ? { blend: 200 }
      : { lead: PICKUP_MS, blend: PICKUP_MS, arc: true };
  clearTimeout(awaiting?.timer);
  awaiting = null;
  hand.stop();
  if (roll.before) render(roll.before);
  $('btn-throw').disabled = true;
  $('throw-hint').hidden = true;
  const cur = roll.before?.players.find((p) => p.id === roll.outcome.playerId);
  $('turn-banner').textContent = `${cur?.name ?? ''} 掷骰中…`;
  $('turn-banner').classList.remove('mine');
  if (roll.mode !== 'init') playShake();
  // 投掷时镜头站在投掷者身后（本机已在该机位则不动）
  if (roll.before) stage.setShot({ kind: 'seat', az: seatAz(roll.before, roll.outcome.playerId) }, 600);
  await stage.playRoll(roll, (ev) => playImpact(ev.k, ev.s), opts);
  // 骰子停稳：推近俯看点数
  stage.setShot({ kind: 'result', az: stage.cam.az }, 700);
  const info = describe(roll.outcome, roll.outMask);
  showToast(info, 2000);
  if (info.level >= 0) playChime(info.level);
  else playFail();
  if (info.level === 2) confetti();
  await wait(2000);
  animating = false;
  render(pendingState || roll.after);
  pendingState = null;
}

/** 观战：他人正在摇骰 */
function onHold(h) {
  if (animating || hand.active) return;
  stage.pushHold(h.frame);
  for (const [k, s] of h.sounds) setTimeout(() => playImpact(k, s), Math.random() * HOLD_SEND_MS);
  const cur = view?.players[view.turn];
  if (cur) {
    $('turn-banner').textContent = `${cur.name} 正在摇骰…`;
    $('turn-banner').classList.remove('mine');
  }
}

function describe(o, outMask) {
  const who = o.name;
  const r = o.result;
  const a = o.award;
  const dice = diceRow(o.dice, outMask);
  switch (a.type) {
    case 'void':
      return { who, main: '出碗了', sub: '骰子掉出碗外，本轮作废', cls: 'dim', dice, level: -1 };
    case 'none':
      return { who, main: '没中', sub: '下次好运', cls: 'dim', dice, level: -1 };
    case 'prize':
      return { who, main: r.name, sub: `得一个${r.name}饼（${PRIZE_BY_ID[r.prize].alias}）`, dice, level: r.prize === 'duitang' || r.prize === 'sanhong' ? 1 : 0 };
    case 'exhausted':
      return { who, main: r.name, sub: `${r.name}饼已博完，可惜`, cls: 'dim', dice, level: -1 };
    case 'zy-new':
      return { who, main: r.name, sub: '夺得状元！', cls: 'big', dice, level: 2 };
    case 'zy-steal':
      return { who, main: r.name, sub: `从 ${a.from} 手中抢走状元！`, cls: 'big', dice, level: 2 };
    case 'zy-self':
      return { who, main: r.name, sub: '状元仍在你手中', cls: 'big', dice, level: 1 };
    case 'zy-keep':
      return { who, main: r.name, sub: `没能大过 ${a.holder} 的状元`, dice, level: 0 };
    default:
      return { who, main: '', sub: '', dice, level: -1 };
  }
}

let toastTimer = null;
function showToast(info, ms) {
  const t = $('toast');
  t.className = `toast ${info.cls || ''}`;
  t.innerHTML = `${info.who ? `<div class="t-who">${esc(info.who)}</div>` : ''}${info.main ? `<div class="t-main">${esc(info.main)}</div>` : ''}
    <div class="t-sub">${esc(info.sub)}</div>${info.dice || ''}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.hidden = true;
    updateThrowButton();
  }, ms);
}

function confetti() {
  const box = $('confetti');
  const colors = ['#f6d98a', '#e7b75a', '#e63b2e', '#fff3c9', '#ff8a3d'];
  for (let i = 0; i < 70; i++) {
    const el = document.createElement('i');
    el.style.left = `${Math.random() * 100}%`;
    el.style.background = colors[i % colors.length];
    el.style.setProperty('--dx', `${(Math.random() - 0.5) * 200}px`);
    el.style.setProperty('--r', `${Math.random() * 900 - 450}deg`);
    el.style.animationDuration = `${1.8 + Math.random() * 1.6}s`;
    el.style.animationDelay = `${Math.random() * 0.4}s`;
    box.appendChild(el);
  }
  setTimeout(() => (box.innerHTML = ''), 4000);
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------- 结算与规则 ----------
function showEnd(st) {
  const ranked = [...st.players].sort((a, b) => (b.id === st.zy?.playerId) - (a.id === st.zy?.playerId) || score(b) - score(a));
  $('end-zy').innerHTML = st.zy ? `状元：<b>${esc(st.zy.name)}</b>（${esc(st.zy.label)}）${diceRow(st.zy.dice)}` : '';
  $('end-rank').innerHTML = ranked
    .map((p, i) => `<tr><td>${i + 1}</td><td>${esc(p.name)}</td><td>${wonText(p)}</td><td>${score(p)}</td></tr>`)
    .join('');
  const host = session?.isHost;
  $('btn-rematch').hidden = !host;
  $('end-wait').hidden = host;
  $('dlg-end').showModal();
}

function setupDialogs() {
  document.addEventListener('click', (e) => {
    const id = e.target.closest('[data-open]')?.dataset.open;
    if (id) $(id).showModal();
  });
  $('btn-end-home').onclick = () => leave();
  $('btn-end-close').onclick = () => $('dlg-end').close();
  $('btn-rematch').onclick = () => {
    $('dlg-end').close();
    session?.rematch();
  };
  $('rules-body').innerHTML = `
    <h3>怎么玩</h3>
    <ol>
      <li>轮到你时，在碗上按住抓起骰子，拖动摇一摇（骰子在掌心里真的会碰撞），再顺势一甩松手。也可以点“一键掷骰”或按空格。</li>
      <li>甩得越猛骰子越乱，也越容易蹦出碗外；在碗外松手会直接落到桌上。有骰子掉出碗外，本轮作废。</li>
      <li>状元可被更大的状元抢走；其余奖项博到即得。</li>
      <li>同时满足多个奖项，按最高奖项算；奖品拿完即止，最后的状元带走状元饼。</li>
    </ol>
    <h3>奖项从小到大</h3>
    <table class="prize-table">${[...PRIZES].reverse().map((p) => `<tr><td>${p.name}</td><td>${p.desc}</td><td>${p.count} 个</td></tr>`).join('')}</table>
    <h3>状元等级（从小到大）</h3>
    <table class="prize-table">${ZY_LEVELS.map((l) => `<tr><td>${l.name}</td><td>${l.desc}</td></tr>`).join('')}</table>
    <p class="hint">各地博饼的状元细则略有差异，这里按“博饼一图流”：六杯红全场最大，其次状元插金花。</p>`;
}
