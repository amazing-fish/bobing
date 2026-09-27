// 联机传输层：不再依赖境外的 PeerJS 信令服务器。
// 1) 找房间、交换 WebRTC 信令、兜底转发，都走公共 MQTT 服务器（WebSocket over TLS，和普通 HTTPS 一样容易连通）；
// 2) 连上后尝试升级为 WebRTC 直连（DataChannel），直连失败（对称 NAT、VPN 屏蔽 UDP 等）就一直走服务器中转。
// 房主同时挂在多台服务器上，客人向所有服务器"敲门"，谁先应答用谁，所以只要双方能共同连上任意一台即可。
export const BROKERS = ['wss://broker-cn.emqx.io:8084/mqtt', 'wss://broker.emqx.io:8084/mqtt', 'wss://broker.hivemq.com:8884/mqtt'];
const NS = 'bobing-cn/v2';
export const ICE_SERVERS = [
  { urls: 'stun:stun.miwifi.com:3478' },
  { urls: 'stun:stun.chat.bilibili.com:3478' },
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: ['turn:eu-0.turn.peerjs.com:3478', 'turn:us-0.turn.peerjs.com:3478'], username: 'peerjs', credential: 'peerjsp' },
];
const KEEPALIVE = 30; // 秒；服务器 45 秒收不到任何报文才断开
const LOSSY_RELAY_MS = 100; // 中转时摇骰画面限速 10Hz，减轻公共服务器负担
const GAP_MS = 1500; // 有序消息缺号等待多久后跳过（重连期间丢失的由会话层重新同步）
const UPGRADE_MS = 10000; // WebRTC 直连协商超时
const DC_BUFFER_MAX = 256 * 1024;
const MAX_LINKS = 32;

export class Emitter {
  constructor() {
    this.handlers = {};
  }
  on(ev, fn) {
    (this.handlers[ev] ??= []).push(fn);
    return this;
  }
  off(ev) {
    delete this.handlers[ev];
  }
  emit(ev, ...args) {
    for (const fn of this.handlers[ev] || []) fn(...args);
  }
}

export function token(n = 10) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const buf = new Uint32Array(n);
  crypto.getRandomValues(buf);
  let s = '';
  for (const v of buf) s += chars[v % chars.length];
  return s;
}

// ---------- MQTT 3.1.1 最小实现（只用 QoS 0） ----------
const enc = new TextEncoder();
const dec = new TextDecoder();

function packet(first, parts) {
  let len = 0;
  for (const p of parts) len += p.length;
  const hdr = [first];
  let x = len;
  do {
    let b = x % 128;
    x = Math.floor(x / 128);
    if (x > 0) b |= 128;
    hdr.push(b);
  } while (x > 0);
  const out = new Uint8Array(hdr.length + len);
  out.set(hdr, 0);
  let o = hdr.length;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function str(s) {
  const b = enc.encode(s);
  const out = new Uint8Array(b.length + 2);
  out[0] = b.length >> 8;
  out[1] = b.length & 255;
  out.set(b, 2);
  return out;
}

export const mqtt = {
  connect: (clientId, keepalive) =>
    packet(0x10, [str('MQTT'), Uint8Array.of(4, 0x02, keepalive >> 8, keepalive & 255), str(clientId)]),
  subscribe: (id, topic) => packet(0x82, [Uint8Array.of(id >> 8, id & 255), str(topic), Uint8Array.of(0)]),
  publish: (topic, payload) => packet(0x30, [str(topic), enc.encode(payload)]),
  pingreq: () => Uint8Array.of(0xc0, 0),
  disconnect: () => Uint8Array.of(0xe0, 0),
};

/** 从 WebSocket 字节流中切出完整报文（一条 WS 消息可能含多个报文，也可能只有半个） */
export class MqttParser {
  constructor() {
    this.buf = new Uint8Array(0);
  }
  push(chunk) {
    const b = new Uint8Array(this.buf.length + chunk.length);
    b.set(this.buf);
    b.set(chunk, this.buf.length);
    this.buf = b;
    const out = [];
    for (;;) {
      const bb = this.buf;
      let len = 0, mul = 1, i = 1;
      for (;;) {
        if (i >= bb.length) return out;
        const d = bb[i++];
        len += (d & 127) * mul;
        mul *= 128;
        if (!(d & 128)) break;
        if (i > 4) throw new Error('bad mqtt length');
      }
      if (bb.length < i + len) return out;
      const type = bb[0] >> 4;
      const body = bb.subarray(i, i + len);
      const pk = { type };
      if (type === 3) {
        const tl = (body[0] << 8) | body[1];
        pk.topic = dec.decode(body.subarray(2, 2 + tl));
        const qos = (bb[0] >> 1) & 3;
        pk.payload = dec.decode(body.subarray(2 + tl + (qos ? 2 : 0)));
      } else if (type === 2) {
        pk.rc = body[1];
      }
      out.push(pk);
      this.buf = bb.slice(i + len);
    }
  }
}

const liveBrokers = new Set();
if (typeof document !== 'undefined') {
  // 手机解锁/切回页面、网络恢复时，立刻检查连接是否还活着（后台期间 socket 可能已经悄悄断了）
  const poke = () => document.visibilityState === 'visible' && liveBrokers.forEach((b) => b.poke());
  document.addEventListener('visibilitychange', poke);
  addEventListener('online', poke);
  addEventListener('pageshow', poke);
}

/** 一台 MQTT 服务器的连接：自动重连、恢复订阅；离线期间的可靠消息先排队 */
export class Broker {
  constructor(url) {
    this.url = url;
    this.subs = new Map(); // topic -> handler(msg)
    this.queue = [];
    this.online = false;
    this.everOnline = false;
    this.stopped = false;
    this.ws = null;
    this.tries = 0;
    this.pid = 1;
    this.onOnline = null;
  }

  start() {
    liveBrokers.add(this);
    this.connect();
    return this;
  }

  connect() {
    if (this.stopped) return;
    this.drop(false);
    let ws;
    try {
      ws = new WebSocket(this.url, ['mqtt']);
    } catch {
      return this.retry();
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    const parser = new MqttParser();
    ws.onopen = () => {
      this.lastIn = Date.now();
      this.raw(mqtt.connect(`bb_${token(14)}`, KEEPALIVE));
    };
    ws.onmessage = (e) => {
      if (ws !== this.ws) return;
      this.lastIn = Date.now();
      let pks;
      try {
        pks = parser.push(new Uint8Array(e.data));
      } catch {
        return this.drop(true);
      }
      for (const pk of pks) this.onPacket(pk);
    };
    ws.onclose = ws.onerror = () => ws === this.ws && this.drop(true);
  }

  onPacket(pk) {
    if (pk.type === 2) {
      if (pk.rc !== 0) return this.drop(true);
      this.online = true;
      this.everOnline = true;
      this.tries = 0;
      for (const topic of this.subs.keys()) this.raw(mqtt.subscribe(this.nextId(), topic));
      const q = this.queue;
      this.queue = [];
      for (const [t, p] of q) this.raw(mqtt.publish(t, p));
      clearInterval(this.kaTimer);
      this.kaTimer = setInterval(() => this.keepalive(), 5000);
      this.onOnline?.(this);
    } else if (pk.type === 3) {
      const fn = this.subs.get(pk.topic);
      if (!fn) return;
      let msg;
      try {
        msg = JSON.parse(pk.payload);
      } catch {
        return;
      }
      if (msg && typeof msg === 'object') fn(msg, this);
    }
  }

  nextId() {
    this.pid = (this.pid % 65535) + 1;
    return this.pid;
  }

  keepalive() {
    const now = Date.now();
    // 太久没收到任何报文（包括 PINGRESP）：连接已死，重连
    if (now - this.lastIn > (KEEPALIVE + 10) * 1000) return this.drop(true);
    if (now - (this.lastOut || 0) > 15000 || now - this.lastIn > 15000) this.raw(mqtt.pingreq());
  }

  /** 从后台回来：发一个 PINGREQ，3 秒内没回音就重连 */
  poke() {
    if (this.stopped) return;
    if (!this.online) {
      if (!this.ws || this.ws.readyState > 1) {
        clearTimeout(this.retryTimer);
        this.connect();
      }
      return;
    }
    const t = Date.now();
    this.raw(mqtt.pingreq());
    setTimeout(() => this.online && this.lastIn < t && this.drop(true), 3000);
  }

  raw(bytes) {
    if (this.ws?.readyState !== 1) return false;
    this.ws.send(bytes);
    this.lastOut = Date.now();
    return true;
  }

  subscribe(topic, fn) {
    this.subs.set(topic, fn);
    if (this.online) this.raw(mqtt.subscribe(this.nextId(), topic));
  }

  /** lossy：离线时直接丢弃（摇骰画面、敲门这类会重复发送的消息） */
  publish(topic, obj, lossy = false) {
    const payload = JSON.stringify(obj);
    if (this.online && this.raw(mqtt.publish(topic, payload))) return;
    if (!lossy && this.queue.length < 200) this.queue.push([topic, payload]);
  }

  drop(reconnect) {
    const ws = this.ws;
    this.ws = null;
    this.online = false;
    clearInterval(this.kaTimer);
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try {
        ws.close();
      } catch {}
    }
    if (reconnect) this.retry();
  }

  retry() {
    if (this.stopped) return;
    clearTimeout(this.retryTimer);
    const ms = Math.min(8000, 500 * 2 ** this.tries++) * (0.75 + Math.random() * 0.5);
    this.retryTimer = setTimeout(() => this.connect(), ms);
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    liveBrokers.delete(this);
    clearTimeout(this.retryTimer);
    clearInterval(this.kaTimer);
    const ws = this.ws;
    if (ws && this.online) {
      this.raw(mqtt.disconnect());
      // 稍等片刻再关，让刚发出的"房间解散/离开"之类的消息送达
      setTimeout(() => this.drop(false), 300);
    } else this.drop(false);
  }
}

/**
 * 房主与一位客人之间的连接。先走服务器中转，协商成功后自动换成 WebRTC 直连。
 * 事件：data(msg) / close() / kind('relay'|'p2p')
 * 有序消息带序号，接收端按序交付（切换通道的瞬间两条路可能乱序）；lossy 消息不排队、可丢。
 */
export class Link extends Emitter {
  constructor({ role, code, cid, broker }) {
    super();
    this.role = role;
    this.code = code;
    this.cid = cid;
    this.broker = broker;
    this.kind = 'relay';
    this.open = true;
    this.outSeq = 0;
    this.inSeq = 0;
    this.pending = new Map();
    this.lastLossy = 0;
    this.pc = null;
    this.dc = null;
    this.upgradeFailed = false;
    this.cands = [];
    this.topic = role === 'host' ? `${NS}/${code}/c/${cid}` : `${NS}/${code}/h`;
  }

  send(msg, { lossy = false } = {}) {
    if (!this.open) return;
    const env = lossy ? { k: 'd', m: msg } : { k: 'd', s: ++this.outSeq, m: msg };
    const dc = this.dc;
    if (dc?.readyState === 'open' && (!lossy || dc.bufferedAmount < DC_BUFFER_MAX)) {
      try {
        dc.send(JSON.stringify(env));
        return;
      } catch {}
    }
    if (lossy) {
      const now = Date.now();
      if (now - this.lastLossy < LOSSY_RELAY_MS) return;
      this.lastLossy = now;
    }
    this.relay(env, lossy);
  }

  relay(env, lossy = false) {
    this.broker.publish(this.topic, { ...env, c: this.cid }, lossy);
  }

  /** 收到对方的封包（来自服务器或直连通道） */
  recv(env) {
    if (!this.open || !env) return;
    if (env.k === 'd') this.recvData(env);
    else if (env.k === 'sig') this.onSignal(env);
    else if (env.k === 'bye') this.close(false);
  }

  /** 所在服务器断线重连成功：中转期间对方发来的消息已丢（QoS 0），下一条直接接上，并通知会话层补同步 */
  resume() {
    if (!this.open) return;
    if (this.kind === 'relay') this.skipGap = true;
    this.emit('resume');
  }

  recvData(env) {
    if (env.s == null) return this.emit('data', env.m);
    if (!Number.isInteger(env.s) || env.s <= this.inSeq) return;
    if (this.skipGap) {
      this.skipGap = false;
      if (env.s > this.inSeq + 1) this.inSeq = env.s - 1;
    }
    this.pending.set(env.s, env.m);
    this.drain();
  }

  drain() {
    while (this.pending.has(this.inSeq + 1)) {
      const m = this.pending.get(++this.inSeq);
      this.pending.delete(this.inSeq);
      this.emit('data', m);
      if (!this.open) return;
    }
    clearTimeout(this.gapTimer);
    if (this.pending.size) {
      // 中间缺了号（多半是重连期间丢的）：等一会儿还不来就跳过
      this.gapTimer = setTimeout(() => {
        this.inSeq = Math.min(...this.pending.keys()) - 1;
        this.drain();
      }, GAP_MS);
    }
  }

  close(notify = true) {
    if (!this.open) return;
    if (notify) {
      try {
        if (this.dc?.readyState === 'open') this.dc.send(JSON.stringify({ k: 'bye' }));
      } catch {}
      this.relay({ k: 'bye' }, true);
    }
    this.open = false;
    clearTimeout(this.gapTimer);
    clearTimeout(this.upgradeTimer);
    this.pc?.close();
    this.pc = this.dc = null;
    this.emit('close');
  }

  // ---------- WebRTC 直连升级（信令走服务器） ----------
  upgrade() {
    if (this.pc || this.upgradeFailed || !this.open || typeof RTCPeerConnection === 'undefined') return;
    let pc;
    try {
      pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    } catch {
      this.upgradeFailed = true;
      return;
    }
    this.pc = pc;
    // 双方约定同一个通道 id，无需等待 ondatachannel
    const dc = pc.createDataChannel('bobing', { negotiated: true, id: 0 });
    this.dc = dc;
    pc.onicecandidate = (e) => e.candidate && this.relay({ k: 'sig', ice: e.candidate.toJSON() }, true);
    dc.onopen = () => {
      clearTimeout(this.upgradeTimer);
      this.kind = 'p2p';
      this.emit('kind', 'p2p');
    };
    dc.onmessage = (e) => {
      let env;
      try {
        env = JSON.parse(e.data);
      } catch {
        return;
      }
      this.recv(env);
    };
    dc.onclose = () => this.dcDown();
    pc.onconnectionstatechange = () => ['failed', 'closed'].includes(pc.connectionState) && this.dcDown();
    this.upgradeTimer = setTimeout(() => this.kind !== 'p2p' && this.dcDown(), UPGRADE_MS);
    if (this.role === 'client') {
      pc.createOffer()
        .then((o) => pc.setLocalDescription(o))
        .then(() => this.relay({ k: 'sig', sdp: pc.localDescription.toJSON() }))
        .catch(() => this.dcDown());
    }
  }

  async onSignal(env) {
    if (this.upgradeFailed) return;
    if (!this.pc && this.role === 'host') this.upgrade();
    const pc = this.pc;
    if (!pc) return;
    try {
      if (env.sdp) {
        await pc.setRemoteDescription(env.sdp);
        for (const c of this.cands.splice(0)) await pc.addIceCandidate(c).catch(() => {});
        if (env.sdp.type === 'offer') {
          await pc.setLocalDescription(await pc.createAnswer());
          this.relay({ k: 'sig', sdp: pc.localDescription.toJSON() });
        }
      } else if (env.ice) {
        if (pc.remoteDescription) await pc.addIceCandidate(env.ice).catch(() => {});
        else this.cands.push(env.ice);
      }
    } catch {
      this.dcDown();
    }
  }

  /** 直连失败或断开：退回服务器中转，不再重试直连 */
  dcDown() {
    if (!this.pc) return;
    this.upgradeFailed = true;
    clearTimeout(this.upgradeTimer);
    const pc = this.pc;
    this.pc = this.dc = null;
    pc.close();
    if (this.kind !== 'relay') {
      this.kind = 'relay';
      this.emit('kind', 'relay');
    }
  }
}

/** 房主：在所有服务器上监听房间，每位客人（每次连接）得到一个 Link */
export class HostHub {
  constructor(code, onLink, urls = BROKERS) {
    this.code = code;
    this.onLink = onLink;
    this.links = new Map(); // cid -> Link
    this.brokers = urls.map((u) => new Broker(u));
  }

  /** 至少一台服务器连上即可开房；其余的在后台继续重试 */
  start(timeoutMs = 12000) {
    const topic = `${NS}/${this.code}/h`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject({ type: 'network' }), timeoutMs);
      for (const b of this.brokers) {
        b.subscribe(topic, (env, br) => this.onEnvelope(env, br));
        let first = true;
        b.onOnline = () => {
          if (first) {
            first = false;
            clearTimeout(timer);
            return resolve();
          }
          for (const link of this.links.values()) if (link.broker === b) link.resume();
        };
        b.start();
      }
    });
  }

  onEnvelope(env, broker) {
    const cid = typeof env.c === 'string' ? env.c.slice(0, 32) : '';
    if (!cid) return;
    let link = this.links.get(cid);
    if (env.k === 'knock') {
      if (!link) {
        if (this.links.size >= MAX_LINKS) return;
        link = new Link({ role: 'host', code: this.code, cid, broker });
        this.links.set(cid, link);
        link.on('close', () => this.links.get(cid) === link && this.links.delete(cid));
        this.onLink(link);
      }
      // 应答可能丢了，客人会重复敲门：每次都回
      if (link.broker === broker) link.relay({ k: 'ack' });
      return;
    }
    if (link && link.broker === broker) link.recv(env);
  }

  /** 摇骰画面这类高频消息：直连的逐个发，中转的每台服务器只发一次（客人订阅同一个广播主题） */
  broadcastLossy(msg, exceptCid) {
    const now = Date.now();
    const viaRelay = new Set();
    for (const link of this.links.values()) {
      if (link.cid === exceptCid || !link.open) continue;
      if (link.dc?.readyState === 'open') link.send(msg, { lossy: true });
      else viaRelay.add(link.broker);
    }
    if (!viaRelay.size || now - (this.lastLossy || 0) < LOSSY_RELAY_MS) return;
    this.lastLossy = now;
    for (const b of viaRelay) b.publish(`${NS}/${this.code}/all`, { k: 'd', m: msg }, true);
  }

  close() {
    for (const link of [...this.links.values()]) link.close();
    this.links.clear();
    for (const b of this.brokers) b.stop();
  }
}

/**
 * 客人：向所有服务器敲门，谁先应答就用谁
 * 失败时 reject {type:'no-room'}（服务器连上了但房主没回应）或 {type:'network'}（一台服务器都连不上）
 */
export function joinRoom(code, { timeoutMs = 12000, urls = BROKERS } = {}) {
  const cid = token(12);
  const brokers = urls.map((u) => new Broker(u));
  return new Promise((resolve, reject) => {
    let done = false;
    let link = null;
    let knockTimer = null;
    let giveUp = null;
    const knock = (b) => b.publish(`${NS}/${code}/h`, { k: 'knock', c: cid }, true);
    const finish = () => {
      done = true;
      clearInterval(knockTimer);
      clearTimeout(giveUp);
      for (const b of brokers) b.onOnline = null;
    };
    for (const b of brokers) {
      b.subscribe(`${NS}/${code}/c/${cid}`, (env, br) => {
        if (done) {
          if (br === link?.broker) link.recv(env);
          return;
        }
        if (env.k !== 'ack') return;
        finish();
        for (const other of brokers) if (other !== br) other.stop();
        link = new Link({ role: 'client', code, cid, broker: br });
        link.on('close', () => br.stop());
        // 中转模式下，房主把摇骰画面发到房间广播主题
        br.subscribe(`${NS}/${code}/all`, (e) => link.kind === 'relay' && link.open && e.k === 'd' && link.emit('data', e.m));
        br.onOnline = () => link.resume();
        resolve(link);
        setTimeout(() => link.upgrade(), 300);
      });
      b.onOnline = knock;
      b.start();
    }
    knockTimer = setInterval(() => brokers.forEach((b) => b.online && knock(b)), 1500);
    giveUp = setTimeout(() => {
      finish();
      const reached = brokers.some((b) => b.everOnline);
      for (const b of brokers) b.stop();
      reject({ type: reached ? 'no-room' : 'network' });
    }, timeoutMs);
  });
}
