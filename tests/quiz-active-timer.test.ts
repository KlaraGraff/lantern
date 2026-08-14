/**
 * 做题用时的前台活跃计时口径（src/pages/quiz/active-timer.ts）：
 * 后台不计，超过阈值的发呆整段不计，未达阈值的间隔照实计入。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ActiveTimer, QUIZ_IDLE_TIMEOUT_MS } from '../src/pages/quiz/active-timer.ts'

const MIN = 60 * 1000

describe('quiz · 前台活跃计时', () => {
  it('阈值内的操作间隔照实累计', () => {
    const t = new ActiveTimer(0)
    t.activity(2 * MIN)
    t.activity(6 * MIN)
    assert.equal(t.elapsedMs(6 * MIN), 6 * MIN)
  })

  it('达到阈值的发呆整段剔除，之后从新锚点继续', () => {
    const t = new ActiveTimer(0)
    t.activity(2 * MIN)
    // 发呆 5 分钟（正好达到阈值）后回来操作：这 5 分钟不算
    t.activity(2 * MIN + QUIZ_IDLE_TIMEOUT_MS)
    assert.equal(t.elapsedMs(2 * MIN + QUIZ_IDLE_TIMEOUT_MS), 2 * MIN)
    // 回来后的正常间隔照常累计
    t.activity(2 * MIN + QUIZ_IDLE_TIMEOUT_MS + MIN)
    assert.equal(t.elapsedMs(2 * MIN + QUIZ_IDLE_TIMEOUT_MS + MIN), 3 * MIN)
  })

  it('后台时间不计，blur 前的一段封存', () => {
    const t = new ActiveTimer(0)
    t.activity(MIN)
    // 又过了 1 分钟切到后台：这 1 分钟是真实做题，封存
    t.setForeground(false, 2 * MIN)
    // 后台挂了 30 分钟
    assert.equal(t.elapsedMs(32 * MIN), 2 * MIN)
    t.setForeground(true, 32 * MIN)
    t.activity(33 * MIN)
    assert.equal(t.elapsedMs(33 * MIN), 3 * MIN)
  })

  it('后台里重复 setForeground(false) 不重复累计', () => {
    const t = new ActiveTimer(0)
    t.setForeground(false, MIN)
    t.setForeground(false, 2 * MIN)
    assert.equal(t.elapsedMs(2 * MIN), MIN)
  })

  it('进行中的间隔实时计入显示，达到阈值后回落冻结', () => {
    const t = new ActiveTimer(0)
    t.activity(MIN)
    // 间隔进行到 2 分钟：实时读数 = 3 分钟
    assert.equal(t.elapsedMs(3 * MIN), 3 * MIN)
    // 间隔到达阈值：整段回落，读数冻结在锚点前的累计
    assert.equal(t.elapsedMs(MIN + QUIZ_IDLE_TIMEOUT_MS), MIN)
    assert.equal(t.elapsedMs(MIN + QUIZ_IDLE_TIMEOUT_MS + 10 * MIN), MIN)
  })

  it('时钟回拨（负间隔）整段丢弃，不产生负累计', () => {
    const t = new ActiveTimer(10 * MIN)
    t.activity(4 * MIN)
    assert.equal(t.elapsedMs(4 * MIN), 0)
    t.activity(5 * MIN)
    assert.equal(t.elapsedMs(5 * MIN), MIN)
  })

  it('后台里冒出的操作视为回到前台，从该操作起锚', () => {
    const t = new ActiveTimer(0)
    t.setForeground(false, MIN)
    t.activity(10 * MIN)
    t.activity(11 * MIN)
    assert.equal(t.elapsedMs(11 * MIN), 2 * MIN)
  })

  it('自定义阈值生效', () => {
    const t = new ActiveTimer(0, 2 * MIN)
    t.activity(MIN)
    t.activity(3 * MIN + 1)
    assert.equal(t.elapsedMs(3 * MIN + 1), MIN)
  })

  it('草稿续做：initialActiveMs 带入上次累计，新活跃在其上继续累加', () => {
    const t = new ActiveTimer(0, QUIZ_IDLE_TIMEOUT_MS, 7 * MIN)
    assert.equal(t.elapsedMs(0), 7 * MIN)
    t.activity(MIN)
    assert.equal(t.elapsedMs(MIN), 8 * MIN)
  })

  // 第二道闸（setAvailable，语义「有可做的篇」）：两道闸都开着才计时
  it('前台但没有可做的篇（available 闭）：不累计', () => {
    const t = new ActiveTimer(0)
    t.setAvailable(false, 0)
    t.activity(2 * MIN)
    assert.equal(t.elapsedMs(2 * MIN), 0)
  })

  it('两闸都开：正常累计', () => {
    const t = new ActiveTimer(0)
    t.setAvailable(false, 0)
    t.activity(2 * MIN)
    assert.equal(t.elapsedMs(2 * MIN), 0)
    t.setAvailable(true, 2 * MIN)
    t.activity(3 * MIN)
    assert.equal(t.elapsedMs(3 * MIN), MIN)
  })

  it('关一闸再开：关闭期间那段不计', () => {
    const t = new ActiveTimer(0)
    t.setAvailable(true, 0)
    t.activity(MIN)
    assert.equal(t.elapsedMs(MIN), MIN)
    t.setAvailable(false, MIN)
    // 关闸期间挂起 10 分钟，读数冻结
    assert.equal(t.elapsedMs(11 * MIN), MIN)
    t.setAvailable(true, 11 * MIN)
    t.activity(12 * MIN)
    // 只有关闸前的 1 分钟 + 重新开闸后的 1 分钟，中间那段不计
    assert.equal(t.elapsedMs(12 * MIN), 2 * MIN)
  })

  it('两道闸都关时，只开一道不会重新起锚，等另一道也开才起', () => {
    const t = new ActiveTimer(0)
    t.setForeground(false, MIN)
    t.setAvailable(false, MIN)
    t.setAvailable(true, 5 * MIN)
    assert.equal(t.elapsedMs(6 * MIN), MIN)
    t.setForeground(true, 6 * MIN)
    t.activity(7 * MIN)
    assert.equal(t.elapsedMs(7 * MIN), 2 * MIN)
  })

  it('available 闭着时操作起不了作用，不会隐式重新起锚', () => {
    const t = new ActiveTimer(0)
    t.setAvailable(false, MIN)
    t.activity(5 * MIN)
    t.activity(6 * MIN)
    assert.equal(t.elapsedMs(6 * MIN), MIN)
  })
})
