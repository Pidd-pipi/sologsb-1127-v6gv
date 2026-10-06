/**
 * 数据变更广播：本标签页写库后通知其他标签页重新拉取对应表，
 * 避免另一个标签页的内存状态停在旧数据（旧结论 / 旧合格率 / 旧路线判定）。
 *
 * - 跨标签页：BroadcastChannel（降级 storage 事件兜底）；
 * - 同标签页：store 写完后直接更新自身状态，不需要自收自发。
 */
export type ChangedTable = 'points' | 'inspections' | 'rectifies' | 'routes';

export interface DbChangeMessage {
  /** 变更涉及的表，收到的 store 按表决定是否重载 */
  tables: ChangedTable[];
  /** 发送方标识，用于忽略本标签页自己的消息 */
  origin: string;
}

const CHANNEL_NAME = 'gbaccessmap-db-changes';
const FALLBACK_KEY = 'gbaccessmap-db-change';

const origin = `tab-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
type Listener = (tables: ChangedTable[]) => void;
const listeners = new Set<Listener>();

let channel: BroadcastChannel | null = null;
if (typeof BroadcastChannel !== 'undefined') {
  channel = new BroadcastChannel(CHANNEL_NAME);
  channel.onmessage = (e: MessageEvent<DbChangeMessage>) => {
    const msg = e.data;
    if (!msg || msg.origin === origin) return;
    listeners.forEach((fn) => fn(msg.tables));
  };
} else if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  // BroadcastChannel 不可用时用 localStorage storage 事件兜底
  window.addEventListener('storage', (e) => {
    if (e.key !== FALLBACK_KEY || !e.newValue) return;
    try {
      const msg = JSON.parse(e.newValue) as DbChangeMessage;
      if (msg.origin === origin) return;
      listeners.forEach((fn) => fn(msg.tables));
    } catch {
      /* 忽略无法解析的兜底消息 */
    }
  });
}

/** 订阅其他标签页的库变更；返回取消订阅函数 */
export function subscribeDbChanges(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 通知其他标签页：这些表刚被本标签页写过 */
export function notifyDbChanged(tables: ChangedTable[]): void {
  const msg: DbChangeMessage = { tables, origin };
  if (channel) {
    channel.postMessage(msg);
  } else if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(FALLBACK_KEY, JSON.stringify({ ...msg, at: Date.now() }));
    } catch {
      /* 存储不可用时静默 */
    }
  }
}
