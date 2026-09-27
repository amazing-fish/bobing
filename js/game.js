// 博饼对局状态机（纯逻辑，无渲染/网络依赖，由房主端权威运行）
import { PRIZES, evaluate, compareZhuangyuan, totalCakes } from './rules.js';

export const MAX_PLAYERS = 8;

export function defaultPool() {
  return Object.fromEntries(PRIZES.map((p) => [p.id, p.count]));
}

export class BobingGame {
  constructor(pool = defaultPool()) {
    this.state = {
      phase: 'lobby', // lobby | playing | ended
      players: [],
      turn: 0,
      pool: sanitizePool(pool),
      initialPool: sanitizePool(pool),
      zy: null, // 当前状元持有者 { playerId, name, tier, score, dice }
      lastOutcome: null,
      log: [],
      throws: 0,
    };
  }

  get players() {
    return this.state.players;
  }

  addPlayer({ id, name, isBot = false }) {
    const s = this.state;
    const existing = s.players.find((p) => p.id === id);
    if (existing) {
      existing.online = true;
      if (name) existing.name = name;
      return existing;
    }
    if (s.players.length >= MAX_PLAYERS) throw new Error(`最多 ${MAX_PLAYERS} 位玩家`);
    const used = new Set(s.players.map((p) => p.seat));
    let seat = 0;
    while (used.has(seat)) seat++;
    const player = { id, name: String(name || '玩家').slice(0, 12), isBot, online: true, seat, won: {}, throws: 0 };
    s.players.push(player);
    return player;
  }

  /** 大厅中直接移除；对局中只标记离线，保留已得奖品 */
  removePlayer(id) {
    const s = this.state;
    const idx = s.players.findIndex((p) => p.id === id);
    if (idx < 0) return;
    if (s.phase === 'lobby') {
      s.players.splice(idx, 1);
    } else {
      s.players[idx].online = false;
      if (idx === s.turn && s.phase === 'playing') this.advanceTurn();
    }
  }

  setPool(pool) {
    if (this.state.phase !== 'lobby') throw new Error('对局开始后不能修改奖品');
    this.state.pool = sanitizePool(pool);
    this.state.initialPool = sanitizePool(pool);
  }

  start() {
    const s = this.state;
    if (s.players.length < 1) throw new Error('至少需要 1 位玩家');
    if (totalCakes(s.pool) < 1) throw new Error('奖品数量不能全为 0');
    s.phase = 'playing';
    s.turn = Math.floor(Math.random() * s.players.length);
    if (!s.players[s.turn].online) this.advanceTurn();
    this.pushLog(`开博！由 ${this.currentPlayer().name} 先掷`);
  }

  /** 再来一局：保留玩家与座位，重置奖品和记录 */
  rematch() {
    const s = this.state;
    s.players = s.players.filter((p) => p.online);
    for (const p of s.players) {
      p.won = {};
      p.throws = 0;
    }
    s.pool = { ...s.initialPool };
    s.zy = null;
    s.lastOutcome = null;
    s.log = [];
    s.throws = 0;
    s.phase = 'lobby';
  }

  currentPlayer() {
    return this.state.players[this.state.turn] || null;
  }

  advanceTurn() {
    const s = this.state;
    const n = s.players.length;
    for (let i = 1; i <= n; i++) {
      const idx = (s.turn + i) % n;
      if (s.players[idx].online) {
        s.turn = idx;
        return;
      }
    }
  }

  /**
   * 结算一次投掷
   * @param {string} playerId
   * @param {{dice: number[], out: boolean, cocked?: boolean}} roll out=有骰子掉出碗外
   */
  applyRoll(playerId, roll) {
    const s = this.state;
    if (s.phase !== 'playing') throw new Error('对局未进行');
    const player = this.currentPlayer();
    if (!player || player.id !== playerId) throw new Error('还没轮到你');

    player.throws++;
    s.throws++;
    const outcome = { playerId, name: player.name, dice: roll.dice, out: !!roll.out, result: null, award: null, gameOver: false };

    if (roll.out) {
      outcome.award = { type: 'void' };
      this.pushLog(`${player.name}：骰子掉出碗外，本轮作废`);
    } else {
      const result = evaluate(roll.dice);
      outcome.result = result;
      if (result.prize === 'zhuangyuan') {
        this.handleZhuangyuan(player, result, roll.dice, outcome);
      } else if (result.prize) {
        if (s.pool[result.prize] > 0) {
          s.pool[result.prize]--;
          player.won[result.prize] = (player.won[result.prize] || 0) + 1;
          outcome.award = { type: 'prize', prize: result.prize };
          this.pushLog(`${player.name}：${result.name}，得一个${result.name}饼`);
        } else {
          outcome.award = { type: 'exhausted', prize: result.prize };
          this.pushLog(`${player.name}：${result.name}，可惜${result.name}饼已博完`);
        }
      } else {
        outcome.award = { type: 'none' };
        this.pushLog(`${player.name}：没中`);
      }
    }

    if (this.checkGameOver()) {
      outcome.gameOver = true;
    } else {
      this.advanceTurn();
    }
    s.lastOutcome = outcome;
    return outcome;
  }

  handleZhuangyuan(player, result, dice, outcome) {
    const s = this.state;
    const holder = s.zy;
    const entry = { playerId: player.id, name: player.name, tier: result.tier, score: result.score, dice: [...dice], label: result.name };
    if (!holder) {
      s.zy = entry;
      outcome.award = { type: 'zy-new' };
      this.pushLog(`${player.name}：${result.name}！夺得状元`);
    } else if (holder.playerId === player.id) {
      if (compareZhuangyuan(result, holder) > 0) s.zy = entry;
      outcome.award = { type: 'zy-self' };
      this.pushLog(`${player.name}：${result.name}，状元仍在手中`);
    } else if (compareZhuangyuan(result, holder) > 0) {
      s.zy = entry;
      outcome.award = { type: 'zy-steal', from: holder.name };
      this.pushLog(`${player.name}：${result.name}！从 ${holder.name} 手中抢走状元`);
    } else {
      outcome.award = { type: 'zy-keep', holder: holder.name };
      this.pushLog(`${player.name}：${result.name}，没能大过 ${holder.name} 的${holder.label}`);
    }
  }

  /** 除状元外的奖品博完，且已有状元，则结束；状元饼归当前状元 */
  checkGameOver() {
    const s = this.state;
    const restLeft = PRIZES.filter((p) => p.id !== 'zhuangyuan').some((p) => s.pool[p.id] > 0);
    if (restLeft) return false;
    if (s.pool.zhuangyuan > 0 && !s.zy) return false;
    if (s.zy && s.pool.zhuangyuan > 0) {
      const winner = s.players.find((p) => p.id === s.zy.playerId);
      if (winner) winner.won.zhuangyuan = (winner.won.zhuangyuan || 0) + s.pool.zhuangyuan;
      s.pool.zhuangyuan = 0;
      this.pushLog(`奖品拿完！状元 ${s.zy.name}（${s.zy.label}）带走状元饼`);
    } else {
      this.pushLog('奖品拿完，本局结束');
    }
    s.phase = 'ended';
    return true;
  }

  pushLog(text) {
    const log = this.state.log;
    log.push({ t: Date.now(), text });
    if (log.length > 80) log.splice(0, log.length - 80);
  }

  snapshot() {
    return structuredClone(this.state);
  }
}

function sanitizePool(pool) {
  const out = {};
  for (const p of PRIZES) {
    const n = Math.floor(Number(pool?.[p.id] ?? p.count));
    out[p.id] = Number.isFinite(n) ? Math.min(99, Math.max(0, n)) : p.count;
  }
  return out;
}
