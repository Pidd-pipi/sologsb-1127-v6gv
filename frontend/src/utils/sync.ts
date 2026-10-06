/**
 * 跨标签页的数据变更广播。
 * 一个标签页落库后通知其它标签页重新从 IndexedDB 读取，避免另一页拿着旧快照做决策。
 * BroadcastChannel 可用时走专用通道；不可用时降级为 storage 事件（同源多页可收到）。
 */

const CHANNEL_NAME = 'gbaccessmap-db-sync';
const STORAGE_KEY = 'gbaccessmap-db-sync-ping';

export type SyncKind = 'points' | 'routes';

export interface SyncMessage {
  kind: SyncKind | 'all';
  at: number;
  /** 发送方标识，storage 降级方案里用来忽略自己触发的事件 */
  source: string;
}

type Listener = (msg: SyncMessage) => void;

export class DbSync {
  private channel: BroadcastChannel | null = null;
  private listeners = new Set<Listener>();
  private source: string;
  private storageHandler: ((e: StorageEvent) => void) | null = null;

  constructor() {
    this.source = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    if (typeof BroadcastChannel !== 'undefined') {
      this.channel = new BroadcastChannel(CHANNEL_NAME);
      this.channel.onmessage = (e: MessageEvent<SyncMessage>) => {
        if (e.data && e.data.source !== this.source) this.dispatch(e.data);
      };
    } else if (typeof window !== 'undefined' && window.addEventListener) {
      this.storageHandler = (e: StorageEvent) => {
        if (e.key !== STORAGE_KEY || !e.newValue) return;
        try {
          const msg = JSON.parse(e.newValue) as SyncMessage;
          if (msg.source !== this.source) this.dispatch(msg);
        } catch {
          /* 忽略无法解析的 ping */
        }
      };
      window.addEventListener('storage', this.storageHandler);
    }
  }

  private dispatch(msg: SyncMessage) {
    this.listeners.forEach((fn) => fn(msg));
  }

  /** 订阅其它标签页的数据变更通知 */
  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** 通知其它标签页（本页不会收到自己的通知） */
  post(kind: SyncKind | 'all'): void {
    const msg: SyncMessage = { kind, at: Date.now(), source: this.source };
    if (this.channel) {
      this.channel.postMessage(msg);
    } else if (typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(msg));
      } catch {
        /* 存储不可用时跨页通知静默失效，本页状态不受影响 */
      }
    }
  }
}

export const dbSync = new DbSync();
