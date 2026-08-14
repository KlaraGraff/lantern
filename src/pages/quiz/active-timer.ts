/**
 * 做题用时的前台活跃计时器。口径对齐阅读统计（reading-stats/session-tracker.ts）：
 * 只在前台计时；两次操作的间隔不满阈值照实计入——读一篇文章本来就可能几分钟
 * 不碰屏幕；间隔达到阈值整段剔除，「人走开的那段」不算用时。切到后台时把
 * blur 前的一段先封存（那段是真实做题），回前台重新起锚。
 *
 * 与 session-tracker 不共享实现：那边的产物是落库的分段记录（segment +
 * checkpoint + 写库队列），这边只要一个实时可读的累计值，硬套会把简单事情
 * 复杂化。纯模块，node 测试直接 import。
 */
export const QUIZ_IDLE_TIMEOUT_MS = 5 * 60 * 1000

export class ActiveTimer {
  private activeMs = 0
  /** 前台时为最近一次操作的时间戳；后台为 null（不计时） */
  private anchor: number | null
  private readonly idleTimeoutMs: number

  /** initialActiveMs：草稿续做时带入上次已累计的用时（draft.elapsedMs） */
  constructor(now: number, idleTimeoutMs: number = QUIZ_IDLE_TIMEOUT_MS, initialActiveMs = 0) {
    this.anchor = now
    this.idleTimeoutMs = idleTimeoutMs
    this.activeMs = initialActiveMs
  }

  /** 把锚点到 now 的间隔按阈值规则并入累计；负间隔（时钟回拨）同样整段丢弃 */
  private fold(now: number): void {
    if (this.anchor == null) return
    const gap = now - this.anchor
    if (gap >= 0 && gap < this.idleTimeoutMs) this.activeMs += gap
  }

  /** 用户操作（点击/按键/滚动/作答）。后台里冒出的操作视为回到前台。 */
  activity(now: number): void {
    this.fold(now)
    this.anchor = now
  }

  setForeground(foreground: boolean, now: number): void {
    if (foreground) {
      if (this.anchor == null) this.anchor = now
    } else {
      this.fold(now)
      this.anchor = null
    }
  }

  /**
   * 当前应显示/上报的用时。进行中的间隔未达阈值按实时计入；达到阈值后
   * 冻结在阈值前的累计——下一次操作会把这整段丢弃，读数随之回落，语义
   * 与「超过阈值的发呆不算」一致。
   */
  elapsedMs(now: number): number {
    if (this.anchor == null) return this.activeMs
    const gap = now - this.anchor
    if (gap >= 0 && gap < this.idleTimeoutMs) return this.activeMs + gap
    return this.activeMs
  }
}
