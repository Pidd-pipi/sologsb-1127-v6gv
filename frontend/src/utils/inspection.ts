import type { Inspection } from '../types/inspection';

/**
 * 同日期时的先后次序：以录入时间（createdAt）为准。
 * 补录的核验日期可能早于既有核验，「最新」必须按核验日期 + 录入时间判定。
 */
export function compareInspectionRecency(a: Inspection, b: Inspection): number {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  if ((a.createdAt || '') !== (b.createdAt || '')) return a.createdAt < b.createdAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** 取一个点位的最新一次核验（日期相同时取后录入的一条） */
export function latestInspection(inspections: Inspection[]): Inspection | undefined {
  return inspections.reduce<Inspection | undefined>((latest, cur) => {
    if (!latest || compareInspectionRecency(cur, latest) > 0) return cur;
    return latest;
  }, undefined);
}

/** 按最新在前排序 */
export function sortInspectionsLatestFirst(inspections: Inspection[]): Inspection[] {
  return [...inspections].sort((a, b) => compareInspectionRecency(b, a));
}

/** 每个点位最新一次核验的索引 */
export function latestInspectionByPoint(inspections: Inspection[]): Map<string, Inspection> {
  const map = new Map<string, Inspection>();
  for (const ins of inspections) {
    const cur = map.get(ins.pointId);
    if (!cur || compareInspectionRecency(ins, cur) > 0) map.set(ins.pointId, ins);
  }
  return map;
}
