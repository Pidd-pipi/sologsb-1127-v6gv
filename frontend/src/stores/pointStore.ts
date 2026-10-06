import { create } from 'zustand';
import { db, ensureSeed } from '../db';
import type { AccessPoint, AccessPointDraft } from '../types/point';
import type { Inspection, InspectionDraft } from '../types/inspection';
import type { RectifyPlan, RectifyPlanDraft } from '../types/rectify';
import type { RouteSegment } from '../types/route';
import { makeId, toPlain, todayStr, addDays } from '../utils/format';
import { judgeSegment } from '../utils/routeCheck';
import { latestByPoint, reconcileRectify, compareInspections } from '../utils/reconcile';
import { recalibrateDerivedData } from '../utils/recalibrate';
import { notifyDbChanged, subscribeDbChanges } from '../utils/dbEvents';

export interface AddInspectionResult {
  inspection: Inspection;
  /** 本次核验是否把未结案整改条目转为已整改 */
  closedRectify: boolean;
  /** 本次核验是否把已整改条目打回复发 */
  relapsedRectify: boolean;
  /** 本次核验是否新建了整改条目 */
  createdRectify: boolean;
  /** 受结论变化影响、轮椅通行标记被重算的路段数 */
  affectedRoutes: number;
}

interface PointState {
  points: AccessPoint[];
  inspections: Inspection[];
  rectifies: RectifyPlan[];
  loading: boolean;
  loaded: boolean;
  error: string;
  load: (silent?: boolean) => Promise<void>;
  addPoint: (draft: AccessPointDraft) => Promise<AccessPoint>;
  addInspection: (draft: InspectionDraft) => Promise<AddInspectionResult>;
  addRectify: (draft: RectifyPlanDraft) => Promise<RectifyPlan>;
  updateRectify: (id: string, patch: Partial<RectifyPlan>) => Promise<void>;
  getPoint: (id: string) => AccessPoint | undefined;
  inspectionsOf: (pointId: string) => Inspection[];
  rectifiesOf: (pointId: string) => RectifyPlan[];
  /** 每个点位最新一次核验（供路线判定等跨 store 场景直接取用） */
  latestInspectionMap: () => Map<string, Inspection>;
}

const sortPoints = (list: AccessPoint[]) => [...list].sort((a, b) => a.code.localeCompare(b.code));
const sortInspections = (list: Inspection[]) =>
  [...list].sort((a, b) => -compareInspections(a, b));
const sortRectifies = (list: RectifyPlan[]) =>
  [...list].sort((a, b) => (a.deadline < b.deadline ? -1 : 1));

let recalibrated = false;

export const usePointStore = create<PointState>((set, get) => ({
  points: [],
  inspections: [],
  rectifies: [],
  loading: false,
  loaded: false,
  error: '',

  load: async (silent = false) => {
    if (!silent) set({ loading: true, error: '' });
    try {
      await ensureSeed();
      if (!recalibrated) {
        // 首次加载：把历史整改条目 / 路线标记校正到「按最新核验联动」的口径
        await recalibrateDerivedData();
        recalibrated = true;
      }
      const [points, inspections, rectifies] = await Promise.all([
        db.points.toArray(),
        db.inspections.toArray(),
        db.rectifies.toArray(),
      ]);
      set({
        points: sortPoints(points),
        inspections: sortInspections(inspections),
        rectifies: sortRectifies(rectifies),
        loading: false,
        loaded: true,
      });
    } catch (e) {
      set({
        loading: false,
        loaded: true,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  },

  addPoint: async (draft) => {
    const now = new Date().toISOString();
    const point: AccessPoint = toPlain({
      ...draft,
      id: makeId('pt'),
      createdAt: now,
      updatedAt: now,
    });
    await db.points.put(point);
    set((s) => ({ points: sortPoints([...s.points, point]) }));
    notifyDbChanged(['points']);
    return point;
  },

  addInspection: async (draft) => {
    const inspection: Inspection = toPlain({
      ...draft,
      id: makeId('ins'),
      createdAt: new Date().toISOString(),
    });

    let closedRectify = false;
    let relapsedRectify = false;
    let createdRectify = false;
    let changedRouteCount = 0;

    // 核验写入、整改条目联动、途经路线重算放在同一事务，保证落库一致
    await db.transaction(
      'rw',
      db.inspections,
      db.rectifies,
      db.routes,
      async () => {
        await db.inspections.put(inspection);

        const pointInspections = await db.inspections.where({ pointId: inspection.pointId }).toArray();
        const latest = pointInspections.sort((a, b) => -compareInspections(a, b))[0];

        // 1) 重算该点位全部整改条目：合格→结案记复检日期；再不合格→退回复发
        const plans = await db.rectifies.where({ pointId: inspection.pointId }).toArray();
        for (const plan of plans) {
          const patch = reconcileRectify(plan, latest);
          if (patch) {
            if (patch.status === '已整改') closedRectify = true;
            if (patch.status === '复发') relapsedRectify = true;
            await db.rectifies.update(plan.id, patch);
            Object.assign(plan, patch);
          }
        }

        // 2) 结论为不合格且重算后仍没有任何在办 / 复发条目时，自动补建整改条目形成闭环
        //    （要按重算后的状态判断：「已整改→再不合格」会先转「复发」，
        //    用核验前的快照会误再建一条待整改）
        const openExists = plans.some((r) => r.status !== '已整改');
        if (latest.conclusion === '不合格' && !openExists) {
          await db.rectifies.add({
            id: makeId('rct'),
            pointId: latest.pointId,
            requirement: `按 ${latest.date} 核验结论整改：${latest.problem || '坡度、净宽或占用问题'}`,
            unit: '待指派责任单位',
            deadline: addDays(latest.date || todayStr(), 30),
            recheckDate: '',
            status: '待整改',
            createdAt: new Date().toISOString(),
          });
          createdRectify = true;
        }

        // 3) 重算所有经过该点位的路线段：物理条件 + 端点最新结论
        const latestMap = latestByPoint(await db.inspections.toArray());
        const touched: RouteSegment[] = await db.routes
          .where('fromPointId')
          .equals(inspection.pointId)
          .or('toPointId')
          .equals(inspection.pointId)
          .toArray();
        for (const seg of touched) {
          const passable = judgeSegment(seg, { latestByPoint: latestMap }).passable;
          if (passable !== seg.wheelchairPassable) {
            await db.routes.update(seg.id, { wheelchairPassable: passable });
            changedRouteCount += 1;
          }
        }
      },
    );

    // 事务成功后统一刷新内存状态（同标签页视图立刻联动）
    const [inspections, rectifies] = await Promise.all([
      db.inspections.toArray(),
      db.rectifies.toArray(),
    ]);
    set({ inspections: sortInspections(inspections), rectifies: sortRectifies(rectifies) });
    notifyDbChanged(['inspections', 'rectifies', 'routes']);

    return {
      inspection,
      closedRectify,
      relapsedRectify,
      createdRectify,
      affectedRoutes: changedRouteCount,
    };
  },

  addRectify: async (draft) => {
    const plan: RectifyPlan = toPlain({
      ...draft,
      id: makeId('rct'),
      createdAt: new Date().toISOString(),
    });
    await db.rectifies.put(plan);
    set((s) => ({ rectifies: sortRectifies([...s.rectifies, plan]) }));
    notifyDbChanged(['rectifies']);
    return plan;
  },

  updateRectify: async (id, patch) => {
    const plain = toPlain(patch);
    await db.rectifies.update(id, plain);
    set((s) => ({
      rectifies: sortRectifies(
        s.rectifies.map((r) => (r.id === id ? { ...r, ...plain } : r)),
      ),
    }));
    notifyDbChanged(['rectifies']);
  },

  getPoint: (id) => get().points.find((p) => p.id === id),

  inspectionsOf: (pointId) =>
    get()
      .inspections.filter((i) => i.pointId === pointId)
      .sort((a, b) => -compareInspections(a, b)),

  rectifiesOf: (pointId) =>
    get()
      .rectifies.filter((r) => r.pointId === pointId)
      .sort((a, b) => (a.deadline < b.deadline ? -1 : 1)),

  latestInspectionMap: () => latestByPoint(get().inspections),
}));

// 其他标签页写库后，静默重载受影响的表，避免本标签页继续显示旧结论 / 旧合格率
subscribeDbChanges((tables) => {
  if (!usePointStore.getState().loaded) return;
  if (tables.includes('points') || tables.includes('inspections') || tables.includes('rectifies')) {
    void usePointStore.getState().load(true);
  }
});
