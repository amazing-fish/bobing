// 传输层：MQTT 编解码、加密握手、防伪造/防重放、换服务器（内存里的假服务器，真实加密）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mqtt, MqttParser, Link, Broker, HostHub, joinRoom, deriveRoom, codeFromKey, createHostIdentity } from '../js/net.js';

test('MQTT 报文：长报文变长长度编码，半包/粘包都能切开', () => {
  const big = 'x'.repeat(50000);
  const pub = mqtt.publish('bobing-cn/v4/abc/h', big);
  const both = new Uint8Array(pub.length + 2);
  both.set(pub);
  both.set(Uint8Array.of(0xd0, 0), pub.length); // PINGRESP
  const p = new MqttParser();
  const out = [...p.push(both.subarray(0, 7)), ...p.push(both.subarray(7, 30000)), ...p.push(both.subarray(30000))];
  assert.equal(out.length, 2);
  assert.equal(out[0].topic, 'bobing-cn/v4/abc/h');
  assert.equal(out[0].payload.length, 50000);
  assert.equal(out[1].type, 13);
  assert.deepEqual(new MqttParser().push(Uint8Array.of(0x20, 2, 0, 0)), [{ type: 2, rc: 0 }]);
});

test('房间号 = 房主公钥指纹；房间密钥只有同房间号、同主题才能解开', async () => {
  const id = await createHostIdentity();
  assert.match(id.code, /^[A-HJ-NP-Z2-9]{10}$/);
  assert.equal(await codeFromKey(id.pub), id.code);
  const a = await deriveRoom(id.code);
  const b = await deriveRoom('ABCDEFGHJK');
  assert.match(a.id, /^[0-9a-f]{32}$/);
  const ct = await a.seal('t/1', { m: '秘密' });
  assert.doesNotMatch(ct, /秘密/);
  assert.deepEqual(await a.open('t/1', ct), { m: '秘密' });
  assert.equal(await a.open('t/2', ct), null, '换主题无效');
  assert.equal(await b.open('t/1', ct), null, '别的房间号解不开');
  assert.equal(await a.open('t/1', '{"k":"bye"}'), null, '明文伪造无效');
});

// ---------- 内存里的假服务器 ----------
function makeBus({ delay = 0 } = {}) {
  return { members: new Set(), log: [], delay, filter: null };
}

function memBroker(bus) {
  const b = new Broker('mem://');
  b.start = function () {
    this.online = this.everOnline = true;
    bus.members.add(this);
    setTimeout(() => this.onOnline?.(this), bus.delay);
    return this;
  };
  b.publish = function (topic, payload) {
    if (!this.online) return;
    bus.log.push({ topic, payload });
    for (const m of bus.members) {
      if (!m.online || (bus.filter && !bus.filter(topic))) continue;
      setTimeout(() => m.subs.get(topic)?.(payload, m), bus.delay);
    }
  };
  b.stop = function () {
    this.online = false;
    bus.members.delete(this);
  };
  return b;
}

/** 以旁观者身份往总线上发（绕过 Broker） */
function inject(bus, topic, payload) {
  bus.log.push({ topic, payload });
  for (const m of bus.members) setTimeout(() => m.subs.get(topic)?.(payload, m));
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function openHub(buses) {
  const links = [];
  const hub = new HostHub((l) => links.push(l), { urls: buses, makeBroker: memBroker });
  await hub.start();
  return { hub, links };
}

function nextData(link) {
  return new Promise((r) => link.on('data', r));
}

test('握手：加入、双向收发；服务器上看不到明文', async () => {
  const bus = makeBus();
  const { hub, links } = await openHub([bus]);
  const link = await joinRoom(hub.code, { urls: [bus], makeBroker: memBroker, timeoutMs: 3000 });
  const hostSide = links[0];
  const got = nextData(hostSide);
  link.send({ hello: '客人小红' });
  assert.deepEqual(await got, { hello: '客人小红' });
  const back = nextData(link);
  hostSide.send({ welcome: 1 });
  assert.deepEqual(await back, { welcome: 1 });
  assert.equal(hostSide.pinned, true);
  const all = bus.log.map((x) => x.topic + x.payload).join('\n');
  assert.doesNotMatch(all, /客人小红|welcome|knock|hello/);
  assert.ok(!all.includes(hub.code), '房间号不上服务器');
  hub.close();
});

test('知道房间号的客人：读不了、伪造不了别人的连接，冒充不了房主的应答与广播', async () => {
  const bus = makeBus();
  const { hub, links } = await openHub([bus]);
  const victim = await joinRoom(hub.code, { urls: [bus], makeBroker: memBroker, timeoutMs: 3000 });
  const got = nextData(links[0]);
  victim.send({ type: 'hello' });
  await got;
  const back = nextData(victim);
  links[0].send({ type: 'welcome' });
  await back;
  const room = await deriveRoom(hub.code); // 内鬼也能算出房间密钥
  // 1) 连接上的流量用的是连接密钥：房间密钥解不开
  const linkPkts = bus.log.filter((x) => /\/(u|d)\//.test(x.topic));
  assert.ok(linkPkts.length >= 2);
  for (const x of linkPkts) assert.equal(await room.open(x.topic, x.payload), null);
  // 2) 用房间密钥伪造发给房主的消息、发给客人的 bye：无效
  const up = linkPkts.find((x) => x.topic.includes('/u/')).topic;
  const down = linkPkts.find((x) => x.topic.includes('/d/')).topic;
  const hostData = [];
  links[0].on('data', (m) => hostData.push(m));
  inject(bus, up, await room.seal(up, { k: 'd', s: 99, m: { type: 'throw' }, n: 99 }));
  inject(bus, down, await room.seal(down, { k: 'bye', n: 99 }));
  // 3) 伪造广播（房间密钥能加密，但没有房主签名）
  const spectator = [];
  victim.on('data', (m) => spectator.push(m));
  const all = bus.log.find(() => true).topic.replace(/\/h$/, '/all');
  inject(bus, all, await room.seal(all, { k: 'b', b: JSON.stringify({ n: 999, m: { type: 'hold', fake: 1 } }), sig: 'AAAA' }));
  await wait(50);
  hub.broadcastLossy({ type: 'hold', real: 1 });
  await wait(100);
  assert.deepEqual(hostData, [], '伪造的投掷被丢弃');
  assert.ok(victim.open, '伪造的 bye 无效');
  assert.deepEqual(spectator, [{ type: 'hold', real: 1 }], '只收到房主签名的广播');
  hub.close();
});

test('冒充房主：房主不在时伪造应答（自己的公钥，或偷用房主公钥配自己的签名）都不被接受', async () => {
  const bus = makeBus();
  const { hub } = await openHub([bus]);
  const realAck = (async () => {
    const l = await joinRoom(hub.code, { urls: [bus], makeBroker: memBroker, timeoutMs: 3000 });
    l.close();
  })();
  await realAck;
  const captured = bus.log.find((x) => x.topic.includes('/a/'));
  const room = await deriveRoom(hub.code);
  const realHk = (await room.open(captured.topic, captured.payload)).hk;
  const code = hub.code;
  hub.close();
  // 内鬼接管：收到敲门就回伪造的应答
  const evil = await createHostIdentity();
  const host = `bobing-cn/v4/${room.id}/h`;
  const spy = memBroker(bus);
  spy.start();
  let forged = 0;
  spy.subscribe(host, async (payload) => {
    const k = await room.open(host, payload);
    if (!k || k.k !== 'knock') return;
    const ack = `bobing-cn/v4/${room.id}/a/${k.c}`;
    const body = { k: 'ack', c: k.c, cn: k.cn, he: k.pk, sig: btoa('x'.repeat(64)) };
    forged++;
    inject(bus, ack, await room.seal(ack, { ...body, hk: btoa(String.fromCharCode(...evil.pub)) }));
    inject(bus, ack, await room.seal(ack, { ...body, hk: realHk }));
  });
  await assert.rejects(joinRoom(code, { urls: [bus], makeBroker: memBroker, timeoutMs: 2000 }), { type: 'no-room' });
  assert.ok(forged > 0, '确实发出了伪造应答');
  spy.stop();
});

test('换服务器：A 上的应答丢了，客人在 B 上加入；第一条消息从 B 来就固定在 B', async () => {
  const A = makeBus();
  const B = makeBus({ delay: 30 }); // 让 A 上的敲门先到
  A.filter = (topic) => !topic.includes('/a/'); // A 上发给客人的应答全丢
  const { hub, links } = await openHub([A, B]);
  const link = await joinRoom(hub.code, { urls: [A, B], makeBroker: memBroker, timeoutMs: 4000 });
  const got = nextData(links[0]);
  link.send({ type: 'hello' });
  await got;
  assert.equal(links.length, 1);
  assert.equal(links[0].pinned, true);
  assert.ok(B.members.has(links[0].broker), '固定在 B');
  hub.close();
});

test('重放：已关闭连接的旧敲门不会再建连接', async () => {
  const bus = makeBus();
  const { hub, links } = await openHub([bus]);
  const link = await joinRoom(hub.code, { urls: [bus], makeBroker: memBroker, timeoutMs: 3000 });
  const knock = bus.log.find((x) => x.topic.endsWith('/h'));
  links[0].close();
  link.close(false);
  await wait(20);
  inject(bus, knock.topic, knock.payload);
  await wait(50);
  assert.equal(links.length, 1);
  assert.equal(hub.links.size, 0);
  hub.close();
});

test('Link：只接受计数递增的封包；乱序按序交付，缺号超时后跳过', async () => {
  const sent = [];
  const cipher = { seal: async (t, o) => o };
  const broker = { publishSealed: (c, t, o) => sent.push(o) };
  const link = new Link({ role: 'host', cipher, cid: 'c1', tx: 'd', rx: 'u', broker });
  const got = [];
  link.on('data', (m) => got.push(m));
  assert.equal(link.accept({ k: 'd', s: 2, m: 'b', n: 1 }), true);
  assert.equal(link.accept({ k: 'd', s: 2, m: 'b', n: 1 }), false, '重放');
  assert.equal(link.accept({ k: 'd', s: 1, m: 'a', n: 2 }), true);
  assert.deepEqual(got, ['a', 'b']);
  link.accept({ k: 'd', s: 4, m: 'd', n: 3 });
  assert.equal(got.at(-1), 'b', '缺 3，先等');
  await wait(1700);
  assert.equal(got.at(-1), 'd', '超时后跳过缺号');
  link.send({ x: 1 });
  link.send({ x: 2 });
  assert.deepEqual(sent.map((o) => [o.n, o.s]), [[1, 1], [2, 2]]);
  link.close(false);
});
