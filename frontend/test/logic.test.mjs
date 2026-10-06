// 纯逻辑冒烟测试：最新核验选取、整改派生、路段重判
// 运行：npx esbuild test/logic.test.mjs --bundle --platform=node --format=esm | node
import { strict as assert } from 'node:assert';
import {
  compareInspectionRecency,
  latestInspection,
  latestInspectionByPoint,
} from '../src/utils/inspection.ts';
import { deriveRectifyEffect, recalcRoutePassability } from '../src/utils/recalc.ts';
import { buildVerdict, judgeSegmentWithEndpoints } from '../src/utils/routeCheck.ts';

let n = 0;
const ok = (name) => {
  n += 1;
  console.log(`✓ ${name}`);
};

const ins = (id, pointId, date, conclusion, extra = {}) => ({
  id,
  pointId,
  date,
  inspector: 't',
  slope: 1,
  clearWidth: 200,
  hasHandrail: true,
  tactileContinuous: true,
  occupied: '无',
  conclusion,
  problem: '',
  createdAt: id === 'later' ? '2026-10-06T10:00:00Z' : `2026-10-06T09:00:00Z`,
  ...extra,
});

// 1. 最新核验：日期为主，同日期以录入时间为准
const list = [
  ins('a', 'p1', '2026-09-01', '不合格'),
  ins('b', 'p1', '2026-10-01', '合格'),
  ins('later', 'p2', '2026-10-01', '合格', { createdAt: '2026-10-01T12:00:00Z' }),
  ins('earlier', 'p2', '2026-10-01', '不合格', { createdAt: '2026-10-01T08:00:00Z' }),
];
assert.equal(latestInspection(list.filter((x) => x.pointId === 'p1')).id, 'b');
assert.equal(latestInspection(list.filter((x) => x.pointId === 'p2')).id, 'later');
assert.ok(compareInspectionRecency(list[2], list[3]) > 0);
ok('最新核验按日期、同日按录入时间');

// 补录：新核验日期更早，但结论为最新录入 —— “最新一次核验”按核验日期，不是录入时间
const backdated = [
  ins('old', 'p3', '2026-10-05', '不合格'),
  ins('back', 'p3', '2026-08-01', '合格', { createdAt: '2026-10-06T18:00:00Z' }),
];
assert.equal(latestInspection(backdated).id, 'old');
ok('补录更早日期的核验不会顶掉更新日期的结论');

const map = latestInspectionByPoint(list);
assert.equal(map.get('p1').conclusion, '合格');

const plan = (id, pointId, status, recheckDate = '') => ({
  id,
  pointId,
  requirement: 'r',
  unit: 'u',
  deadline: '2026-11-01',
  recheckDate,
  status,
  createdAt: '2026-09-01T00:00:00Z',
});
let seq = 0;
const newId = () => `new-${(seq += 1)}`;
const now = '2026-10-06T00:00:00Z';

// 2. 不合格→合格：在办条目结案、记复检日期
let eff = deriveRectifyEffect(
  'p1',
  ins('b', 'p1', '2026-10-01', '合格'),
  [plan('r1', 'p1', '待整改'), plan('r2', 'p1', '复发')],
  newId,
  now,
);
assert.equal(eff.adds.length, 0);
assert.deepEqual(eff.updates.map((u) => u.patch.status), ['已整改', '已整改']);
assert.ok(eff.updates.every((u) => u.patch.recheckDate === '2026-10-01'));
ok('转合格：待整改/复发条目结案并记复检日期');

// 3. 已整改→再不合格：最近结案条目退回复发
eff = deriveRectifyEffect(
  'p1',
  ins('b', 'p1', '2026-10-02', '不合格'),
  [
    plan('r1', 'p1', '已整改', '2026-09-01'),
    plan('r2', 'p1', '已整改', '2026-09-20'),
  ],
  newId,
  now,
);
assert.equal(eff.adds.length, 0);
assert.equal(eff.updates.length, 1);
assert.equal(eff.updates[0].id, 'r2');
assert.equal(eff.updates[0].patch.status, '复发');
ok('再不合格：最近的已整改条目退回复发');

// 4. 不合格且无任何条目：新建待整改
eff = deriveRectifyEffect('p9', ins('x', 'p9', '2026-10-02', '不合格'), [], newId, now);
assert.equal(eff.adds.length, 1);
assert.equal(eff.adds[0].status, '待整改');
assert.ok(eff.adds[0].deadline > '2026-10-02');
ok('不合格且无条目：新建待整改');

// 5. 不合格但有在办条目：不动
eff = deriveRectifyEffect(
  'p1',
  ins('b', 'p1', '2026-10-02', '不合格'),
  [plan('r1', 'p1', '待整改')],
  newId,
  now,
);
assert.equal(eff.adds.length + eff.updates.length, 0);
ok('仍有在办条目时不重复新建');

// 6. 限期整改：不新建不结案
eff = deriveRectifyEffect(
  'p1',
  ins('b', 'p1', '2026-10-02', '限期整改'),
  [plan('r1', 'p1', '待整改')],
  newId,
  now,
);
assert.equal(eff.adds.length + eff.updates.length, 0);
ok('限期整改保持在办条目继续跟踪');

// 7. 路段：端点不合格 → 不可通行，并能标出卡在哪段
const seg = (id, order, from, to) => ({
  id,
  routeName: 'R',
  fromPointId: from,
  toPointId: to,
  length: 10,
  obstacleCount: 0,
  stepCount: 0,
  curbHeight: 1,
  wheelchairPassable: true,
  order,
  createdAt: now,
});
const segs = [seg('s1', 1, 'good', 'p1'), seg('s2', 2, 'p1', 'good')];
const latest = new Map([
  ['good', ins('g', 'good', '2026-10-01', '合格')],
  ['p1', ins('b2', 'p1', '2026-10-02', '不合格')],
]);
const changed = recalcRoutePassability(segs, latest);
assert.equal(changed.length, 2);
assert.ok(changed.every((c) => c.passable === false));
ok('经过不合格点位的路段重判为不可通行');

// 端点恢复合格后自动解除
const latest2 = new Map([
  ['good', ins('g', 'good', '2026-10-01', '合格')],
  ['p1', ins('b3', 'p1', '2026-10-03', '合格')],
]);
const blocked = segs.map((s) => ({ ...s, wheelchairPassable: false }));
const cleared = recalcRoutePassability(blocked, latest2);
assert.equal(cleared.length, 2);
assert.ok(cleared.every((c) => c.passable === true));
ok('点位恢复合格后路段自动解除阻断');

// buildVerdict 标出卡点段
const verdict = buildVerdict('R', segs, (pid) => {
  const by = { good: { conclusion: '合格', name: '好点' }, p1: { conclusion: '不合格', name: '坏点' } };
  return by[pid];
});
assert.equal(verdict.passable, false);
assert.ok(verdict.reasons.some((r) => r.includes('第 1 段')));
assert.ok(verdict.reasons.some((r) => r.includes('第 2 段')));
assert.ok(verdict.reasons.join('').includes('坏点'));
ok('全线判定标出卡在哪一段及点位');

// 单段：自身台阶 + 端点原因并存
const j = judgeSegmentWithEndpoints({
  seg: { curbHeight: 1, stepCount: 2, obstacleCount: 0 },
  from: { conclusion: '不合格', name: 'A' },
  to: { conclusion: '合格', name: 'B' },
});
assert.equal(j.passable, false);
assert.ok(j.reasons.some((r) => r.includes('台阶')));
assert.ok(j.reasons.some((r) => r.includes('A')));
ok('单段原因同时包含路段本身与端点结论');

console.log(`\n${n} 项全部通过`);
