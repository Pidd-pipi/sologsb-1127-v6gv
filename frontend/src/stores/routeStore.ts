import { create } from 'zustand';
import { db } from '../db';
import type { AccessPoint } from '../types/point';
import type { RouteSegment } from '../types/route';
import { makeId, toPlain } from '../utils/format';
import { judgeSegment, buildVerdict } from '../utils/routeCheck';
import { segmentLength } from '../utils/geo';
import type { RouteVerdict } from '../types/route';
import { usePointStore } from './pointStore';
import { subscribeDbChanges, notifyDbChanged } from '../utils/dbEvents';

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
  load: (silent?: boolean) => Promise<void>;
  setDraftName: (name: string) => void;
  setChain: (ids: string[]) => void;
  toggleChainPoint: (id: string) => void;
  buildChainSegments: (points: AccessPoint[]) => void;
  updateDraftSegment: (key: string, patch: Partial<DraftSegment>) => void;
  removeDraftSegment: (key: string) => void;
  computeVerdict: () => RouteVerdict;
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

  load: async (silent = false) => {
    if (!silent) set({ loading: true, error: '' });
    try {
      const rows = await db.routes.toArray();
      set({
        segments: rows.sort((a, b) =>
          a.routeName === b.routeName ? a.order - b.order : a.routeName.localeCompare(b.routeName),
        ),
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

  computeVerdict: () => {
    const { draftSegments, draftName } = get();
    const points = usePointStore.getState().points;
    const latestByPoint = usePointStore.getState().latestInspectionMap();
    const nameOf = (id: string) => points.find((p) => p.id === id)?.name ?? id;
    const verdict = buildVerdict(draftName, draftSegments, { latestByPoint, nameOf });
    set({ verdict });
    return verdict;
  },

  saveRoute: async () => {
    const { draftSegments, draftName } = get();
    const points = usePointStore.getState().points;
    const latestByPoint = usePointStore.getState().latestInspectionMap();
    const nameOf = (id: string) => points.find((p) => p.id === id)?.name ?? id;
    const rows: RouteSegment[] = draftSegments.map((seg) =>
      toPlain({
        id: makeId('rts'),
        routeName: draftName || '未命名路线',
        fromPointId: seg.fromPointId,
        toPointId: seg.toPointId,
        length: seg.length,
        obstacleCount: seg.obstacleCount,
        stepCount: seg.stepCount,
        curbHeight: seg.curbHeight,
        // 保存时即按「物理条件 + 端点最新核验结论」联合判定
        wheelchairPassable: judgeSegment(seg, { latestByPoint, nameOf }).passable,
        order: seg.order,
        createdAt: new Date().toISOString(),
      }),
    );
    if (!rows.length) return 0;
    await db.routes.bulkPut(rows);
    const all = await db.routes.toArray();
    set({
      segments: all.sort((a, b) =>
        a.routeName === b.routeName ? a.order - b.order : a.routeName.localeCompare(b.routeName),
      ),
    });
    notifyDbChanged(['routes']);
    return rows.length;
  },

  resetDraft: () => set({ draftSegments: [], verdict: null, chain: [] }),
}));

// 核验 / 整改 / 点位在其他标签页变化后，路线通行标记可能已被联动重算，静默刷新明细
subscribeDbChanges((tables) => {
  if (!useRouteStore.getState().loaded) return;
  if (tables.some((t) => ['routes', 'inspections', 'points', 'rectifies'].includes(t))) {
    void useRouteStore.getState().load(true);
  }
});
