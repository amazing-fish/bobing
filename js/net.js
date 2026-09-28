// 联机传输层：不再依赖境外的 PeerJS 信令服务器。
// 1) 找房间、交换 WebRTC 信令、兜底转发，都走公共 MQTT 服务器（WebSocket over TLS，和普通 HTTPS 一样容易连通）；
// 2) 连上后尝试升级为 WebRTC 直连（DataChannel），直连失败（对称 NAT、VPN 屏蔽 UDP 等）就一直走服务器中转。
// 房主同时挂在多台服务器上，客人向所有服务器"敲门"，谁先应答用谁，所以只要双方能共同连上任意一台即可。
// 公共服务器上只有密文，见下方"加密"。
export const BROKERS = ['wss://broker-cn.emqx.io:8084/mqtt', 'wss://broker.emqx.io:8084/mqtt', 'wss://broker.hivemq.com:8884/mqtt'];
const NS = 'bobing-cn/v4';
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
  unsubscribe: (id, topic) => packet(0xa2, [Uint8Array.of(id >> 8, id & 255), str(topic)]),
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

// ---------- 加密：公共服务器上只有密文，知道房间号的人也冒充不了别人 ----------
// 两层密钥：
// 1) 房间密钥：由房间号经 PBKDF2 慢哈希派生主题名和 AES-GCM 密钥，只用于"敲门/应答"和房主的广播。
//    旁观者没有房间号，看到的只是随机主题下的密文；想猜房间号只能逐个做 20 万次哈希。
// 2) 连接密钥：每位客人与房主用 ECDH 临时协商，双向各一把 AES-GCM 密钥。别的客人即便知道房间号，
//    也读不了、伪造不了这条连接上的任何消息。
// 房间号就是房主签名公钥的指纹（SHA-256 的前 50 bit），客人据此验证应答确实出自房主：
// 冒充房主必须找到指纹相同的另一把公钥，约 2^50 次运算，房间存活期内不现实。
// 房主的广播（摇骰画面）用这把签名密钥签名，客人之间无法伪造。重放由递增计数挡住。
export const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const CODE_LEN = 10;
const KDF_ITER = 200000;
const KDF_SALT = 'bobing-cn/v4/room';
const EC = { name: 'ECDH', namedCurve: 'P-256' };
const SIG = { name: 'ECDSA', namedCurve: 'P-256' };
const SIG_ALG = { name: 'ECDSA', hash: 'SHA-256' };
const rooms = new Map(); // code -> Promise<Room>

function subtle() {
  const s = globalThis.crypto?.subtle;
  if (!s) throw { type: 'insecure' };
  return s;
}

function b64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function unb64(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function aeadSeal(key, topic, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(topic) }, key, enc.encode(JSON.stringify(obj))));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return b64(out);
}

async function aeadOpen(key, topic, str) {
  try {
    const bytes = unb64(str);
    if (bytes.length < 29) return null;
    const pt = await subtle().decrypt({ name: 'AES-GCM', iv: bytes.subarray(0, 12), additionalData: enc.encode(topic) }, key, bytes.subarray(12));
    const msg = JSON.parse(dec.decode(pt));
    return msg && typeof msg === 'object' ? msg : null;
  } catch {
    return null;
  }
}

/** 公钥 → 房间号（SHA-256 前 50 bit，每 5 bit 一个字符） */
export async function codeFromKey(rawPub) {
  const h = new Uint8Array(await subtle().digest('SHA-256', rawPub));
  let s = '', acc = 0, bits = 0, i = 0;
  while (s.length < CODE_LEN) {
    acc = (acc << 8) | h[i++];
    bits += 8;
    while (bits >= 5 && s.length < CODE_LEN) {
      bits -= 5;
      s += CODE_CHARS[(acc >> bits) & 31];
    }
    acc &= (1 << bits) - 1;
  }
  return s;
}

/** 房主身份：签名密钥对（私钥不可导出），房间号 = 公钥指纹 */
export async function createHostIdentity() {
  const kp = await subtle().generateKey(SIG, false, ['sign', 'verify']);
  const pub = new Uint8Array(await subtle().exportKey('raw', kp.publicKey));
  return { key: kp.privateKey, pub, code: await codeFromKey(pub) };
}

/** 由房间号派生房间密钥 { id: 主题名, key }；同一房间号只算一次 */
export function deriveRoom(code) {
  let p = rooms.get(code);
  if (!p) {
    p = makeRoom(code);
    rooms.set(code, p);
    p.catch(() => rooms.delete(code));
  }
  return p;
}

async function makeRoom(code) {
  const s = subtle();
  const base = await s.importKey('raw', enc.encode(code), 'PBKDF2', false, ['deriveBits']);
  const master = await s.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(KDF_SALT), iterations: KDF_ITER }, base, 256);
  const hk = await s.importKey('raw', master, 'HKDF', false, ['deriveBits', 'deriveKey']);
  const info = (x) => ({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode(x) });
  const idBits = new Uint8Array(await s.deriveBits(info('topic'), hk, 128));
  const key = await s.deriveKey(info('aead'), hk, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const id = [...idBits].map((b) => b.toString(16).padStart(2, '0')).join('');
  return { code, id, seal: (topic, obj) => aeadSeal(key, topic, obj), open: (topic, str) => aeadOpen(key, topic, str) };
}

/** ECDH 临时密钥对 */
async function ecdhPair() {
  const kp = await subtle().generateKey(EC, false, ['deriveBits']);
  return { priv: kp.privateKey, pub: new Uint8Array(await subtle().exportKey('raw', kp.publicKey)) };
}

/**
 * 一条连接的双向密钥：由 ECDH 共享秘密经 HKDF 派生，房主→客人、客人→房主各一把。
 * 返回 { seal(topic,obj), open(topic,str) }：seal 用本方发送方向的密钥，open 用对方的
 */
async function linkCipher(role, myPriv, peerRaw, salt) {
  const s = subtle();
  const peer = await s.importKey('raw', peerRaw, EC, false, []);
  const shared = await s.deriveBits({ name: 'ECDH', public: peer }, myPriv, 256);
  const hk = await s.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  const dir = (x) => s.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: enc.encode(salt), info: enc.encode(x) }, hk, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const [h2c, c2h] = await Promise.all([dir('host->client'), dir('client->host')]);
  const [tx, rx] = role === 'host' ? [h2c, c2h] : [c2h, h2c];
  return { seal: (topic, obj) => aeadSeal(tx, topic, obj), open: (topic, str) => aeadOpen(rx, topic, str) };
}

/** 房主签名的握手内容：绑定房间、这次连接、客人与房主的临时公钥 */
function transcript(roomId, cid, cn, clientPub, hostEph) {
  return enc.encode(['bobing/v4/ack', roomId, cid, cn, b64(clientPub), b64(hostEph)].join('|'));
}

/** 订阅回调：逐条解密后按到达顺序处理（解密是异步的，不串行会乱序）。cipher 可以是 Promise */
function sealedHandler(cipher, topic, fn) {
  let chain = Promise.resolve();
  return (payload, broker) => {
    chain = chain
      .then(() => cipher)
      .then((c) => c.open(topic, payload))
      .then((msg) => msg && fn(msg, broker), () => {});
  };
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
      this.subs.get(pk.topic)?.(pk.payload, this);
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

  unsubscribe(topic) {
    if (!this.subs.delete(topic)) return;
    if (this.online) this.raw(mqtt.unsubscribe(this.nextId(), topic));
  }

  /** lossy：离线时直接丢弃（摇骰画面、敲门这类会重复发送的消息） */
  publish(topic, payload, lossy = false) {
    if (this.online && this.raw(mqtt.publish(topic, payload))) return;
    if (!lossy && this.queue.length < 200) this.queue.push([topic, payload]);
  }

  /** 加密后发布；加密是异步的，串成一条链保证按调用顺序发出。cipher 可以是 Promise */
  publishSealed(cipher, topic, obj, lossy = false) {
    this.sealing = (this.sealing || Promise.resolve())
      .then(() => cipher)
      .then((c) => c.seal(topic, obj))
      .then((payload) => !this.closedWs && this.publish(topic, payload, lossy), () => {});
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
    // 先等排队加密的消息（"房间解散/离开"之类）发出去，再断开
    (this.sealing || Promise.resolve()).then(() => {
      this.closedWs = true;
      if (this.ws && this.online) {
        this.raw(mqtt.disconnect());
        setTimeout(() => this.drop(false), 300);
      } else this.drop(false);
    });
  }
}

/**
 * 房主与一位客人之间的连接。先走服务器中转，协商成功后自动换成 WebRTC 直连。
 * 事件：data(msg) / close() / kind('relay'|'p2p') / resume()
 * 有序消息带序号，接收端按序交付（切换通道的瞬间两条路可能乱序）；lossy 消息不排队、可丢。
 * 中转封包用这条连接自己的密钥（ECDH 协商，见上）加密，并带递增计数 n，计数没有变大的（重放）丢弃。
 * 直连通道本身有 DTLS 加密，其密钥指纹经这条加密连接交换，不再重复加密。
 */
export class Link extends Emitter {
  constructor({ role, cipher, cid, tx, rx, broker }) {
    super();
    this.role = role;
    this.cipher = cipher; // 可以是 Promise（房主还在生成密钥）
    this.cid = cid;
    this.tx = tx; // 发出的主题
    this.rx = rx; // 收取的主题
    this.broker = broker;
    this.kind = 'relay';
    this.open = true;
    this.outN = 0; // 中转封包计数（防重放）
    this.inN = 0;
    this.outSeq = 0; // 有序消息序号
    this.inSeq = 0;
    this.pending = new Map();
    this.lastLossy = 0;
    this.pc = null;
    this.dc = null;
    this.upgradeFailed = false;
    this.cands = [];
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

  /** 经服务器发给对方：补上计数后用连接密钥加密 */
  relay(env, lossy = false) {
    this.broker.publishSealed(this.cipher, this.tx, { ...env, n: ++this.outN }, lossy);
  }

  /** 服务器转来的封包（已用连接密钥解密）：丢弃重放 */
  accept(env) {
    if (!this.open || !Number.isSafeInteger(env.n) || env.n <= this.inN) return false;
    this.inN = env.n;
    this.recv(env);
    return true;
  }

  /** 收到对方的封包（直连通道的，或 accept 校验过的） */
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

const topics = (roomId, cid) => ({
  host: `${NS}/${roomId}/h`, // 敲门（房间密钥）
  all: `${NS}/${roomId}/all`, // 房主广播（房间密钥 + 房主签名）
  ack: `${NS}/${roomId}/a/${cid}`, // 应答（房间密钥 + 房主签名）
  up: `${NS}/${roomId}/u/${cid}`, // 客人 → 房主（连接密钥）
  down: `${NS}/${roomId}/d/${cid}`, // 房主 → 客人（连接密钥）
});

/**
 * 房主：在所有服务器上监听房间，每位客人（每次连接）得到一个 Link。
 * 客人发来第一条正式消息之前，连接不固定在某台服务器：敲门从哪台来，就在哪台应答
 * （客人可能在收到应答前断开了那台，换另一台继续敲）；第一条消息从哪台来，就固定用哪台。
 */
export class HostHub {
  constructor(onLink, { urls = BROKERS, makeBroker = (u) => new Broker(u) } = {}) {
    this.onLink = onLink;
    this.links = new Map(); // cid -> Link
    this.dead = new Set(); // 已关闭的连接 id：重放的旧敲门不会再建连接
    this.bn = 0; // 广播计数
    this.signing = Promise.resolve();
    this.brokers = urls.map(makeBroker);
  }

  /** 生成房主身份与房间号；至少一台服务器连上即可开房，其余的在后台继续重试 */
  async start(timeoutMs = 12000) {
    this.identity = await createHostIdentity();
    this.code = this.identity.code;
    this.room = await deriveRoom(this.code);
    const t = topics(this.room.id, '');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject({ type: 'network' }), timeoutMs);
      for (const b of this.brokers) {
        b.subscribe(t.host, sealedHandler(this.room, t.host, (env, br) => this.onKnock(env, br)));
        let first = true;
        b.onOnline = () => {
          if (first) {
            first = false;
            clearTimeout(timer);
            return resolve();
          }
          for (const link of this.links.values()) if (link.pinned && link.broker === b) link.resume();
        };
        b.start();
      }
    });
  }

  onKnock(env, broker) {
    if (env.k !== 'knock' || typeof env.cn !== 'string' || typeof env.pk !== 'string') return;
    const cid = typeof env.c === 'string' ? env.c.slice(0, 32) : '';
    if (!cid || this.dead.has(cid)) return;
    let link = this.links.get(cid);
    // 同一连接 id 换了公钥：不是同一个人，不理
    if (link && link.pk !== env.pk) return;
    if (!link) {
      if (this.links.size >= MAX_LINKS) return;
      link = this.createLink(cid, env, broker);
      if (!link) return;
    }
    if (link.pinned && link.broker !== broker) return;
    // 应答可能丢了，客人会重复敲门：每次都回同一份
    link.ackBody.then((body) => link.open && broker.publishSealed(this.room, link.t.ack, body, true), () => {});
  }

  createLink(cid, env, broker) {
    let clientPub;
    try {
      clientPub = unb64(env.pk);
    } catch {
      return null;
    }
    const t = topics(this.room.id, cid);
    const hs = (async () => {
      const eph = await ecdhPair();
      const cipher = await linkCipher('host', eph.priv, clientPub, `${this.room.id}|${cid}`);
      const sig = new Uint8Array(await subtle().sign(SIG_ALG, this.identity.key, transcript(this.room.id, cid, env.cn, clientPub, eph.pub)));
      return { cipher, ack: { k: 'ack', c: cid, cn: env.cn, hk: b64(this.identity.pub), he: b64(eph.pub), sig: b64(sig) } };
    })();
    const cipher = hs.then((x) => x.cipher);
    const link = new Link({ role: 'host', cipher, cid, tx: t.down, rx: t.up, broker });
    link.pk = env.pk;
    link.t = t;
    link.ackBody = hs.then((x) => x.ack);
    cipher.catch(() => link.close(false)); // 客人给的公钥无效
    this.links.set(cid, link);
    // 收客人的消息：在所有服务器上都订阅，第一条正式消息决定固定用哪台
    const onUp = sealedHandler(cipher, t.up, (e, br) => this.onLinkEnv(link, e, br));
    for (const b of this.brokers) b.subscribe(t.up, onUp);
    link.on('close', () => {
      clearTimeout(link.idleTimer);
      for (const b of this.brokers) b.unsubscribe(t.up);
      if (this.links.get(cid) === link) this.links.delete(cid);
      this.dead.add(cid);
      if (this.dead.size > 500) this.dead.delete(this.dead.values().next().value);
    });
    // 敲了门却一直不来正式消息（客人放弃了，或是重放）：到时清掉
    link.idleTimer = setTimeout(() => !link.pinned && link.close(false), 20000);
    this.onLink(link);
    return link;
  }

  onLinkEnv(link, env, broker) {
    if (!link.open || (link.pinned && link.broker !== broker)) return;
    if (link.pinned) return link.accept(env);
    const prev = link.broker;
    link.broker = broker;
    link.pinned = true;
    if (!link.accept(env)) {
      link.pinned = false;
      link.broker = prev;
      return;
    }
    clearTimeout(link.idleTimer);
  }

  /** 摇骰画面这类高频消息：直连的逐个发，中转的每台服务器只发一次（客人订阅同一个广播主题，房主签名防伪造） */
  broadcastLossy(msg, exceptCid) {
    const now = Date.now();
    const viaRelay = new Set();
    for (const link of this.links.values()) {
      if (link.cid === exceptCid || !link.open || !link.pinned) continue;
      if (link.dc?.readyState === 'open') link.send(msg, { lossy: true });
      else viaRelay.add(link.broker);
    }
    if (!viaRelay.size || now - (this.lastLossy || 0) < LOSSY_RELAY_MS) return;
    this.lastLossy = now;
    const body = JSON.stringify({ n: ++this.bn, m: msg });
    const topic = topics(this.room.id, '').all;
    this.signing = this.signing
      .then(() => subtle().sign(SIG_ALG, this.identity.key, enc.encode(body)))
      .then((sig) => {
        for (const b of viaRelay) b.publishSealed(this.room, topic, { k: 'b', b: body, sig: b64(new Uint8Array(sig)) }, true);
      }, () => {});
  }

  close() {
    for (const link of [...this.links.values()]) link.close();
    this.links.clear();
    for (const b of this.brokers) b.stop();
  }
}

/**
 * 客人：向所有服务器敲门，谁先回来一份验证通过的应答就用谁
 * 失败时 reject {type:'no-room'}（服务器连上了但房主没回应）或 {type:'network'}（一台服务器都连不上）
 */
export async function joinRoom(code, { timeoutMs = 12000, urls = BROKERS, makeBroker = (u) => new Broker(u) } = {}) {
  const room = await deriveRoom(code);
  const eph = await ecdhPair();
  const cid = token(12);
  const cn = token(12);
  const t = topics(room.id, cid);
  const brokers = urls.map(makeBroker);
  return new Promise((resolve, reject) => {
    let done = false;
    let knockTimer = null;
    let giveUp = null;
    const knockBody = { k: 'knock', c: cid, cn, pk: b64(eph.pub) };
    const knock = (b) => b.publishSealed(room, t.host, knockBody, true);
    const finish = () => {
      done = true;
      clearInterval(knockTimer);
      clearTimeout(giveUp);
      for (const b of brokers) b.onOnline = null;
    };
    /** 应答必须：回应本次随机数；房主公钥的指纹等于房间号；握手内容有房主签名 */
    const verify = async (env) => {
      if (env.k !== 'ack' || env.c !== cid || env.cn !== cn) return null;
      const hk = unb64(String(env.hk));
      const he = unb64(String(env.he));
      if ((await codeFromKey(hk)) !== code) return null;
      const pub = await subtle().importKey('raw', hk, SIG, false, ['verify']);
      if (!(await subtle().verify(SIG_ALG, pub, unb64(String(env.sig)), transcript(room.id, cid, cn, eph.pub, he)))) return null;
      return { pub, cipher: await linkCipher('client', eph.priv, he, `${room.id}|${cid}`) };
    };
    const bind = (br, { pub, cipher }) => {
      finish();
      for (const other of brokers) if (other !== br) other.stop();
      br.unsubscribe(t.ack);
      const link = new Link({ role: 'client', cipher, cid, tx: t.up, rx: t.down, broker: br });
      link.on('close', () => br.stop());
      br.subscribe(t.down, sealedHandler(cipher, t.down, (e) => link.accept(e)));
      // 中转模式下，房主把摇骰画面发到房间广播主题：验签、计数递增才收
      let bn = 0;
      br.subscribe(
        t.all,
        sealedHandler(room, t.all, async (e) => {
          if (e.k !== 'b' || typeof e.b !== 'string') return;
          if (!(await subtle().verify(SIG_ALG, pub, unb64(String(e.sig)), enc.encode(e.b)))) return;
          const body = JSON.parse(e.b);
          if (!Number.isSafeInteger(body.n) || body.n <= bn) return;
          bn = body.n;
          if (link.kind === 'relay' && link.open) link.emit('data', body.m);
        }),
      );
      br.onOnline = () => link.resume();
      resolve(link);
      setTimeout(() => link.upgrade(), 300);
    };
    for (const b of brokers) {
      b.subscribe(
        t.ack,
        sealedHandler(room, t.ack, async (env, br) => {
          if (done) return;
          const ok = await verify(env).catch(() => null);
          if (ok && !done) bind(br, ok);
        }),
      );
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
