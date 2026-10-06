import type { Inspection } from '../types/inspection';
import type { RectifyPlan } from '../types/rectify';

/**
 * 标准比较器：a 更早（旧）返回负数，a 更晚（新）返回正数。
 * 先比核验日期；同一天以录入时间 createdAt 为准；再相同退化为 id，保证稳定。
 */
export function compareInspections(a: Inspection, b: Inspection): number {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  // createdAt 可能带不同时区写法（Z / 无后缀），统一按时间戳比较
  const ta = Date.parse(a.createdAt || '') || 0;
  const tb = Date.parse(b.createdAt || '') || 0;
  if (ta !== tb) return ta < tb ? -1 : 1;
  return a.id < b.id ? -1 : 1;
}

/** 每个点位的最新一次核验（按核验日期、再按录入时间） */
export function latestByPoint(inspections: Inspection[]): Map<string, Inspection> {
  const map = new Map<string, Inspection>();
  for (const ins of inspections) {
    const cur = map.get(ins.pointId);
    if (!cur || compareInspections(ins, cur) > 0) map.set(ins.pointId, ins);
  }
  return map;
}

/**
 * 按点位最新结论重算单条整改条目状态：
 * - 最新「合格」：未结案条目 → 已整改（复检日期取最新核验日期），已整改保持不变；
 * - 最新「不合格」：已整改条目 → 复发（问题反弹），待整改/复发保持不变；
 * - 最新「限期整改」/无核验：状态不动（限期整改条目继续跟踪）。
 * 返回需要落库的补丁；无需变更时返回 null。
 */
export function reconcileRectify(
  plan: RectifyPlan,
  latest?: Inspection,
): Partial<Pick<RectifyPlan, 'status' | 'recheckDate'>> | null {
  if (!latest) return null;
  if (latest.conclusion === '合格') {
    if (plan.status === '已整改') return null;
    return { status: '已整改', recheckDate: latest.date };
  }
  if (latest.conclusion === '不合格') {
    if (plan.status === '已整改') {
      return { status: '复发', recheckDate: latest.date };
    }
    return null;
  }
  return null;
}

/**
 * 全量对账一批整改条目，返回需要更新的条目及其补丁。
 */
export function reconcileRectifies(
  plans: RectifyPlan[],
  latestMap: Map<string, Inspection>,
): Array<{ id: string; patch: Partial<RectifyPlan> }> {
  const updates: Array<{ id: string; patch: Partial<RectifyPlan> }> = [];
  for (const plan of plans) {
    const patch = reconcileRectify(plan, latestMap.get(plan.pointId));
    if (patch) updates.push({ id: plan.id, patch });
  }
  return updates;
}
