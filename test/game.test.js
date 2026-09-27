import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BobingGame } from '../js/game.js';

const d = (s) => [...s].map(Number);

function setup(pool) {
  const g = new BobingGame(pool);
  g.addPlayer({ id: 'a', name: 'A' });
  g.addPlayer({ id: 'b', name: 'B' });
  g.start();
  g.state.turn = 0;
  return g;
}

test('轮流投掷与领奖', () => {
  const g = setup();
  const o = g.applyRoll('a', { dice: d('412356'), out: false });
  assert.equal(o.award.type, 'prize');
  assert.equal(g.state.pool.duitang, 1);
  assert.equal(g.players[0].won.duitang, 1);
  assert.equal(g.currentPlayer().id, 'b');
  assert.throws(() => g.applyRoll('a', { dice: d('111111'), out: false }), /还没轮到你/);
});

test('掉出碗外本轮作废', () => {
  const g = setup();
  const o = g.applyRoll('a', { dice: d('444444'), out: true });
  assert.equal(o.award.type, 'void');
  assert.equal(g.state.zy, null);
  assert.equal(g.currentPlayer().id, 'b');
});

test('状元可被更大状元抢走，同级平手不抢', () => {
  const g = setup();
  g.applyRoll('a', { dice: d('444425'), out: false });
  assert.equal(g.state.zy.playerId, 'a');
  let o = g.applyRoll('b', { dice: d('444416'), out: false });
  assert.equal(o.award.type, 'zy-keep');
  assert.equal(g.state.zy.playerId, 'a');
  g.applyRoll('a', { dice: d('123356'), out: false });
  o = g.applyRoll('b', { dice: d('444441'), out: false });
  assert.equal(o.award.type, 'zy-steal');
  assert.equal(g.state.zy.playerId, 'b');
  assert.equal(g.state.zy.label, '五红');
});

test('奖项博完后不再发放', () => {
  const g = setup({ zhuangyuan: 1, duitang: 0, sanhong: 0, sijin: 0, erju: 0, yixiu: 2 });
  g.applyRoll('a', { dice: d('412236'), out: false });
  const o = g.applyRoll('b', { dice: d('442356'), out: false });
  assert.equal(o.award.type, 'exhausted');
});

test('其余奖品拿完且已有状元则结束，状元饼归状元', () => {
  const g = setup({ zhuangyuan: 1, duitang: 0, sanhong: 0, sijin: 0, erju: 0, yixiu: 1 });
  g.applyRoll('a', { dice: d('444423'), out: false });
  assert.equal(g.state.phase, 'playing');
  const o = g.applyRoll('b', { dice: d('412236'), out: false });
  assert.equal(o.gameOver, true);
  assert.equal(g.state.phase, 'ended');
  assert.equal(g.players[0].won.zhuangyuan, 1);
  assert.equal(g.state.pool.zhuangyuan, 0);
});

test('其余奖品拿完但无人夺状元时继续', () => {
  const g = setup({ zhuangyuan: 1, duitang: 0, sanhong: 0, sijin: 0, erju: 0, yixiu: 1 });
  g.applyRoll('a', { dice: d('412236'), out: false });
  assert.equal(g.state.phase, 'playing');
  const o = g.applyRoll('b', { dice: d('444443'), out: false });
  assert.equal(o.gameOver, true);
  assert.equal(g.players[1].won.zhuangyuan, 1);
});

test('离线玩家被跳过，大厅中直接移除', () => {
  const g = new BobingGame();
  g.addPlayer({ id: 'a', name: 'A' });
  g.addPlayer({ id: 'b', name: 'B' });
  g.addPlayer({ id: 'c', name: 'C' });
  g.removePlayer('c');
  assert.equal(g.players.length, 2);
  g.addPlayer({ id: 'c', name: 'C' });
  g.start();
  g.state.turn = 0;
  g.removePlayer('b');
  g.applyRoll('a', { dice: d('112233'), out: false });
  assert.equal(g.currentPlayer().id, 'c');
  // 重新加入恢复在线
  g.addPlayer({ id: 'b', name: 'B' });
  assert.equal(g.players[1].online, true);
});

test('再来一局保留玩家、重置奖品', () => {
  const g = setup();
  g.applyRoll('a', { dice: d('412356'), out: false });
  g.rematch();
  assert.equal(g.state.phase, 'lobby');
  assert.equal(g.state.pool.duitang, 2);
  assert.deepEqual(g.players[0].won, {});
  assert.equal(g.players.length, 2);
});

test('奖品数量做范围校验', () => {
  const g = new BobingGame({ zhuangyuan: -3, duitang: 'x', yixiu: 1000 });
  assert.equal(g.state.pool.zhuangyuan, 0);
  assert.equal(g.state.pool.duitang, 2);
  assert.equal(g.state.pool.yixiu, 99);
});
