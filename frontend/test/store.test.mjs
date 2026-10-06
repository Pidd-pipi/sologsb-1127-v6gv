// Dexie 集成冒烟：补录核验触发整改/路线联动；双标签页冲突检测
import 'fake-indexeddb/auto';
import { strict as assert } from 'node:assert';

// 标记非浏览器，避免同步模块触碰 window；Dexie 在 node + fake-indexeddb 下可用
globalThis.BroadcastChannel = class {
  constructor() {}
  postMessage() {}
};

const { db, ensureSeed } = await import('../src/db/index.ts');
const { healDerivedData } = await import('../src/db/heal.ts');
const { usePointStore } = await import('../src/stores/pointStore.ts');
const { useRouteStore } = await import('../src/stores/routeStore.ts');

let n = 0;
const ok = (m) => {
  n += 1;
  console.log(`✓ ${m}`);
};

await ensureSeed();
await healDerivedData();
await usePointStore.getState().load();
await useRouteStore.getState().load();

const insp = (id, pointId, date, conclusion, extra = {}) => ({
  id, pointId, date, inspector: 't', slope: 1, clearWidth: 200,
  hasHandrail: true, tactileContinuous: true, occupied: '无',
  conclusion, problem: '', createdAt: `${date}T00:00:00Z`, ...extra,
});

// 1. 补录合格核验 → pt-1007（seed 待整改、路线无关）结案
const before = await db.rectifies.where('pointId').equals('pt-1007').toArray();
assert.ok(before.some((r) => r.status === '待整改'));

const r1 = await usePointStore.getState().addInspection({
  pointId: 'pt-1007', date: '2026-10-01', inspector: 't', slope: 3, clearWidth: 150,
  hasHandrail: true, tactileContinuous: true, occupied: '无', conclusion: '合格', problem: '整改完成',
});
assert.equal(r1.outcome, 'saved');
const afterPass = await db.rectifies.where('pointId').equals('pt-1007').toArray();
assert.ok(afterPass.every((r) => r.status === '已整改'));
assert.ok(afterPass.every((r) => r.recheckDate === '2026-10-01'));
ok('补录合格：整改条目结案且复检日期=核验日期');

// 2. 再补录不合格 → 最近结案条目退回复发
const r2 = await usePointStore.getState().addInspection({
  pointId: 'pt-1007', date: '2026-10-05', inspector: 't', slope: 9.5, clearWidth: 80,
  hasHandrail: false, tactileContinuous: false, occupied: '长期占用', conclusion: '不合格', problem: '再次被占',
});
assert.equal(r2.outcome, 'saved');
const afterFail = await db.rectifies.where('pointId').equals('pt-1007').toArray();
assert.ok(afterFail.some((r) => r.status === '复发'));
ok('再不合格：退回复发');

// 3. 路线联动：seed 路线 pt-1001→pt-1002，当前段 passable=true
// 让 pt-1001 最新结论变不合格
const r3 = await usePointStore.getState().addInspection({
  pointId: 'pt-1001', date: '2026-10-05', inspector: 't', slope: 9.5, clearWidth: 80,
  hasHandrail: false, tactileContinuous: false, occupied: '长期占用', conclusion: '不合格', problem: '堵',
});
assert.equal(r3.outcome, 'saved');
const segs = await db.routes.toArray();
assert.ok(segs.length > 0);
assert.ok(segs.every((s) => s.wheelchairPassable === false));
ok('端点点位不合格：经过它的路线段 wheelchairPassable 重算为 false');

// routeStore 同页也刷新
assert.ok(useRouteStore.getState().segments.every((s) => s.wheelchairPassable === false));
ok('同页 routeStore 已同步最新通行判定');

// pt-1001 恢复合格 → 路线恢复（pt-1002 是限期整改，不阻断）
await usePointStore.getState().addInspection({
  pointId: 'pt-1001', date: '2026-10-06', inspector: 't', slope: 3, clearWidth: 150,
  hasHandrail: true, tactileContinuous: true, occupied: '无', conclusion: '合格', problem: '',
});
const segs2 = await db.routes.toArray();
assert.ok(segs2.every((s) => s.wheelchairPassable === true));
ok('端点恢复合格：路线段自动恢复可通行');

// 4. 冲突检测：模拟另一标签页直接落库了一条更新的核验
const knownLatest = (await db.inspections.where('pointId').equals('pt-1003').toArray())
  .sort((a, b) => (a.date < b.date ? 1 : -1))[0].id;
// “另一标签页”写入
await db.inspections.put(insp('ins-other', 'pt-1003', '2026-10-06', '不合格'));
const conflictRes = await usePointStore.getState().addInspection(
  {
    pointId: 'pt-1003', date: '2026-10-06', inspector: 'me', slope: 2, clearWidth: 160,
    hasHandrail: true, tactileContinuous: true, occupied: '无', conclusion: '合格', problem: '',
  },
  { expectedLatestId: knownLatest },
);
assert.equal(conflictRes.outcome, 'conflict');
assert.equal(conflictRes.conflict.incoming.id, 'ins-other');
ok('后保存者检测到对方刚录的核验，返回冲突而非覆盖');

// 选择放弃我的：库里不新增
const cntDiscard = await db.inspections.where('pointId').equals('pt-1003').count();
const discarded = await conflictRes.retry('discard');
assert.equal(discarded.outcome, 'saved');
const afterDiscard = await db.inspections.where('pointId').equals('pt-1003').count();
assert.equal(afterDiscard, cntDiscard);
ok('选择「采用对方」：不写入自己的核验');

// 再来一次冲突，这次保留我的：两条都在
await db.inspections.put(insp('ins-other-2', 'pt-1003', '2026-10-07', '不合格'));
const baseId = (await db.inspections.where('pointId').equals('pt-1003').toArray())
  .map((x) => x.id).includes('ins-other')
  ? 'ins-other'
  : undefined;
const c2 = await usePointStore.getState().addInspection(
  {
    pointId: 'pt-1003', date: '2026-10-07', inspector: 'me', slope: 2, clearWidth: 160,
    hasHandrail: true, tactileContinuous: true, occupied: '无', conclusion: '合格', problem: '',
  },
  { expectedLatestId: baseId },
);
assert.equal(c2.outcome, 'conflict');
const kept = await c2.retry('keep');
assert.equal(kept.outcome, 'saved');
const mine = await db.inspections.where('pointId').equals('pt-1003').toArray();
assert.ok(mine.some((x) => x.id === 'ins-other-2'));
assert.ok(mine.some((x) => x.inspector === 'me'));
ok('选择「仍保存我的」：两条核验都保留，互不覆盖');

// 5. 总览合格率口径：按每点位最新结论
const { latestInspectionByPoint } = await import('../src/utils/inspection.ts');
const allIns = await db.inspections.toArray();
const latestMap = latestInspectionByPoint(allIns);
const pt1007Latest = latestMap.get('pt-1007');
assert.equal(pt1007Latest.conclusion, '不合格'); // 最新是 10-05 复发那次
ok('最新结论索引按日期取到复发后的不合格');

console.log(`\n${n} 项集成测试全部通过`);
process.exit(0);
