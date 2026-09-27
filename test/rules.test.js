import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, compareZhuangyuan } from '../js/rules.js';

const ev = (s) => evaluate([...s].map(Number));

test('普通奖项', () => {
  assert.equal(ev('412356').prize, 'duitang');
  assert.equal(ev('123456').prize, 'duitang');
  assert.equal(ev('444123').prize, 'sanhong');
  assert.equal(ev('222215').prize, 'sijin');
  assert.equal(ev('442356').prize, 'erju');
  assert.equal(ev('412236').prize, 'yixiu');
  assert.equal(ev('112233').prize, null);
});

test('同时满足多个奖项按最高算', () => {
  // 4个1 + 2个4：四进 大于 二举
  assert.equal(ev('111144').prize, 'sijin');
  // 4个4 + 2个1：状元插金花，而非四红
  assert.deepEqual([ev('444411').prize, ev('444411').name], ['zhuangyuan', '状元插金花']);
  // 3个4 + 3个2：三红
  assert.equal(ev('444222').prize, 'sanhong');
});

test('状元等级识别', () => {
  assert.equal(ev('444423').name, '四红');
  assert.equal(ev('333336').name, '五子登科');
  assert.equal(ev('444446').name, '五红');
  assert.equal(ev('555555').name, '六勃黑');
  assert.equal(ev('111111').name, '遍地锦');
  assert.equal(ev('444411').name, '状元插金花');
  assert.equal(ev('444444').name, '六杯红');
});

test('状元等级从小到大', () => {
  const order = ['444423', '333336', '444446', '555555', '111111', '444411', '444444'].map(ev);
  for (let i = 1; i < order.length; i++) assert.ok(compareZhuangyuan(order[i], order[i - 1]) > 0, `${order[i].name} > ${order[i - 1].name}`);
  // 最大的四红 小于 最小的五子登科
  assert.ok(compareZhuangyuan(ev('444466'), ev('111112')) < 0);
  // 最大的五子登科 小于 最小的五红
  assert.ok(compareZhuangyuan(ev('555556'), ev('444441')) < 0);
});

test('同级比较剩余骰子', () => {
  assert.ok(compareZhuangyuan(ev('444456'), ev('444423')) > 0, '四红：剩余和 11 > 5');
  assert.equal(compareZhuangyuan(ev('444425'), ev('444416')), 0, '四红：剩余和相同为平手');
  assert.ok(compareZhuangyuan(ev('444446'), ev('444442')) > 0, '五红：剩余越大越强');
  assert.ok(compareZhuangyuan(ev('222226'), ev('666665')) > 0, '五子登科：先比剩余那颗');
  assert.ok(compareZhuangyuan(ev('666663'), ev('222223')) > 0, '五子登科：剩余相同再比点数');
  assert.ok(compareZhuangyuan(ev('666666'), ev('222222')) > 0, '六勃黑：点数越大越强');
});

test('非法输入', () => {
  assert.throws(() => evaluate([1, 2, 3]));
  assert.throws(() => evaluate([1, 2, 3, 4, 5, 7]));
});
