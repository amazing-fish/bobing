// MQTT 报文编解码 与 Link 的有序交付（不连真实服务器）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mqtt, MqttParser, Link } from '../js/net.js';

test('MQTT 报文：长报文变长长度编码，半包/粘包都能切开', () => {
  const big = 'x'.repeat(50000);
  const pub = mqtt.publish('bobing-cn/v2/ABCDE/h', big);
  // 服务器下发给我们的 PUBLISH 与我们发出的格式相同
  const both = new Uint8Array(pub.length + 2);
  both.set(pub);
  both.set(Uint8Array.of(0xd0, 0), pub.length); // PINGRESP
  const p = new MqttParser();
  const out = [...p.push(both.subarray(0, 7)), ...p.push(both.subarray(7, 30000)), ...p.push(both.subarray(30000))];
  assert.equal(out.length, 2);
  assert.equal(out[0].type, 3);
  assert.equal(out[0].topic, 'bobing-cn/v2/ABCDE/h');
  assert.equal(out[0].payload.length, 50000);
  assert.equal(out[1].type, 13);
  const connack = new MqttParser().push(Uint8Array.of(0x20, 2, 0, 0));
  assert.deepEqual(connack, [{ type: 2, rc: 0 }]);
});

test('Link：乱序到达按序交付，重复的丢弃，缺号超时后跳过', async () => {
  const sent = [];
  const link = new Link({ role: 'host', code: 'ABCDE', cid: 'c1', broker: { publish: (t, m) => sent.push([t, m]) } });
  const got = [];
  link.on('data', (m) => got.push(m));
  link.recv({ k: 'd', s: 2, m: 'b' });
  link.recv({ k: 'd', s: 1, m: 'a' });
  link.recv({ k: 'd', s: 1, m: 'a' });
  link.recv({ k: 'd', m: 'lossy' });
  assert.deepEqual(got, ['a', 'b', 'lossy']);
  link.recv({ k: 'd', s: 4, m: 'd' });
  assert.deepEqual(got.at(-1), 'lossy', '缺 3，先等');
  await new Promise((r) => setTimeout(r, 2700));
  assert.equal(got.at(-1), 'd', '超时后跳过缺号');
  // 发送：有序消息带序号，发往客人的专属主题
  link.send({ hi: 1 });
  assert.equal(sent[0][0], 'bobing-cn/v2/ABCDE/c/c1');
  assert.equal(sent[0][1].s, 1);
  let closed = false;
  link.on('close', () => (closed = true));
  link.recv({ k: 'bye' });
  assert.ok(closed && !link.open);
});
