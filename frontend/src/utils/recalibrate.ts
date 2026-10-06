import { db } from '../db';
import { judgeSegment } from './routeCheck';
import { latestByPoint, reconcileRectifies } from './reconcile';
import type { RouteSegment } from '../types/route';

/**
 * 一次性数据校准（启动加载时幂等执行）：
 * 1. 按每个点位最新一次核验，重算全部整改条目的结案 / 复发状态；
 * 2. 按路段物理条件 + 端点最新结论，重算全部已保存路段的 wheelchairPassable。
 *
 * 老数据在「补录核验」逻辑上线前，整改状态与路线通行标记都可能停在旧判断，
 * 这里把它们校正一次；后续写入路径各自增量维护，无需重复全量扫描。
 */
export async function recalibrateDerivedData(): Promise<void> {
  await db.transaction('rw', db.rectifies, db.routes, db.inspections, async () => {
    const inspections = await db.inspections.toArray();
    const latestMap = latestByPoint(inspections);

    const plans = await db.rectifies.toArray();
    const planUpdates = reconcileRectifies(plans, latestMap);
    for (const { id, patch } of planUpdates) {
      await db.rectifies.update(id, patch);
    }

    const segments: RouteSegment[] = await db.routes.toArray();
    for (const seg of segments) {
      const passable = judgeSegment(seg, { latestByPoint: latestMap }).passable;
      if (passable !== seg.wheelchairPassable) {
        await db.routes.update(seg.id, { wheelchairPassable: passable });
      }
    }
  });
}
