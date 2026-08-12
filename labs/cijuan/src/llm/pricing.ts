/**
 * 出题成本估算，显示在「生成试卷」按钮旁。
 * 只对单价已知的模型估算；估不出的返回 null——宁可不显示，
 * 也不显示一个编出来的数（原则同 Lantern：不替服务商换算钱）。
 * 是估算不是账单：按经验 token 量 × 官方单价，实际以服务商后台为准。
 */

interface ModelPrice {
  /** 美元 / 百万 token */
  inputPerM: number
  outputPerM: number
}

/** 单价已知的模型（2026-08 核对）；本地模型记 0 */
export const KNOWN_PRICES: Record<string, ModelPrice> = {
  'claude-opus-5': { inputPerM: 5, outputPerM: 25 },
  'claude-sonnet-5': { inputPerM: 3, outputPerM: 15 },
  'claude-haiku-4-5': { inputPerM: 1, outputPerM: 5 },
  'deepseek-v4-flash': { inputPerM: 0.07, outputPerM: 0.28 },
  'gpt-4o-mini': { inputPerM: 0.15, outputPerM: 0.6 },
}

const USD_TO_CNY = 7.2

/**
 * 经验值：一次出卷 = 生成调用 + 遮词自检 + 可能的重出。
 * 输入 ≈ 提示词 2.5k + 自检时整卷回传；输出 ≈ 每词约 450 token
 * （文章+题目+结构化讲解：题干翻译、逐选项释义、语法判定链）。
 * 模型单价未知（自定义端点、本地模型等）时返回 null。
 */
export function estimateCostCNY(
  model: string,
  wordCount: number,
  maskedCheck: boolean,
): number | null {
  const price = KNOWN_PRICES[model]
  if (!price) return null
  const outputTokens = 1500 + wordCount * 450
  let inputTokens = 2500
  if (maskedCheck) {
    inputTokens += outputTokens // 自检要把整卷发回去；自检输出很短，忽略不计
  }
  const usd = (inputTokens * price.inputPerM + outputTokens * price.outputPerM) / 1_000_000
  return usd * USD_TO_CNY
}

export function formatCost(cny: number): string {
  return cny < 0.1 ? '< ¥0.1' : `≈ ¥${cny.toFixed(1)}`
}
