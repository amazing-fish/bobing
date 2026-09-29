// 会话层：房主端权威运行对局与物理，客户端只发送"投掷"请求并回放房主广播的轨迹。
// 传输见 net.js：公共 MQTT 服务器负责找房间与兜底中转，能直连时自动升级为 WebRTC，无需自建后端。
import { BobingGame } from './game.js';
import { encodeFrames, decodeFrames, PICKUP_MS, STRIDE } from './physics.js';
import { runSim, warmSim } from './sim-runner.js';
import { Emitter, HostHub, joinRoom, CODE_CHARS, CODE_LEN } from './net.js';

export { CODE_LEN };

const SEATS = 8;
const REVEAL_MS = 2200; // 骰子停稳后展示结果的时间
const PING_MS = 3000;
const SILENT_MS = 20000; // 这么久收不到对方任何消息，认为连接已断
const SUSPEND_MS = 8000; // 本机计时器停摆这么久（锁屏、切后台），说明是自己睡着了，不怪对方
const GRACE_MS = 30000; // 客人断线后保留座位多久（期间重连不打扰对局）
const RECONNECT_MS = 90000; // 客人自动重连的最长时间
const HELLO_RETRY_MS = 2000; // 入座请求走的是可丢的通道：没等到欢迎就重发
const BOT_NAMES = ['阿福', '小月', '桂花', '团圆', '玉兔', '嫦娥', '吴刚', '招财'];

export function randomCode(n = 5) {
  let s = '';
  const buf = new Uint32Array(n);
  crypto.getRandomValues(buf);
  for (const v of buf) s += CODE_CHARS[v % CODE_CHARS.length];
  return s;
}

/** 用户输入/链接里的房间号 → 规范形式（去掉分隔符、转大写）；不合法返回 null */
export function normalizeCode(s) {
  const c = String(s || '').toUpperCase().replace(/[\s-]/g, '');
  return c.length === CODE_LEN && [...c].every((ch) => CODE_CHARS.includes(ch)) ? c : null;
}

/** 展示用：ABCDE-FGHJK */
export function formatCode(c) {
  return c ? `${c.slice(0, 5)}-${c.slice(5)}` : '';
}

export function randomId() {
  return crypto.randomUUID ? crypto.randomUUID() : `id-${Date.now().toString(36)}-${randomCode(8)}`;
}

/** 页面从后台回到前台时回调（Node 测试环境下什么也不做） */
function onVisible(fn) {
  if (typeof document === 'undefined') return () => {};
  const h = () => document.visibilityState === 'visible' && fn();
  document.addEventListener('visibilitychange', h);
  return () => document.removeEventListener('visibilitychange', h);
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
    this.rev = 0; // 状态版本号：客人据此发现自己漏了消息
    this.botTimer = null;
    this.conns = new Map(); // playerId -> { conn, lastSeen }
    this.grace = new Map(); // playerId -> 断线保留座位的计时器
    // 玩家 id 是公开的（在对局状态里），所以每个 id 绑定一把只有本人知道的密钥：
    // 客人第一次入座时绑定，之后凭同一把密钥才能以这个身份重连；房主、电脑、同屏玩家的 id 不接受外来入座
    this.keys = new Map();
    this.kicked = new Set(); // 被房主移出的玩家 id：本房间内不再接受（"已被移出"的通知可能丢了，客人会自动重连）
    this.keys.set(me.id, null);
    this.hub = null;
    this.status = 'online';
  }

  get state() {
    return this.game.state;
  }

  async open() {
    if (this.mode === 'local') {
      this.emit('state', this.game.snapshot());
      return;
    }
    this.hub = new HostHub((link) => this.onConn(link));
    await this.hub.start();
    this.code = this.hub.code;
    this.game.state.code = this.code;
    this.lastTick = Date.now();
    this.presence = setInterval(() => this.checkPresence(), PING_MS);
    this.offVisible = onVisible(() => this.checkPresence());
    this.emit('state', this.game.snapshot());
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.botTimer);
    clearTimeout(this.lockTimer);
    clearInterval(this.presence);
    this.offVisible?.();
    for (const t of this.grace.values()) clearTimeout(t);
    for (const { conn } of this.conns.values()) {
      if (conn.open) conn.send({ type: 'closed' });
      conn.close();
    }
    this.conns.clear();
    this.hub?.close();
    this.hub = null;
  }

  /** 新连接（net.js 的 Link，测试里是假连接）：收到 hello 之后才算入座 */
  onConn(conn) {
    conn.on('data', (msg) => this.onMsg(conn, msg));
    conn.on('close', () => this.onClose(conn));
    // 房主这边的服务器重连了：发个心跳，客人比对版本号，漏了就来要最新状态
    conn.on('resume', () => conn.playerId && conn.send({ type: 'ping', rev: this.rev }));
  }

  onMsg(conn, msg) {
    if (!msg || typeof msg !== 'object' || this.closed) return;
    if (msg.type === 'hello') {
      const id = String(msg.id || '').slice(0, 64);
      const name = String(msg.name || '玩家').slice(0, 12);
      const key = typeof msg.key === 'string' ? msg.key.slice(0, 128) : '';
      if (!id) return;
      if (this.kicked.has(id)) {
        conn.send({ type: 'kicked' });
        setTimeout(() => conn.close(), 300);
        return;
      }
      // 冒用别人的 id（id 在对局状态里人人可见）：拒绝
      if (key.length < 16 || (this.keys.has(id) && this.keys.get(id) !== key)) {
        conn.send({ type: 'denied' });
        setTimeout(() => conn.close(), 300);
        return;
      }
      const known = this.game.players.find((p) => p.id === id);
      if (!known && this.game.players.length >= SEATS) {
        conn.send({ type: 'full' });
        setTimeout(() => conn.close(), 300);
        return;
      }
      this.keys.set(id, key);
      const old = this.conns.get(id);
      conn.playerId = id;
      this.conns.set(id, { conn, lastSeen: Date.now() });
      if (old && old.conn !== conn) old.conn.close();
      const graced = this.grace.has(id);
      clearTimeout(this.grace.get(id));
      this.grace.delete(id);
      const wasOnline = known?.online && (graced || old);
      this.game.addPlayer({ id, name });
      // 短暂断线后重连：座位一直保留着，不刷屏
      if (!wasOnline) this.game.pushLog(known ? `${name} 回到了牌桌` : `${name} 加入了房间`);
      conn.send({ type: 'welcome', id, rev: this.rev, state: this.game.snapshot() });
      this.afterChange();
      return;
    }
    const id = conn.playerId;
    const entry = id && this.conns.get(id);
    if (!entry || entry.conn !== conn) return;
    entry.lastSeen = Date.now();
    switch (msg.type) {
      case 'ping':
        conn.send({ type: 'pong', rev: this.rev });
        break;
      case 'sync':
        conn.send({ type: 'state', rev: this.rev, state: this.game.snapshot() });
        break;
      case 'leave':
        conn.leaving = true;
        conn.close();
        break;
      case 'throw':
        this.requestThrow(id, { init: msg.init, power: Number(msg.power) });
        break;
      case 'hold':
        this.relayHold(id, msg);
        break;
    }
  }

  onClose(conn) {
    const id = conn.playerId;
    if (!id || this.conns.get(id)?.conn !== conn) return;
    this.conns.delete(id);
    if (!this.game.players.some((p) => p.id === id)) return;
    // 主动离开立即下线；意外断线先保留座位，给对方自动重连的时间
    if (conn.leaving || this.closed) return this.dropPlayer(id);
    clearTimeout(this.grace.get(id));
    this.grace.set(id, setTimeout(() => this.dropPlayer(id), GRACE_MS));
  }

  dropPlayer(id) {
    clearTimeout(this.grace.get(id));
    this.grace.delete(id);
    if (this.conns.has(id)) return;
    const p = this.game.players.find((x) => x.id === id);
    if (!p || this.closed) return;
    // 对局中只标记离线并跳过其回合；大厅中直接移除
    this.game.removePlayer(id);
    this.game.pushLog(`${p.name} 离开了`);
    this.afterChange();
  }

  checkPresence() {
    const now = Date.now();
    // 房主自己刚从锁屏/后台醒来：大家的消息都还没来得及到，重新计时而不是把所有人踢掉
    if (now - (this.lastTick ?? now) > SUSPEND_MS) for (const e of this.conns.values()) e.lastSeen = now;
    this.lastTick = now;
    for (const { conn, lastSeen } of this.conns.values()) {
      if (now - lastSeen > SILENT_MS) conn.close();
      else if (conn.open) conn.send({ type: 'ping', rev: this.rev });
    }
  }

  broadcast(msg) {
    for (const { conn } of this.conns.values()) if (conn.open) conn.send(msg);
  }

  afterChange() {
    const snap = this.game.snapshot();
    this.rev++;
    this.emit('state', snap);
    this.broadcast({ type: 'state', rev: this.rev, state: snap });
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
    if (this.mode === 'host') this.fanoutHold({ type: 'hold', from: this.meId, f: h.f, s: sanitizeSounds(h.s) }, null);
  }

  /** 摇骰画面是高频消息：可丢、不排队；中转的客人共用一条广播 */
  fanoutHold(msg, exceptId) {
    const except = this.conns.get(exceptId)?.conn;
    if (this.hub) return this.hub.broadcastLossy(msg, except?.cid);
    for (const [id, { conn }] of this.conns) if (id !== exceptId && conn.open) conn.send(msg, { lossy: true });
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
    this.fanoutHold({ type: 'hold', from: fromId, f: msg.f, s: sounds }, fromId);
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
    this.rev++;
    this.broadcast({ type: 'roll', rev: this.rev, ...roll, frames: encodeFrames(sim.frames) });
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
      const id = `bot-${randomCode(6)}`;
      this.keys.set(id, null);
      this.game.addPlayer({ id, name, isBot: true });
    });
  }

  addLocalPlayer(name) {
    const id = `local-${randomCode(6)}`;
    this.keys.set(id, null);
    this.guard(() => this.game.addPlayer({ id, name: name || `玩家${this.game.players.length + 1}` }));
  }

  kick(id) {
    if (id === this.meId) return;
    const entry = this.conns.get(id);
    if (entry) {
      entry.conn.send({ type: 'kicked' });
      this.conns.delete(id);
      setTimeout(() => entry.conn.close(), 300);
    }
    clearTimeout(this.grace.get(id));
    this.grace.delete(id);
    if (this.game.players.some((p) => p.id === id && !p.isBot && !id.startsWith('local-'))) this.kicked.add(id);
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

/**
 * 联机客户端：发送投掷请求，接收状态与轨迹。
 * 连接意外中断时自动重连（同一个玩家 id 回到原座位），期间 status = 'reconnecting'
 */
export class ClientSession extends Emitter {
  constructor({ me, code, join = joinRoom }) {
    super();
    this.join = join;
    this.mode = 'client';
    this.isHost = false;
    this.meId = me.id;
    this.me = me;
    this.code = code;
    this.state = null;
    this.rev = 0;
    this.link = null;
    this.status = 'connecting';
  }

  /** 'p2p' 直连 | 'relay' 服务器中转 */
  get linkKind() {
    return this.link?.kind || null;
  }

  async open() {
    await this.connect();
    this.lastTick = Date.now();
    this.timer = setInterval(() => this.tick(), PING_MS);
    this.offVisible = onVisible(() => this.tick());
    // 不在 pagehide 时通知离开：刷新、前进后退也会触发它，而刷新后同一身份会马上回来。
    // 关页面按意外断线处理（保留座位 30 秒）；只有点"离开"才立即下线（见 close）
  }

  async connect() {
    const link = await this.join(this.code);
    if (this.closed) return link.close();
    this.link = link;
    this.lastMsg = Date.now();
    // 每次连接各自等待欢迎：重连循环可能已经换上了新连接，旧连接的失败不能波及它
    let wait;
    const welcome = new Promise((resolve, reject) => {
      wait = this.welcomeWait = { resolve, reject };
      setTimeout(() => reject({ type: 'timeout' }), 10000);
    });
    link.on('data', (msg) => link === this.link && this.onMsg(msg));
    link.on('close', () => {
      if (link !== this.link) return;
      // 还在等欢迎（或欢迎刚到、connect 还没往下走）：交给 connect 处理，它会让本次连接失败
      if (this.welcomeWait === wait) return wait.reject({ type: 'network' });
      this.dropped();
    });
    link.on('kind', () => link === this.link && this.emit('net', this.status));
    link.on('resume', () => {
      if (link !== this.link) return;
      this.setStatus('online');
      this.lastSync = 0;
      link.send({ type: 'sync' });
    });
    // 中转是可丢的（QoS 0）：没等到欢迎就一直重发入座请求，房主对重复的入座会再回一次欢迎
    const hello = () => link.send({ type: 'hello', id: this.me.id, name: this.me.name, key: this.me.key });
    hello();
    const retry = setInterval(hello, HELLO_RETRY_MS);
    try {
      await welcome;
      // 欢迎与断开可能同一时刻到达：欢迎先兑现了，断开时的 reject 就不起作用，这里补上检查
      if (!link.open) throw { type: 'network' };
    } catch (e) {
      if (this.link === link) this.link = null;
      link.close();
      throw e;
    } finally {
      clearInterval(retry);
      if (this.welcomeWait === wait) this.welcomeWait = null;
    }
    this.setStatus('online');
  }

  setStatus(s) {
    if (this.status === s) return;
    this.status = s;
    this.emit('net', s);
  }

  /** 连接断了：留在牌桌上，后台自动重连 */
  dropped() {
    if (this.closed || this.rejoining) return;
    this.rejoining = true;
    const old = this.link;
    this.link = null;
    old?.close(false);
    this.setStatus('reconnecting');
    this.reconnectLoop().finally(() => (this.rejoining = false));
  }

  async reconnectLoop() {
    const deadline = Date.now() + RECONNECT_MS;
    let wait = 500;
    let last = null;
    while (!this.closed && Date.now() < deadline) {
      try {
        await this.connect();
        return;
      } catch (e) {
        last = e;
        if (e?.type === 'full' || e?.type === 'denied' || e?.type === 'kicked') break;
      }
      await new Promise((r) => setTimeout(r, wait));
      wait = Math.min(4000, wait * 2);
    }
    if (this.closed) return;
    this.lost(last?.type === 'no-room' || last?.type === 'timeout' ? '房主已离开，房间解散了' : friendlyError(last));
  }

  tick() {
    const now = Date.now();
    // 自己刚从锁屏/后台醒来：先探一下，别急着判定房主掉线
    if (now - (this.lastTick ?? now) > SUSPEND_MS) this.lastMsg = Math.max(this.lastMsg, now - SILENT_MS + 6000);
    this.lastTick = now;
    const link = this.link;
    if (this.rejoining || !link) return;
    if (now - this.lastMsg > SILENT_MS) return this.dropped();
    // 中转的服务器连接断了（它会自己重连）：先提示并暂停投掷
    this.setStatus(link.kind === 'relay' && !link.broker.online ? 'reconnecting' : 'online');
    link.send({ type: 'ping', rev: this.rev });
  }

  lost(text) {
    if (this.closed) return;
    this.close(false);
    this.emit('error', text);
  }

  close(notify = true) {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    this.offVisible?.();
    if (notify && this.link?.open) this.link.send({ type: 'leave' });
    const link = this.link;
    this.link = null;
    // 给"离开"消息一点时间送出
    if (link) setTimeout(() => link.close(), notify ? 200 : 0);
  }

  onMsg(msg) {
    if (!msg || typeof msg !== 'object') return;
    this.lastMsg = Date.now();
    switch (msg.type) {
      case 'welcome':
        this.state = msg.state;
        this.rev = msg.rev | 0;
        this.welcomeWait?.resolve();
        this.emit('state', msg.state);
        break;
      case 'state':
        this.state = msg.state;
        this.rev = msg.rev | 0;
        this.emit('state', msg.state);
        break;
      case 'roll':
        this.state = msg.after;
        this.rev = msg.rev | 0;
        this.emit('roll', { ...msg, frames: decodeFrames(msg.frames) });
        break;
      case 'hold':
        if (msg.from === this.meId) break;
        try {
          const frame = decodeFrames(msg.f);
          if (frame.length === STRIDE) this.emit('hold', { frame, sounds: sanitizeSounds(msg.s) });
        } catch {}
        break;
      case 'ping':
        this.link?.send({ type: 'pong' });
        this.checkRev(msg.rev);
        break;
      case 'pong':
        this.checkRev(msg.rev);
        break;
      case 'full':
        this.welcomeWait?.reject({ type: 'full' });
        break;
      case 'denied':
        this.welcomeWait?.reject({ type: 'denied' });
        break;
      case 'kicked':
        if (this.welcomeWait) this.welcomeWait.reject({ type: 'kicked' });
        else this.lost('你已被房主移出房间');
        break;
      case 'closed':
        this.lost('房主解散了房间');
        break;
    }
  }

  /** 房主的版本号比本地新：说明漏了消息（重连期间），要一份最新状态 */
  checkRev(rev) {
    if (!Number.isInteger(rev) || rev <= this.rev || this.status !== 'online') return;
    const now = Date.now();
    if (now - (this.lastSync || 0) < 3000) return;
    this.lastSync = now;
    this.link?.send({ type: 'sync' });
  }

  canThrow() {
    const s = this.state;
    const p = s?.players[s.turn];
    return this.status === 'online' && s?.phase === 'playing' && p?.id === this.meId;
  }

  throwDice(payload) {
    this.link?.send({ type: 'throw', ...payload });
  }

  sendHold(h) {
    this.link?.send({ type: 'hold', ...h }, { lossy: true });
  }
}

function sanitizeSounds(list) {
  if (!Array.isArray(list)) return [];
  return list
    .slice(0, 8)
    .filter((x) => Array.isArray(x) && [0, 1, 2, 3].includes(x[0]) && Number.isFinite(x[1]))
    .map(([k, s]) => [k, Math.min(1, Math.max(0, s))]);
}

export function friendlyError(e) {
  const type = e?.type || '';
  const map = {
    'no-room': '找不到这个房间：请核对房间号，或房主已经离开',
    network: '连不上联机服务器，请检查网络后重试（可以试试关掉 VPN 或换个网络）',
    timeout: '房主没有响应，请稍后重试',
    insecure: '当前页面不是安全连接（https），无法联机加密，请用 https 地址打开',
    full: '房间已满（最多 8 人）',
    denied: '这个身份已在房间里（可能在别的页面打开了），请关闭其他页面后重试',
    kicked: '你已被房主移出房间',
  };

  return map[type] || (typeof e === 'string' ? e : e?.message || '连接失败');
}
