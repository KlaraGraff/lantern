/**
 * 全应用完成横幅的纯判定逻辑（docs/impls/quiz-generation-background.md §B，
 * 样张状态 B）。QuizReadyBanner.tsx 是组件文件（react-refresh 要求组件文件只
 * 导出组件），这里单独收纯函数方便 node 测试直接 import。
 */

/**
 * 首篇就绪判定：只有 paperId 从无到有才算一次新的「可以做题了」——重复渲染、
 * 或同一份卷子其余状态变化（revision 增长、running 翻转）都不该重放提醒。
 * 反复生成（用户再点一次「生成」）走的是同一条判据：新会话的 paperId 先
 * 落回 null 再重新出现，天然算作又一次「从无到有」。
 */
export function isFreshlyReady(prevPaperId: number | null, nextPaperId: number | null): boolean {
  return prevPaperId == null && nextPaperId != null
}

/** 抑制规则：人已经在这张卷的做题页上，不用再提醒。 */
export function isSuppressedByRoute(pathname: string, paperId: number): boolean {
  return pathname === `/quiz/paper/${paperId}`
}
