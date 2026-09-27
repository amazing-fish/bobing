// 会话层：房主端权威运行对局与物理，客户端只发送"投掷"请求并回放房主广播的轨迹。
// 联机基于 PeerJS（WebRTC 点对点，信令用 PeerJS 公共服务器），无需自建后端，适合 GitHub Pages。
import { BobingGame } from './game.js';
import { encodeFrames, decodeFrames, PICKUP_MS, STRIDE } from './physics.js';
import { runSim, warmSim } from './sim-runner.js';

export const PEER_PREFIX = 'bobing-cn-';
const SEATS = 8;
const REVEAL_MS = 2200; // 骰子停稳后展示结果的时间
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const PEER_OPTS = {
  debug: 1,
  config: {
    iceServers: [
      { urls: 'stun:stun.miwifi.com:3478' },
      { urls: 'stun:stun.cloudflare.com:3478' },
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: ['turn:eu-0.turn.peerjs.com:3478', 'turn:us-0.turn.peerjs.com:3478'], username: 'peerjs', credential: 'peerjsp' },
    ],
  },
};
const BOT_NAMES = ['阿福', '小月', '桂花', '团圆', '玉兔', '嫦娥', '吴刚', '招财'];

export function randomCode(n = 5) {
  let s = '';
  const buf = new Uint32Array(n);
  crypto.getRandomValues(buf);
  for (const v of buf) s += CODE_CHARS[v % CODE_CHARS.length];
  return s;
}

export function randomId() {
  return crypto.randomUUID ? crypto.randomUUID() : `id-${Date.now().toString(36)}-${randomCode(8)}`;
}

class Emitter {
  constructor() {
    this.handlers = {};
  }
  on(ev, fn) {
    (this.handlers[ev] ??= []).push(fn);
    return this;
  }
  emit(ev, ...args) {
    for (const fn of this.handlers[ev] || []) fn(...args);
  }
}

/**
 * 房主（也用于单机模式）：持有权威对局状态，运行物理仿真
 * mode: 'local' 同屏多人 | 'host' 联机房主
 */
export class HostSession extends Emitter {
  constructor({ mode, me, pool }) {
    super();
    this.mode = mode;
    this.isHost = true;
    this.meId = me.id;
    this.code = null;
    this.game = new BobingGame(pool);
    this.game.addPlayer({ id: me.id, name: me.name });
    this.game.state.hostId = me.id;
    warmSim();
    this.busy = false;
    this.queued = null;
    this.seq = 0;
    this.botTimer = null;
    this.conns = new Map(); // playerId -> { conn, lastSeen }
    this.peer = null;
  }

  get state() {
    return this.game.state;
  }

  async open() {
    if (this.mode === 'local') {
      this.emit('state', this.game.snapshot());
      return;
    }
    for (let attempt = 0; attempt < 4; attempt++) {
      const code = randomCode();
      try {
        this.peer = await openPeer(PEER_PREFIX + code);
        this.code = code;
        break;
      } catch (e) {
        if (e?.type !== 'unavailable-id' || attempt === 3) throw e;
      }
    }
    this.game.state.code = this.code;
    this.peer.on('connection', (conn) => this.onConn(conn));
    this.peer.on('disconnected', () => {
      // 与信令服务器断开不影响已建立的连接，但新玩家无法加入，尝试重连
      setTimeout(() => this.peer && !this.peer.destroyed && this.peer.reconnect(), 1500);
    });
    this.peer.on('error', (e) => this.emit('warn', friendlyError(e)));
    this.presence = setInterval(() => this.checkPresence(), 4000);
    this.emit('state', this.game.snapshot());
  }

  close() {
    this.closed = true;
    clearTimeout(this.botTimer);
    clearTimeout(this.lockTimer);
    clearInterval(this.presence);
    for (const { conn } of this.conns.values()) conn.close();
    this.conns.clear();
    this.peer?.destroy();
    this.peer = null;
  }

  onConn(conn) {
    conn.on('data', (msg) => this.onMsg(conn, msg));
    conn.on('close', () => this.onClose(conn));
    conn.on('error', () => this.onClose(conn));
  }

  onMsg(conn, msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'hello') {
      const id = String(msg.id || '').slice(0, 64);
      const name = String(msg.name || '玩家').slice(0, 12);
      if (!id) return;
      const known = this.game.players.find((p) => p.id === id);
      if (!known && this.game.players.length >= SEATS) {
        conn.send({ type: 'full' });
        setTimeout(() => conn.close(), 300);
        return;
      }
      const old = this.conns.get(id);
      if (old && old.conn !== conn) old.conn.close();
      conn.playerId = id;
      this.conns.set(id, { conn, lastSeen: Date.now() });
      this.game.addPlayer({ id, name });
      this.game.pushLog(known ? `${name} 回到了牌桌` : `${name} 加入了房间`);
      conn.send({ type: 'welcome', id, state: this.game.snapshot() });
      this.afterChange();
      return;
    }
    const id = conn.playerId;
    const entry = id && this.conns.get(id);
    if (!entry) return;
    entry.lastSeen = Date.now();
    if (msg.type === 'throw') this.requestThrow(id, { init: msg.init, power: Number(msg.power) });
    else if (msg.type === 'hold') this.relayHold(id, msg);
  }

  onClose(conn) {
    const id = conn.playerId;
    if (!id || this.conns.get(id)?.conn !== conn) return;
    this.conns.delete(id);
    const p = this.game.players.find((x) => x.id === id);
    if (!p) return;
    // 对局中只标记离线并跳过其回合；大厅中直接移除
    this.game.removePlayer(id);
    this.game.pushLog(`${p.name} 离开了`);
    this.afterChange();
  }

  checkPresence() {
    const now = Date.now();
    for (const { conn, lastSeen } of this.conns.values()) {
      if (now - lastSeen > 15000) conn.close();
      else if (conn.open) conn.send({ type: 'ping' });
    }
  }

  broadcast(msg) {
    for (const { conn } of this.conns.values()) if (conn.open) conn.send(msg);
  }

  afterChange() {
    const snap = this.game.snapshot();
    this.emit('state', snap);
    this.broadcast({ type: 'state', state: snap });
    this.scheduleBot();
  }

  scheduleBot() {
    clearTimeout(this.botTimer);
    const s = this.state;
    const p = this.game.currentPlayer();
    if (s.phase !== 'playing' || this.busy || !p?.isBot) return;
    this.botTimer = setTimeout(() => this.requestThrow(p.id, { power: 0.25 + Math.random() * 0.5 }), 700 + Math.random() * 700);
  }

  /** 本机玩家能否投掷 */
  canThrow() {
    const p = this.game.currentPlayer();
    if (this.state.phase !== 'playing' || this.busy || !p || p.isBot) return false;
    return this.mode === 'local' ? true : p.id === this.meId;
  }

  /** 本机投掷：payload 为 {init}（手势松手状态）或 {power}（一键掷骰） */
  throwDice(payload) {
    const p = this.game.currentPlayer();
    if (!p) return;
    this.requestThrow(this.mode === 'local' ? p.id : this.meId, payload);
  }

  /** 本机摇骰画面同步给其他人 */
  sendHold(h) {
    if (this.mode === 'host') this.broadcast({ type: 'hold', ...h });
  }

  /** 转发客户端的摇骰画面（只转发当前玩家的） */
  relayHold(fromId, msg) {
    const p = this.game.currentPlayer();
    if (this.busy || this.state.phase !== 'playing' || p?.id !== fromId) return;
    if (typeof msg.f !== 'string' || msg.f.length > 200) return;
    let frame;
    try {
      frame = decodeFrames(msg.f);
    } catch {
      return;
    }
    if (frame.length !== STRIDE) return;
    const sounds = sanitizeSounds(msg.s);
    for (const [id, { conn }] of this.conns) if (id !== fromId && conn.open) conn.send({ type: 'hold', f: msg.f, s: sounds });
    this.emit('hold', { frame, sounds });
  }

  async requestThrow(playerId, payload) {
    const s = this.state;
    const p = this.game.currentPlayer();
    if (s.phase !== 'playing' || !p || p.id !== playerId) return;
    if (this.busy) {
      // 上一次投掷的结果还在展示，下一位已经出手：解锁后立即处理
      this.queued = { playerId, payload };
      return;
    }
    this.busy = true;
    clearTimeout(this.botTimer);
    const init = Array.isArray(payload?.init) ? payload.init : null;
    let sim;
    try {
      // 出手方向与镜头机位一致：按玩家在列表中的位置均分一圈（与 main.js 的 seatAz 对应）
      const seat = this.game.players.indexOf(p);
      const seats = this.game.players.length;
      sim = await runSim(init ? { init } : { power: Number.isFinite(payload?.power) ? payload.power : 0.5, seat, seats });
    } catch (e) {
      this.busy = false;
      this.emit('warn', `投掷失败：${e.message}`);
      this.afterChange();
      return;
    }
    // 仿真期间可能有人掉线导致换人
    if (this.closed || this.state.phase !== 'playing' || this.game.currentPlayer()?.id !== playerId) {
      this.busy = false;
      this.afterChange();
      return;
    }
    const before = this.game.snapshot();
    const outcome = this.game.applyRoll(p.id, { dice: sim.dice, out: sim.out });
    const after = this.game.snapshot();
    this.seq++;
    const roll = {
      seq: this.seq,
      mode: init ? 'init' : 'script',
      fps: sim.fps,
      frameCount: sim.frameCount,
      holdFrames: sim.holdFrames,
      sounds: sim.sounds,
      outMask: sim.outMask,
      duration: sim.duration,
      outcome,
      before,
      after,
    };
    this.emit('roll', { ...roll, frames: sim.frames });
    this.broadcast({ type: 'roll', ...roll, frames: encodeFrames(sim.frames) });
    const lead = init ? 0 : PICKUP_MS;
    this.lockTimer = setTimeout(() => {
      this.busy = false;
      const q = this.queued;
      this.queued = null;
      if (q && this.game.currentPlayer()?.id === q.playerId) {
        this.requestThrow(q.playerId, q.payload);
        return;
      }
      // 解锁后广播一次状态，让各端刷新"能否投掷"
      this.afterChange();
    }, lead + sim.duration * 1000 + REVEAL_MS);
  }

  // ---------- 房主操作 ----------
  guard(fn) {
    try {
      fn();
      this.afterChange();
    } catch (e) {
      this.emit('warn', e.message);
    }
  }

  addBot() {
    this.guard(() => {
      const used = new Set(this.game.players.map((p) => p.name));
      const name = BOT_NAMES.find((n) => !used.has(n)) || `电脑${this.game.players.length}`;
      this.game.addPlayer({ id: `bot-${randomCode(6)}`, name, isBot: true });
    });
  }

  addLocalPlayer(name) {
    this.guard(() => this.game.addPlayer({ id: `local-${randomCode(6)}`, name: name || `玩家${this.game.players.length + 1}` }));
  }

  kick(id) {
    if (id === this.meId) return;
    const entry = this.conns.get(id);
    if (entry) {
      entry.conn.send({ type: 'kicked' });
      this.conns.delete(id);
      setTimeout(() => entry.conn.close(), 300);
    }
    this.guard(() => this.game.removePlayer(id));
  }

  setPool(pool) {
    this.guard(() => this.game.setPool(pool));
  }

  start() {
    this.guard(() => this.game.start());
  }

  rematch() {
    this.guard(() => {
      // 离线的真人不保留；电脑与在线玩家留在房间
      this.game.rematch();
    });
  }
}

/** 联机客户端：发送投掷请求，接收状态与轨迹 */
export class ClientSession extends Emitter {
  constructor({ me, code }) {
    super();
    this.mode = 'client';
    this.isHost = false;
    this.meId = me.id;
    this.me = me;
    this.code = code;
    this.state = null;
    this.lastMsg = Date.now();
  }

  async open() {
    this.peer = await openPeer();
    const conn = this.peer.connect(PEER_PREFIX + this.code, { reliable: true, serialization: 'json' });
    this.conn = conn;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject({ type: 'timeout' }), 15000);
      conn.on('open', () => {
        clearTimeout(timer);
        resolve();
      });
      this.peer.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
    const welcome = new Promise((resolve, reject) => {
      this.welcomeWait = { resolve, reject };
      setTimeout(() => reject({ type: 'timeout' }), 10000);
    });
    conn.on('data', (msg) => this.onMsg(msg));
    conn.on('close', () => this.lost('与房主的连接已断开'));
    conn.send({ type: 'hello', id: this.me.id, name: this.me.name });
    await welcome;
    this.ping = setInterval(() => {
      if (conn.open) conn.send({ type: 'ping' });
      if (Date.now() - this.lastMsg > 20000) this.lost('房主长时间无响应');
    }, 4000);
  }

  lost(text) {
    if (this.closed) return;
    this.close();
    this.emit('error', text);
  }

  close() {
    this.closed = true;
    clearInterval(this.ping);
    this.conn?.close();
    this.peer?.destroy();
  }

  onMsg(msg) {
    if (!msg || typeof msg !== 'object') return;
    this.lastMsg = Date.now();
    switch (msg.type) {
      case 'welcome':
        this.state = msg.state;
        this.welcomeWait?.resolve();
        this.emit('state', msg.state);
        break;
      case 'state':
        this.state = msg.state;
        this.emit('state', msg.state);
        break;
      case 'roll':
        this.state = msg.after;
        this.emit('roll', { ...msg, frames: decodeFrames(msg.frames) });
        break;
      case 'hold':
        try {
          const frame = decodeFrames(msg.f);
          if (frame.length === STRIDE) this.emit('hold', { frame, sounds: sanitizeSounds(msg.s) });
        } catch {}
        break;
      case 'full':
        this.welcomeWait?.reject({ type: 'full' });
        break;
      case 'kicked':
        this.lost('你已被房主移出房间');
        break;
    }
  }

  canThrow() {
    const s = this.state;
    const p = s?.players[s.turn];
    return s?.phase === 'playing' && p?.id === this.meId;
  }

  throwDice(payload) {
    if (this.conn?.open) this.conn.send({ type: 'throw', ...payload });
  }

  sendHold(h) {
    if (this.conn?.open) this.conn.send({ type: 'hold', ...h });
  }
}

function sanitizeSounds(list) {
  if (!Array.isArray(list)) return [];
  return list
    .slice(0, 8)
    .filter((x) => Array.isArray(x) && [0, 1, 2, 3].includes(x[0]) && Number.isFinite(x[1]))
    .map(([k, s]) => [k, Math.min(1, Math.max(0, s))]);
}

function openPeer(id) {
  const Peer = globalThis.Peer;
  if (!Peer) return Promise.reject({ type: 'no-peerjs' });
  return new Promise((resolve, reject) => {
    const peer = id ? new Peer(id, PEER_OPTS) : new Peer(PEER_OPTS);
    const timer = setTimeout(() => {
      peer.destroy();
      reject({ type: 'timeout' });
    }, 15000);
    peer.once('open', () => {
      clearTimeout(timer);
      resolve(peer);
    });
    peer.once('error', (e) => {
      clearTimeout(timer);
      peer.destroy();
      reject(e);
    });
  });
}

export function friendlyError(e) {
  const type = e?.type || '';
  const map = {
    'peer-unavailable': '房间不存在或房主已离开',
    'unavailable-id': '房间号被占用，请重试',
    network: '无法连接信令服务器，请检查网络',
    'server-error': '信令服务器出错，请稍后再试',
    'socket-error': '无法连接信令服务器，请检查网络',
    'browser-incompatible': '当前浏览器不支持 WebRTC',
    timeout: '连接超时，请检查网络或房间号',
    full: '房间已满（最多 8 人）',
    'no-peerjs': '联机组件加载失败',
  };
  return map[type] || (typeof e === 'string' ? e : e?.message || '连接失败');
}
