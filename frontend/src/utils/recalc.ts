import type { Inspection } from '../types/inspection';
import type { RectifyPlan } from '../types/rectify';
import type { RouteSegment } from '../types/route';
import { judgeSegmentWithEndpoints } from './routeCheck';
import { addDays } from './format';

/**
 * 结论驱动的派生数据重算。
 * 规则（均以每个点位「最新一次核验」为准）：
 * - 最新结论转「合格」：该点位所有未结案整改条目 → 已整改，复检日期记为本次核验日期；
 * - 最新结论为「不合格」：已结案条目退回复发；没有任何在办条目则新建待整改条目；
 * - 「限期整改」保持在办条目继续跟踪，不自动结案也不新建；
 * - 经过点位的路段：端点最新结论为「不合格」时该段判定不可轮椅通行，结论恢复后自动解除。
 */

export interface RectifyEffect {
  adds: RectifyPlan[];
  updates: { id: string; patch: Partial<RectifyPlan> }[];
}

/** 不合格且无在办条目时的整改期限（天） */
const RECTIFY_DEADLINE_DAYS = 30;

/** 按某点位最新核验结论，计算整改条目应有的增改 */
export function deriveRectifyEffect(
  pointId: string,
  latest: Inspection | undefined,
  existing: RectifyPlan[],
  makePlanId: () => string,
  now: string,
): RectifyEffect {
  const adds: RectifyPlan[] = [];
  const updates: { id: string; patch: Partial<RectifyPlan> }[] = [];
  if (!latest) return { adds, updates };

  const mine = existing.filter((r) => r.pointId === pointId);
  const openPlans = mine.filter((r) => r.status !== '已整改');

  if (latest.conclusion === '合格') {
    // 转合格结案：在办（待整改/复发）条目全部结案，记下复检日期
    for (const plan of openPlans) {
      const recheckDate = latest.date || plan.recheckDate;
      if (plan.status !== '已整改' || plan.recheckDate !== recheckDate) {
        updates.push({ id: plan.id, patch: { status: '已整改', recheckDate } });
      }
    }
    return { adds, updates };
  }

  if (latest.conclusion === '不合格') {
    if (openPlans.length) {
      // 在办条目继续跟踪：待整改保持待整改；已是复发的保持复发，均不改动
      return { adds, updates };
    }
    const closed = mine
      .filter((r) => r.status === '已整改')
      .sort((a, b) => (a.recheckDate < b.recheckDate ? 1 : a.recheckDate > b.recheckDate ? -1 : 0));
    if (closed.length) {
      // 整改后再次不合格：最近一条已结案条目退回复发
      updates.push({ id: closed[0].id, patch: { status: '复发' } });
    } else {
      // 从未立过整改条目：新建待整改条目
      adds.push({
        id: makePlanId(),
        pointId,
        requirement: `按 ${latest.date} 核验结论整改：${latest.problem || '坡度、净宽或占用问题'}`,
        unit: '待指派责任单位',
        deadline: addDays(latest.date, RECTIFY_DEADLINE_DAYS),
        recheckDate: '',
        status: '待整改',
        createdAt: now,
      });
    }
  }

  // 限期整改：不新增、不结案
  return { adds, updates };
}

/**
 * 按全部点位最新核验重算路段可通行性，返回需要落库更新的路段（值未变的不动）。
 * 卡点原因在展示层通过 buildVerdict 的端点解析器输出到「第 N 段」。
 */
export function recalcRoutePassability(
  segments: RouteSegment[],
  latestByPoint: Map<string, Inspection>,
): { segment: RouteSegment; passable: boolean }[] {
  const changed: { segment: RouteSegment; passable: boolean }[] = [];
  for (const seg of segments) {
    const from = latestByPoint.get(seg.fromPointId);
    const to = latestByPoint.get(seg.toPointId);
    const { passable } = judgeSegmentWithEndpoints({
      seg,
      from: from ? { conclusion: from.conclusion } : undefined,
      to: to ? { conclusion: to.conclusion } : undefined,
    });
    if (passable !== seg.wheelchairPassable) changed.push({ segment: seg, passable });
  }
  return changed;
}
