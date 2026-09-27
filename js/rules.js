// 博饼规则：判定六颗骰子的奖项，以及状元之间的大小比较
// 奖项从小到大：一秀 < 二举 < 四进 < 三红 < 对堂 < 状元
// 同时满足多个奖项时按最高奖项算（例如 4个1+2个4 算四进，不算二举）

export const PRIZES = [
  { id: 'zhuangyuan', name: '状元', alias: '状元饼', count: 1, desc: '4个及以上的4，或5/6颗相同' },
  { id: 'duitang', name: '对堂', alias: '榜眼', count: 2, desc: '1、2、3、4、5、6 顺子' },
  { id: 'sanhong', name: '三红', alias: '探花', count: 4, desc: '3个4' },
  { id: 'sijin', name: '四进', alias: '进士', count: 8, desc: '4个相同点数，不能是4' },
  { id: 'erju', name: '二举', alias: '举人', count: 16, desc: '2个4' },
  { id: 'yixiu', name: '一秀', alias: '秀才', count: 32, desc: '1个4' },
];

export const PRIZE_BY_ID = Object.fromEntries(PRIZES.map((p) => [p.id, p]));

// 状元等级从小到大，tier 越大越强
export const ZY_LEVELS = [
  { tier: 1, name: '四红', desc: '4个4，剩余2颗点数和更大者赢' },
  { tier: 2, name: '五子登科', desc: '5颗相同（不是4），剩余1颗越大越强' },
  { tier: 3, name: '五红', desc: '5个4，剩余1颗越大越强' },
  { tier: 4, name: '六勃黑', desc: '6颗相同的2/3/5/6，点数越大越强' },
  { tier: 5, name: '遍地锦', desc: '6个1' },
  { tier: 6, name: '状元插金花', desc: '4个4 + 2个1' },
  { tier: 7, name: '六杯红', desc: '6个4，全场最大' },
];

const TIER_NAME = Object.fromEntries(ZY_LEVELS.map((l) => [l.tier, l.name]));

/**
 * 判定一次投掷
 * @param {number[]} dice 6 个 1..6 的点数
 * @returns {{prize: string|null, name: string, tier?: number, score?: number}}
 *   prize 为奖项 id（未中奖为 null）；状元另带 tier 与可比较的 score
 */
export function evaluate(dice) {
  if (!Array.isArray(dice) || dice.length !== 6 || dice.some((d) => !Number.isInteger(d) || d < 1 || d > 6)) {
    throw new Error('需要 6 个 1..6 的整数点数');
  }
  const c = [0, 0, 0, 0, 0, 0, 0];
  for (const d of dice) c[d]++;
  const fours = c[4];
  const sum = dice.reduce((a, b) => a + b, 0);
  const zy = (tier, tie) => ({ prize: 'zhuangyuan', name: TIER_NAME[tier], tier, score: tier * 100 + tie });

  if (fours === 6) return zy(7, 0);
  if (fours === 4 && c[1] === 2) return zy(6, 0);
  if (c[1] === 6) return zy(5, 0);
  for (const v of [2, 3, 5, 6]) if (c[v] === 6) return zy(4, v);
  if (fours === 5) return zy(3, sum - 20);
  for (const v of [1, 2, 3, 5, 6]) {
    // 剩余那颗优先比较，其次比较五子本身的点数
    if (c[v] === 5) return zy(2, (sum - 5 * v) * 10 + v);
  }
  if (fours === 4) return zy(1, sum - 16);

  if (c.slice(1).every((n) => n === 1)) return { prize: 'duitang', name: '对堂' };
  if (fours === 3) return { prize: 'sanhong', name: '三红' };
  if ([1, 2, 3, 5, 6].some((v) => c[v] === 4)) return { prize: 'sijin', name: '四进' };
  if (fours === 2) return { prize: 'erju', name: '二举' };
  if (fours === 1) return { prize: 'yixiu', name: '一秀' };
  return { prize: null, name: '没中' };
}

/** 比较两个状元结果：>0 表示 a 更大 */
export function compareZhuangyuan(a, b) {
  return a.score - b.score;
}

export function totalCakes(pool) {
  return Object.values(pool).reduce((a, b) => a + b, 0);
}
