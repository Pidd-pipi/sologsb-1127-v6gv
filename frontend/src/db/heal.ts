import { db } from './index';
import type { RectifyPlan } from '../types/rectify';
import { latestInspectionByPoint } from '../utils/inspection';
import { deriveRectifyEffect, recalcRoutePassability } from '../utils/recalc';
import { makeId, toPlain } from '../utils/format';

/**
 * 一次性自愈：把库内历史数据按「每点位最新核验」重算整改条目状态与路段通行标记。
 * 升级前保存的路线 wheelchairPassable、整改条目状态可能停在旧结论上，首次加载时收敛一次。
 * 用模块级 Promise 去重，多个 store 并发加载只执行一遍。
 */
let healPromise: Promise<void> | null = null;

export function healDerivedData(): Promise<void> {
  if (!healPromise) healPromise = runHeal();
  return healPromise;
}

async function runHeal(): Promise<void> {
  for (let pass = 0; pass < 3; pass += 1) {
    const [points, inspections, rectifies, segments] = await Promise.all([
      db.points.toArray(),
      db.inspections.toArray(),
      db.rectifies.toArray(),
      db.routes.toArray(),
    ]);
    const latestByPoint = latestInspectionByPoint(inspections);
    const now = new Date().toISOString();

    const addPlans: RectifyPlan[] = [];
    const updatePlans: { id: string; patch: Partial<RectifyPlan> }[] = [];
    for (const point of points) {
      const effect = deriveRectifyEffect(
        point.id,
        latestByPoint.get(point.id),
        rectifies,
        () => makeId('rct'),
        now,
      );
      addPlans.push(...effect.adds);
      updatePlans.push(...effect.updates);
    }
    const routeChanges = recalcRoutePassability(segments, latestByPoint);

    if (!addPlans.length && !updatePlans.length && !routeChanges.length) return;

    await db.transaction('rw', db.rectifies, db.routes, async () => {
      if (addPlans.length) await db.rectifies.bulkAdd(toPlain(addPlans));
      for (const u of updatePlans) await db.rectifies.update(u.id, toPlain(u.patch));
      for (const c of routeChanges) {
        await db.routes.update(c.segment.id, { wheelchairPassable: c.passable });
      }
    });
  }
}
