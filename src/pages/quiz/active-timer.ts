/**
 * 做题用时的前台活跃计时器。口径对齐阅读统计（reading-stats/session-tracker.ts）：
 * 只在前台计时；两次操作的间隔不满阈值照实计入——读一篇文章本来就可能几分钟
 * 不碰屏幕；间隔达到阈值整段剔除，「人走开的那段」不算用时。切到后台时把
 * blur 前的一段先封存（那段是真实做题），回前台重新起锚。
 *
 * 两道独立的闸：前台闸（setForeground）与可用闸（setAvailable，语义是
 * 「有可做的篇」——渐进发卷期间所有篇都没就绪时不该计时）。两道闸都开着
 * 才计时，任一关着就封存；分别记两个标志位，不用单个 anchor 猜谁关了谁。
 * activity() 里保留一个不对称：前台闸关着时冒出的操作仍视为回到前台（例如
 * focus 事件早到/迟到的竞态，用户显然已经在看）；可用闸关着时操作起不了
 * 作用——没有可做的篇，点击也变不出一篇来，原样忽略。
 *
 * 与 session-tracker 不共享实现：那边的产物是落库的分段记录（segment +
 * checkpoint + 写库队列），这边只要一个实时可读的累计值，硬套会把简单事情
 * 复杂化。纯模块，node 测试直接 import。
 */
export const QUIZ_IDLE_TIMEOUT_MS = 5 * 60 * 1000

export class ActiveTimer {
  private activeMs = 0
  /** 两道闸都开时为最近一次操作的时间戳；任一闸关着为 null（不计时） */
  private anchor: number | null
  private readonly idleTimeoutMs: number
  /** 前台闸 */
  private foreground = true
  /** 可用闸：有可做的篇。默认开——不调用 setAvailable 的调用方行为不变 */
  private available = true

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

  /**
   * 用户操作（点击/按键/滚动/作答）。可用闸关着时忽略——没有可做的篇，
   * 操作起不了作用。可用闸开着时，前台闸关着（后台）冒出的操作视为回到
   * 前台，从该操作起锚。
   */
  activity(now: number): void {
    if (!this.available) return
    this.fold(now)
    this.anchor = now
    this.foreground = true
  }

  setForeground(foreground: boolean, now: number): void {
    this.foreground = foreground
    if (foreground) {
      if (this.available && this.anchor == null) this.anchor = now
    } else {
      this.fold(now)
      this.anchor = null
    }
  }

  /** available：是否有可做的篇。语义与 setForeground 对称。 */
  setAvailable(available: boolean, now: number): void {
    this.available = available
    if (available) {
      if (this.foreground && this.anchor == null) this.anchor = now
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
