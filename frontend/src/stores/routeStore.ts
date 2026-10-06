import { create } from 'zustand';
import { db } from '../db';
import { healDerivedData } from '../db/heal';
import type { AccessPoint } from '../types/point';
import type { RouteSegment } from '../types/route';
import { makeId, toPlain } from '../utils/format';
import { buildVerdict, judgeSegmentWithEndpoints } from '../utils/routeCheck';
import { segmentLength } from '../utils/geo';
import { latestInspectionByPoint } from '../utils/inspection';
import { dbSync } from '../utils/sync';
import type { RouteVerdict } from '../types/route';

function sortSegments(rows: RouteSegment[]): RouteSegment[] {
  return rows.sort((a, b) =>
    a.routeName === b.routeName ? a.order - b.order : a.routeName.localeCompare(b.routeName),
  );
}

/** 编辑中的路段（尚未落库） */
export interface DraftSegment {
  key: string;
  fromPointId: string;
  toPointId: string;
  length: number;
  obstacleCount: number;
  stepCount: number;
  curbHeight: number;
  order: number;
}

interface RouteState {
  segments: RouteSegment[];
  loaded: boolean;
  loading: boolean;
  error: string;
  draftName: string;
  chain: string[];
  draftSegments: DraftSegment[];
  verdict: RouteVerdict | null;
  load: () => Promise<void>;
  /** 收到其它标签页变更通知后静默重读，不发广播、不重复自愈 */
  refreshFromDb: () => Promise<void>;
  setDraftName: (name: string) => void;
  setChain: (ids: string[]) => void;
  toggleChainPoint: (id: string) => void;
  buildChainSegments: (points: AccessPoint[]) => void;
  updateDraftSegment: (key: string, patch: Partial<DraftSegment>) => void;
  removeDraftSegment: (key: string) => void;
  computeVerdict: () => Promise<RouteVerdict>;
  saveRoute: () => Promise<number>;
  resetDraft: () => void;
}

function newKey(): string {
  return `seg-${Math.random().toString(36).slice(2, 9)}`;
}

export const useRouteStore = create<RouteState>((set, get) => ({
  segments: [],
  loaded: false,
  loading: false,
  error: '',
  draftName: '无障碍通行路线',
  chain: [],
  draftSegments: [],
  verdict: null,

  load: async () => {
    set({ loading: true, error: '' });
    try {
      await healDerivedData();
      await get().refreshFromDb();
      set({ loading: false, loaded: true });
    } catch (e) {
      set({ loading: false, loaded: true, error: e instanceof Error ? e.message : String(e) });
    }
  },

  refreshFromDb: async () => {
    const rows = await db.routes.toArray();
    set({ segments: sortSegments(rows) });
  },

  setDraftName: (name) => set({ draftName: name }),

  setChain: (ids) => set({ chain: ids, verdict: null }),

  toggleChainPoint: (id) => {
    const chain = get().chain;
    set({
      chain: chain.includes(id) ? chain.filter((x) => x !== id) : [...chain, id],
      verdict: null,
    });
  },

  /** 选好起终点与途经点后自动串联路段 */
  buildChainSegments: (points) => {
    const chain = get().chain;
    const byId = new Map(points.map((p) => [p.id, p]));
    const ordered = chain.map((id) => byId.get(id)).filter(Boolean) as AccessPoint[];
    const draftSegments: DraftSegment[] = [];
    for (let i = 1; i < ordered.length; i += 1) {
      const from = ordered[i - 1];
      const to = ordered[i];
      draftSegments.push({
        key: newKey(),
        fromPointId: from.id,
        toPointId: to.id,
        length: segmentLength({ lng: from.lng, lat: from.lat }, { lng: to.lng, lat: to.lat }),
        obstacleCount: 0,
        stepCount: 0,
        curbHeight: 2,
        order: i,
      });
    }
    set({ draftSegments, verdict: null });
  },

  updateDraftSegment: (key, patch) =>
    set((s) => ({
      draftSegments: s.draftSegments.map((seg) => (seg.key === key ? { ...seg, ...patch } : seg)),
      verdict: null,
    })),

  removeDraftSegment: (key) =>
    set((s) => ({
      draftSegments: s.draftSegments
        .filter((seg) => seg.key !== key)
        .map((seg, i) => ({ ...seg, order: i + 1 })),
      verdict: null,
    })),

  computeVerdict: async () => {
    const { draftSegments, draftName } = get();
    const [inspections, pointRows] = await Promise.all([db.inspections.toArray(), db.points.toArray()]);
    const latestByPoint = latestInspectionByPoint(inspections);
    const pointNames = new Map(pointRows.map((p) => [p.id, p.name]));
    const verdict = buildVerdict(draftName, draftSegments, (pointId) => {
      const latest = latestByPoint.get(pointId);
      return { conclusion: latest?.conclusion, name: pointNames.get(pointId) ?? pointId };
    });
    set({ verdict });
    return verdict;
  },

  saveRoute: async () => {
    const { draftSegments, draftName } = get();
    // 保存即按端点最新核验结论判定，避免新建路线带上旧的可通行判断
    const [inspections] = await Promise.all([db.inspections.toArray()]);
    const latestByPoint = latestInspectionByPoint(inspections);
    const rows: RouteSegment[] = draftSegments.map((seg) => {
      const from = latestByPoint.get(seg.fromPointId);
      const to = latestByPoint.get(seg.toPointId);
      const judged = judgeSegmentWithEndpoints({
        seg,
        from: from ? { conclusion: from.conclusion } : undefined,
        to: to ? { conclusion: to.conclusion } : undefined,
      });
      return toPlain({
        id: makeId('rts'),
        routeName: draftName || '未命名路线',
        fromPointId: seg.fromPointId,
        toPointId: seg.toPointId,
        length: seg.length,
        obstacleCount: seg.obstacleCount,
        stepCount: seg.stepCount,
        curbHeight: seg.curbHeight,
        wheelchairPassable: judged.passable,
        order: seg.order,
        createdAt: new Date().toISOString(),
      });
    });
    if (!rows.length) return 0;
    await db.routes.bulkPut(rows);
    const all = await db.routes.toArray();
    set({ segments: sortSegments(all) });
    dbSync.post('routes');
    return rows.length;
  },

  resetDraft: () => set({ draftSegments: [], verdict: null, chain: [] }),
}));
