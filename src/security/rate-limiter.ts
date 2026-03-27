/**
 * 滑动窗口频率限制
 * 存在于 Durable Object 内存中，按 agentId 独立计数
 */

import type { RateWindow } from '../types.js';

export class RateLimiter {
  private windows = new Map<string, RateWindow>();
  private readonly limitPerMinute: number;
  private readonly windowMs = 60_000;

  constructor(limitPerMinute: number) {
    this.limitPerMinute = limitPerMinute;
  }

  /**
   * 检查是否允许通过
   * @returns true = 允许，false = 超限
   */
  check(agentId: string): boolean {
    const now = Date.now();
    const cutoff = now - this.windowMs;

    let window = this.windows.get(agentId);
    if (!window) {
      window = { timestamps: [] };
      this.windows.set(agentId, window);
    }

    // 移除超出窗口的旧记录
    window.timestamps = window.timestamps.filter(t => t > cutoff);

    if (window.timestamps.length >= this.limitPerMinute) {
      return false;  // 超限
    }

    window.timestamps.push(now);
    return true;
  }

  /** 获取某 agent 当前窗口内的消息数 */
  count(agentId: string): number {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    const window = this.windows.get(agentId);
    if (!window) return 0;
    return window.timestamps.filter(t => t > cutoff).length;
  }

  /** Agent 断线后清理，释放内存 */
  remove(agentId: string): void {
    this.windows.delete(agentId);
  }
}
