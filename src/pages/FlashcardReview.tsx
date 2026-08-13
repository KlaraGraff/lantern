/**
 * 翻卡独立页：从 DictionaryContent 的弹窗复习会话拆出（拍板：弹窗退役，
 * 词表行「复习」与堆卡入口都改为跳转本页）。
 * 样张：docs/impls/cijuan-merge-mockup.html §A3。
 *
 * 骨架占位——实现代理在此文件内落地，路由已在 App.tsx 接好（/flashcards）。
 */
export default function FlashcardReview() {
  return <div className="h-screen bg-bg-page" />
}
