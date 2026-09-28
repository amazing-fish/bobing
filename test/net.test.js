// MQTT 报文编解码、房间加密、Link 的防重放与有序交付、房主换服务器（不连真实服务器）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mqtt, MqttParser, Link, HostHub, deriveRoom } from '../js/net.js';

test('MQTT 报文：长报文变长长度编码，半包/粘包都能切开', () => {
  const big = 'x'.repeat(50000);
  const pub = mqtt.publish('bobing-cn/v3/abc/h', big);
  // 服务器下发给我们的 PUBLISH 与我们发出的格式相同
  const both = new Uint8Array(pub.length + 2);
  both.set(pub);
  both.set(Uint8Array.of(0xd0, 0), pub.length); // PINGRESP
  const p = new MqttParser();
  const out = [...p.push(both.subarray(0, 7)), ...p.push(both.subarray(7, 30000)), ...p.push(both.subarray(30000))];
  assert.equal(out.length, 2);
  assert.equal(out[0].type, 3);
  assert.equal(out[0].topic, 'bobing-cn/v3/abc/h');
  assert.equal(out[0].payload.length, 50000);
  assert.equal(out[1].type, 13);
  const connack = new MqttParser().push(Uint8Array.of(0x20, 2, 0, 0));
  assert.deepEqual(connack, [{ type: 2, rc: 0 }]);
});

test('房间密钥：主题名不含房间号；密文只有同房间号、同主题才能解开，篡改即失效', async () => {
  const a = await deriveRoom('ABCDEFGHJK');
  const a2 = await deriveRoom('ABCDEFGHJK');
  const b = await deriveRoom('ABCDEFGHJM');
  assert.equal(a.id, a2.id);
  assert.notEqual(a.id, b.id);
  assert.match(a.id, /^[0-9a-f]{32}$/);
  const ct = await a.seal('t/1', { k: 'd', m: '秘密' });
  assert.doesNotMatch(ct, /秘密|"k"/);
  assert.deepEqual(await a.open('t/1', ct), { k: 'd', m: '秘密' });
  assert.equal(await a.open('t/2', ct), null, '换主题重放无效');
  assert.equal(await b.open('t/1', ct), null, '别的房间号解不开');
  const bad = (ct[20] === 'A' ? 'B' : 'A');
  assert.equal(await a.open('t/1', ct.slice(0, 20) + bad + ct.slice(21)), null, '篡改后解不开');
  assert.equal(await a.open('t/1', '{"k":"bye","c":"x"}'), null, '明文伪造无效');
});

function fakeBroker() {
  return {
    sent: [],
    publishSealed(room, topic, obj) {
      this.sent.push({ topic, ...obj });
    },
  };
}

const room = { id: 'r0' };

test('Link：只接受本连接、计数递增的封包；伪造/重放的 bye 关不掉连接', () => {
  const br = fakeBroker();
  const link = new Link({ role: 'host', room, cid: 'c1', h: 'h1', broker: br });
  const got = [];
  link.on('data', (m) => got.push(m));
  assert.equal(link.accept({ k: 'd', s: 1, m: 'a', c: 'c1', h: 'h1', n: 1 }), true);
  assert.equal(link.accept({ k: 'd', s: 1, m: 'a', c: 'c1', h: 'h1', n: 1 }), false, '重放');
  assert.equal(link.accept({ k: 'bye', c: 'c1', h: 'hX', n: 9 }), false, '别的连接 id');
  assert.equal(link.accept({ k: 'bye', c: 'c2', h: 'h1', n: 9 }), false, '别的客人');
  assert.equal(link.accept({ k: 'bye', c: 'c1', h: 'h1', n: 1 }), false, '旧计数');
  assert.ok(link.open);
  assert.deepEqual(got, ['a']);
  // 发出的封包带连接标识与递增计数
  link.send({ hi: 1 });
  link.send({ hi: 2 });
  assert.deepEqual(br.sent.map((x) => [x.topic, x.c, x.h, x.n, x.s]), [
    ['bobing-cn/v3/r0/c/c1', 'c1', 'h1', 1, 1],
    ['bobing-cn/v3/r0/c/c1', 'c1', 'h1', 2, 2],
  ]);
  assert.equal(link.accept({ k: 'bye', c: 'c1', h: 'h1', n: 2 }), true);
  assert.ok(!link.open);
});

test('Link：乱序到达按序交付，缺号超时后跳过', async () => {
  const link = new Link({ role: 'host', room, cid: 'c1', h: 'h1', broker: fakeBroker() });
  const got = [];
  link.on('data', (m) => got.push(m));
  link.recv({ k: 'd', s: 2, m: 'b' });
  link.recv({ k: 'd', s: 1, m: 'a' });
  link.recv({ k: 'd', m: 'lossy' });
  assert.deepEqual(got, ['a', 'b', 'lossy']);
  link.recv({ k: 'd', s: 4, m: 'd' });
  assert.equal(got.at(-1), 'lossy', '缺 3，先等');
  await new Promise((r) => setTimeout(r, 1700));
  assert.equal(got.at(-1), 'd', '超时后跳过缺号');
  link.close(false);
});

function hub() {
  const links = [];
  const h = new HostHub('ABCDEFGHJK', (l) => links.push(l), []);
  h.room = room;
  return { h, links, A: fakeBroker(), B: fakeBroker() };
}

test('房主：客人正式发消息前可以换服务器敲门，发消息后固定在那台', () => {
  const { h, links, A, B } = hub();
  h.onEnvelope({ k: 'knock', c: 'c1', cn: 'n1' }, A);
  assert.equal(A.sent.length, 1);
  assert.equal(A.sent[0].k, 'ack');
  assert.equal(A.sent[0].cn, 'n1');
  // 客人断开了 A，没收到应答，改从 B 敲门：B 上也要应答
  h.onEnvelope({ k: 'knock', c: 'c1', cn: 'n1' }, B);
  assert.equal(B.sent.length, 1, 'B 上也应答');
  assert.equal(links.length, 1, '还是同一条连接');
  const link = links[0];
  const hid = B.sent[0].h;
  // 第一条正式消息从 B 来：固定在 B
  const data = [];
  link.on('data', (m) => data.push(m));
  h.onEnvelope({ k: 'd', s: 1, m: 'hello', c: 'c1', h: hid, n: 1 }, B);
  assert.equal(link.pinned, true);
  assert.equal(link.broker, B);
  assert.deepEqual(data, ['hello']);
  // 之后 A 上的敲门与消息都不理
  h.onEnvelope({ k: 'knock', c: 'c1', cn: 'n1' }, A);
  h.onEnvelope({ k: 'd', s: 2, m: 'x', c: 'c1', h: hid, n: 2 }, A);
  assert.equal(A.sent.length, 1);
  assert.deepEqual(data, ['hello']);
  // 伪造的第一条消息（连接 id 不对）不会让连接固定到错误的服务器
  h.onEnvelope({ k: 'knock', c: 'c2', cn: 'm' }, A);
  h.onEnvelope({ k: 'd', s: 1, m: 'evil', c: 'c2', h: 'guess', n: 1 }, B);
  assert.equal(links[1].pinned, undefined);
  assert.equal(links[1].broker, A);
  h.close();
});

test('房主：已关闭连接的旧敲门（重放）不会再建连接', () => {
  const { h, links, A } = hub();
  h.onEnvelope({ k: 'knock', c: 'c1', cn: 'n1' }, A);
  links[0].close(false);
  h.onEnvelope({ k: 'knock', c: 'c1', cn: 'n1' }, A);
  assert.equal(links.length, 1);
  assert.equal(h.links.size, 0);
  h.close();
});
