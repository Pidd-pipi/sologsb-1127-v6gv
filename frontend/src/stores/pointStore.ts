import { create } from 'zustand';
import { db, ensureSeed } from '../db';
import { healDerivedData } from '../db/heal';
import type { AccessPoint, AccessPointDraft } from '../types/point';
import type { Inspection, InspectionDraft } from '../types/inspection';
import type { RectifyPlan, RectifyPlanDraft } from '../types/rectify';
import { makeId, toPlain } from '../utils/format';
import {
  compareInspectionRecency,
  latestInspectionByPoint,
  sortInspectionsLatestFirst,
} from '../utils/inspection';
import { deriveRectifyEffect, recalcRoutePassability } from '../utils/recalc';
import { dbSync } from '../utils/sync';
import { useRouteStore } from './routeStore';

/** 保存核验时的冲突：库里已存在比本页快照更新的核验（通常是另一标签页刚录的） */
export interface InspectionConflict {
  /** 对方刚录的核验 */
  incoming: Inspection;
  /** 本页本次待保存的核验 */
  pending: Inspection;
}

export type AddInspectionResult =
  | { outcome: 'saved'; inspection: Inspection }
  | { outcome: 'conflict'; conflict: InspectionConflict; retry: (decision: 'keep' | 'discard') => Promise<AddInspectionResult> };

interface PointState {
  points: AccessPoint[];
  inspections: Inspection[];
  rectifies: RectifyPlan[];
  loading: boolean;
  loaded: boolean;
  error: string;
  load: () => Promise<void>;
  /** 收到其它标签页变更通知后静默重读，不发广播、不重复自愈 */
  refreshFromDb: () => Promise<void>;
  addPoint: (draft: AccessPointDraft) => Promise<AccessPoint>;
  addInspection: (
    draft: InspectionDraft,
    options?: {
      /** 本页已知的最新核验 id；保存时若库里的最新核验不是它，判定为冲突 */
      expectedLatestId?: string;
      /** 已确认冲突仍要保留本条（用户选择「仍保存我的」），跳过冲突检测 */
      force?: boolean;
    },
  ) => Promise<AddInspectionResult>;
  addRectify: (draft: RectifyPlanDraft) => Promise<RectifyPlan>;
  updateRectify: (id: string, patch: Partial<RectifyPlan>) => Promise<void>;
  getPoint: (id: string) => AccessPoint | undefined;
  inspectionsOf: (pointId: string) => Inspection[];
  rectifiesOf: (pointId: string) => RectifyPlan[];
}

function sortByDeadline(list: RectifyPlan[]): RectifyPlan[] {
  return [...list].sort((a, b) => (a.deadline < b.deadline ? -1 : 1));
}

export const usePointStore = create<PointState>((set, get) => ({
  points: [],
  inspections: [],
  rectifies: [],
  loading: false,
  loaded: false,
  error: '',

  load: async () => {
    set({ loading: true, error: '' });
    try {
      await ensureSeed();
      await healDerivedData();
      await get().refreshFromDb();
      set({ loading: false, loaded: true });
    } catch (e) {
      set({ loading: false, loaded: true, error: e instanceof Error ? e.message : String(e) });
    }
  },

  refreshFromDb: async () => {
    const [points, inspections, rectifies] = await Promise.all([
      db.points.toArray(),
      db.inspections.toArray(),
      db.rectifies.toArray(),
    ]);
    set({
      points: points.sort((a, b) => a.code.localeCompare(b.code)),
      inspections: sortInspectionsLatestFirst(inspections),
      rectifies: sortByDeadline(rectifies),
    });
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
    set((s) => ({ points: [...s.points, point].sort((a, b) => a.code.localeCompare(b.code)) }));
    dbSync.post('points');
    return point;
  },

  addInspection: async (draft, options) => {
    const inspection: Inspection = toPlain({
      ...draft,
      id: makeId('ins'),
      createdAt: new Date().toISOString(),
    });

    // 保存前先看库里的最新核验是否已被别的标签页更新；是的话把选择权交回页面
    if (!options?.force && options?.expectedLatestId) {
      const all = await db.inspections.where('pointId').equals(inspection.pointId).toArray();
      const dbLatest = sortInspectionsLatestFirst(all)[0];
      if (dbLatest && dbLatest.id !== options.expectedLatestId) {
        const conflict: InspectionConflict = { incoming: dbLatest, pending: inspection };
        return {
          outcome: 'conflict',
          conflict,
          retry: async (decision) => {
            if (decision === 'discard') {
              await get().refreshFromDb();
              return { outcome: 'saved', inspection: dbLatest };
            }
            return get().addInspection(draft, { expectedLatestId: dbLatest.id, force: true });
          },
        };
      }
    }

    await db.transaction(
      'rw',
      db.inspections,
      db.rectifies,
      db.routes,
      db.points,
      async () => {
        await db.inspections.put(inspection);

        // 结论一变即按最新核验重算整改条目：合格结案记复检日期，再不合格退回复发/新建
        const all = await db.inspections.where('pointId').equals(inspection.pointId).toArray();
        const latest = sortInspectionsLatestFirst(all)[0];
        if (latest && latest.id === inspection.id) {
          const existing = await db.rectifies.where('pointId').equals(inspection.pointId).toArray();
          const effect = deriveRectifyEffect(
            inspection.pointId,
            latest,
            existing,
            () => makeId('rct'),
            new Date().toISOString(),
          );
          if (effect.adds.length) await db.rectifies.bulkAdd(toPlain(effect.adds));
          for (const u of effect.updates) await db.rectifies.update(u.id, toPlain(u.patch));
        }

        // 经过该点位的路线按新结论重算能否轮椅通行
        const [segments, inspectionsAll] = await Promise.all([db.routes.toArray(), db.inspections.toArray()]);
        const changes = recalcRoutePassability(segments, latestInspectionByPoint(inspectionsAll));
        for (const c of changes) await db.routes.update(c.segment.id, { wheelchairPassable: c.passable });

        await db.points.update(inspection.pointId, { updatedAt: new Date().toISOString() });
      },
    );

    await get().refreshFromDb();
    // 路线能否轮椅通行依赖点位最新结论，同步刷新同页路线 store（跨标签页由 dbSync 通知）
    await useRouteStore.getState().refreshFromDb();
    dbSync.post('points');
    return { outcome: 'saved', inspection };
  },

  addRectify: async (draft) => {
    const plan: RectifyPlan = toPlain({
      ...draft,
      id: makeId('rct'),
      createdAt: new Date().toISOString(),
    });
    await db.rectifies.put(plan);
    set((s) => ({ rectifies: sortByDeadline([...s.rectifies, plan]) }));
    dbSync.post('points');
    return plan;
  },

  updateRectify: async (id, patch) => {
    const plain = toPlain(patch);
    await db.rectifies.update(id, plain);
    set((s) => ({
      rectifies: sortByDeadline(s.rectifies.map((r) => (r.id === id ? { ...r, ...plain } : r))),
    }));
    dbSync.post('points');
  },

  getPoint: (id) => get().points.find((p) => p.id === id),

  inspectionsOf: (pointId) =>
    get()
      .inspections.filter((i) => i.pointId === pointId)
      .sort((a, b) => compareInspectionRecency(b, a)),

  rectifiesOf: (pointId) =>
    get()
      .rectifies.filter((r) => r.pointId === pointId)
      .sort((a, b) => (a.deadline < b.deadline ? -1 : 1)),
}));
