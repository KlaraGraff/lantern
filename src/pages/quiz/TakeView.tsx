/**
 * 做题屏（status === 'ready' | 'generating'）。样张：docs/impls/cijuan-merge-mockup.html §D。
 * 版式对照 labs/cijuan/src/ui/QuizView.tsx 的未交卷分支：文章与题目同处一张卷面，
 * 题间细分隔线，题号按 Georgia 衬线 + 着重色，选项单选圆点限宽单栏。
 *
 * 作答态不给任何正误线索——选项不变色、不判分、不显示答案。判分只在交卷后发生。
 *
 * 渐进发卷（docs/impls/quiz-progressive-delivery.md §五）：status === 'generating'
 * 时篇位标签来自生成计划（generation.groups，篇号 = 组下标），三种槽位状态——
 * open（该篇 done，可做，与前面的篇是否就绪无关——谁就绪谁开放，不按篇序锁）/
 * pending（会话在跑，该篇还在生成，含写稿/复核/题目重出/整篇自动重试四个阶段）/
 * failed（自动重试耗尽或上次中断，可单篇重生成）。计数（页脚已答/总数、语法页）
 * 只算 open 篇的题；交卷前后端双重门（这里禁用按钮 + 提示，后端 submit_quiz_paper
 * 对 generating 卷拒绝）。全部就绪翻 ready 后静默换快照，槽位 key 按组下标不变，
 * 用户停在哪个标签就还在哪个标签。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, Loader2, RotateCw } from 'lucide-react'
import ConfirmDialog from '../../components/settings/ConfirmDialog.tsx'
import { gradeQuiz } from '../../quiz/grading.ts'
import { judgeGrammar } from '../../quiz/judge.ts'
import { parseQuizAiProfileId } from '../../quiz/transport.ts'
import { useSettings } from '../../hooks/useSettings.ts'
import { TOP_INSET } from '../../utils/top-inset.ts'
import type { AnswerSheet, Passage, Quiz, QuizDraft, QuizResult } from '../../quiz/types.ts'
import { QUIZ_ARTICLE_MAX_ATTEMPTS } from '../../quiz/generate.ts'
import { aiErrorMessageKey, type AiErrorCode } from '../../utils/aiError.ts'
import type { GenerationSessionState } from './generation-session.ts'
import { countAnswered, formatElapsed } from './useQuizPaper.ts'
import { ActiveTimer, QUIZ_IDLE_TIMEOUT_MS } from './active-timer.ts'
import { deriveSlots, type PendingStep, type SlotState } from './take-slots.ts'

type Tab = {
  key: string
  label: string
  /** 标签右侧小字：open 是题数，其余是状态词 */
  sub: string
  state: SlotState
  passage?: Passage
  /** 生成计划里的篇号，failed 槽位的重生成按钮用 */
  groupIndex?: number
  /** pending 槽位的活阶段（写稿/复核/题目重出/整篇重试），页签小字与占位面板用 */
  step?: PendingStep
  /** 仅 step === 'retrying' 时有值：当前是第几次尝试 */
  attempt?: number
  /** 仅 state === 'failed' 时有值：失败原因（错误码优先，其次失败原文） */
  errorCode?: AiErrorCode
  errorMessage?: string
}

export default function TakeView(props: {
  quiz: Quiz
  onSubmit: (result: QuizResult, elapsedMs: number) => Promise<void>
  onExit: () => void
  /** 草稿自动保存的写库口（useQuizPaper.saveDraft）。不传则不保存（测试环境） */
  onSaveDraft?: (draft: QuizDraft) => void
  generationSession?: GenerationSessionState
  onRegenerateArticles?: (groupIndexes: number[]) => void
}) {
  const { quiz, onSubmit, onExit, onSaveDraft, generationSession, onRegenerateArticles } = props
  const { t, i18n } = useTranslation()
  const { settings } = useSettings()

  const slots = useMemo(() => deriveSlots(quiz, generationSession), [quiz, generationSession])

  // 计数与作答只认 open 篇：pending/failed 篇的题不进总数，
  // 全部就绪翻 ready 后 slots 全 open，总数自然长上去
  const openPassageIds = useMemo(
    () => new Set(slots.filter((s) => s.state === 'open').map((s) => s.passage!.id)),
    [slots],
  )
  const openGrammarQuestions = useMemo(
    () => quiz.grammarQuestions.filter((q) => openPassageIds.has(q.passageId)),
    [quiz, openPassageIds],
  )
  // 有没有可做的篇——驱动计时器的可用闸（active-timer.ts）；一篇都没就绪时
  // 头部「用时」整个不渲染，不显示冻结的 00:00
  const hasOpen = useMemo(() => slots.some((s) => s.state === 'open'), [slots])

  const tabs = useMemo<Tab[]>(() => {
    const list: Tab[] = slots.map((slot, i) => {
      const base = {
        // key 按篇号而不是 passageId：pending → open 的翻转不换 key，标签停留原位
        key: `a:${i}`,
        label: t('quiz.paper.take.passageLabel', { n: i + 1 }),
        state: slot.state,
        passage: slot.passage,
        groupIndex: i,
        step: slot.step,
        attempt: slot.attempt,
        errorCode: slot.errorCode,
        errorMessage: slot.errorMessage,
      }
      if (slot.state === 'open') {
        const count = quiz.readingQuestions.filter((q) => q.passageId === slot.passage!.id).length
        return { ...base, sub: t('quiz.paper.take.questionCount', { count }) }
      }
      if (slot.state === 'pending') {
        // 生成中的篇报出流水线的活阶段（写稿中/复核中/题目重出中/整篇重试中），
        // 不再是笼统的「生成中」；重试态带出当前次数/上限
        return {
          ...base,
          sub: t(`quiz.paper.take.slot.step.${slot.step ?? 'writing'}`, {
            attempt: slot.attempt,
            total: QUIZ_ARTICLE_MAX_ATTEMPTS,
          }),
        }
      }
      return { ...base, sub: t(`quiz.paper.take.slot.${slot.state}`) }
    })
    if (openGrammarQuestions.length > 0) {
      list.push({
        key: 'grammar',
        label: t('quiz.paper.take.grammarTabLabel'),
        sub: t('quiz.paper.take.blankCount', { count: openGrammarQuestions.length }),
        state: 'open',
      })
    }
    return list
  }, [slots, quiz, openGrammarQuestions, t])

  const [activeTab, setActiveTab] = useState(tabs[0]?.key ?? '')
  // 草稿续做：上次填的答案在挂载时一次性带入（草稿只在这里读；之后 quiz 快照
  // 静默刷新携带的旧 draft 字段没人再看）
  const [answers, setAnswers] = useState<AnswerSheet>(() => quiz.draft?.answers ?? {})
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  // 做题用时：只算前台活跃时长——后台不计，超过阈值的发呆整段不计
  // （active-timer.ts）。草稿续做时从上次累计的用时接着计。
  const timerRef = useRef<ActiveTimer | null>(null)
  if (timerRef.current == null) {
    timerRef.current = new ActiveTimer(Date.now(), QUIZ_IDLE_TIMEOUT_MS, quiz.draft?.elapsedMs ?? 0)
    if (document.visibilityState === 'hidden') timerRef.current.setForeground(false, Date.now())
  }
  const timer = timerRef.current
  // 兜底闸：没有可做的篇时不计时（正常情况下改动一落地后至少有一篇 open，
  // 这里只是不让「全篇都没就绪」的边缘状态偷偷计时）
  useEffect(() => {
    timer.setAvailable(hasOpen, Date.now())
  }, [timer, hasOpen])
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])
  // 草稿冲刷走 ref：flushDraft 保持稳定引用，事件监听 effect 不用反复重挂
  const onSaveDraftRef = useRef(onSaveDraft)
  onSaveDraftRef.current = onSaveDraft
  const answersRef = useRef(answers)
  answersRef.current = answers
  const flushDraft = useCallback(() => {
    onSaveDraftRef.current?.({ answers: answersRef.current, elapsedMs: timer.elapsedMs(Date.now()) })
  }, [timer])

  useEffect(() => {
    const onActivity = () => timer.activity(Date.now())
    // 切后台时顺手把草稿冲刷落库：这是「离开」最常见的时点，答案和已计用时
    // 都以此为准；交卷之后的冲刷由后端对 submitted 卷静默忽略，无需拦截。
    const onBlur = () => {
      timer.setForeground(false, Date.now())
      flushDraft()
    }
    const onFocus = () => timer.setForeground(true, Date.now())
    const onVisibility = () => {
      const foreground = document.visibilityState !== 'hidden'
      timer.setForeground(foreground, Date.now())
      if (!foreground) flushDraft()
    }
    // 与阅读统计同一组活动事件（useReadingSessionTracker）；capture 是为了
    // 接住内层滚动容器不冒泡的 scroll
    const events = ['pointerdown', 'keydown', 'wheel', 'scroll', 'touchstart'] as const
    for (const ev of events) window.addEventListener(ev, onActivity, { passive: true, capture: true })
    window.addEventListener('blur', onBlur)
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      for (const ev of events) window.removeEventListener(ev, onActivity, { capture: true })
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [timer, flushDraft])

  // 作答后防抖落库；卸载（退出页面/交卷切评卷）时冲刷最后一拍
  const draftEverDirtyRef = useRef(false)
  useEffect(() => {
    if (!draftEverDirtyRef.current) {
      // 首次渲染只是把草稿读回来，没有新内容可存
      draftEverDirtyRef.current = true
      return
    }
    const id = setTimeout(flushDraft, 800)
    return () => clearTimeout(id)
  }, [answers, flushDraft])
  useEffect(() => () => flushDraft(), [flushDraft])

  const allQuestionIds = useMemo(
    () => [
      ...quiz.readingQuestions.filter((q) => openPassageIds.has(q.passageId)).map((q) => q.id),
      ...openGrammarQuestions.map((q) => q.id),
    ],
    [quiz, openPassageIds, openGrammarQuestions],
  )
  const totalQuestions = allQuestionIds.length
  const answeredCount = countAnswered(allQuestionIds, answers)

  function setAnswer(id: string, value: string) {
    setAnswers((cur) => ({ ...cur, [id]: value }))
  }

  function handleSubmitClick() {
    if (submitting) return
    if (answeredCount < totalQuestions) {
      setConfirmOpen(true)
      return
    }
    void doSubmit()
  }

  async function doSubmit() {
    setConfirmOpen(false)
    setSubmitting(true)
    setSubmitError(null)
    try {
      const grammarVerdicts = await judgeGrammar({
        questions: quiz.grammarQuestions,
        answers,
        demo: quiz.config.demo,
        profileId: parseQuizAiProfileId(settings['quiz_ai_profile_id']),
      })
      const result = gradeQuiz(quiz, answers, grammarVerdicts)
      const elapsedMs = timer.elapsedMs(Date.now())
      await onSubmit(result, elapsedMs)
    } catch (error) {
      console.error('quiz submit failed:', error)
      setSubmitError(t('quiz.paper.take.submitError'))
      setSubmitting(false)
    }
  }

  const activeSlot = tabs.find((tabItem) => tabItem.key === activeTab)
  const activePassage = activeSlot?.state === 'open' ? activeSlot.passage : undefined
  const difficultyLabel = t(`quiz.paper.difficulty.${quiz.config.difficulty}`)
  const wordsCount = quiz.words.length
  const dateLabel = new Date(quiz.createdAt).toLocaleDateString(i18n.language.startsWith('zh') ? 'zh-CN' : 'en-US', {
    month: 'numeric',
    day: 'numeric',
  })

  return (
    <div className="flex h-screen flex-col bg-bg-page">
      <div className={`flex min-h-14 shrink-0 items-center gap-3 border-b border-border bg-bg-surface px-4 ${TOP_INSET}`}>
        <button
          type="button"
          onClick={onExit}
          className="flex h-8 items-center gap-1 rounded-md px-2 text-[13px] font-medium text-text-secondary hover:bg-bg-input"
        >
          <ArrowLeft size={15} />
          {t('quiz.paper.exit')}
        </button>
        <span className="text-[14px] font-semibold text-text-primary">{t('quiz.paper.take.title')}</span>
        {/* 窄屏让位：生成中头部还有「x/y 篇就绪」和用时，这行次要元数据先隐藏 */}
        <span className="hidden text-[12.5px] text-text-muted md:inline">
          {t('quiz.paper.take.meta', { date: dateLabel, difficulty: difficultyLabel, count: wordsCount })}
        </span>
        <span className="flex-1" />
        {quiz.status === 'generating' && quiz.generation && (
          <span className="text-[12.5px] text-text-muted">
            {t('quiz.paper.take.readyCount', {
              ready: slots.filter((s) => s.state === 'open').length,
              total: quiz.generation.groups.length,
            })}
          </span>
        )}
        {hasOpen && (
          <span className="text-[12.5px] text-text-muted">
            {t('quiz.paper.take.elapsed', { time: formatElapsed(timer.elapsedMs(now)) })}
          </span>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[720px] px-4 py-6">
          <div className="flex gap-1 border-b border-border-light">
            {tabs.map((tabItem) => (
              <button
                key={tabItem.key}
                type="button"
                onClick={() => setActiveTab(tabItem.key)}
                className={`rounded-t-md px-3 py-2 text-[13px] font-medium transition-colors ${
                  activeTab === tabItem.key
                    ? 'border border-b-0 border-border bg-bg-surface text-accent-text'
                    : 'text-text-muted hover:text-text-secondary'
                }`}
              >
                {tabItem.label}{' '}
                <span
                  className={`ml-1 ${tabItem.state === 'failed' ? 'text-danger-text' : 'text-text-muted'}`}
                >
                  {tabItem.state === 'pending' && (
                    <Loader2 size={11} className="mr-0.5 inline animate-spin align-[-1px]" />
                  )}
                  {tabItem.sub}
                </span>
              </button>
            ))}
          </div>

          {activeSlot && activeSlot.state !== 'open' && (
            <div className="rounded-b-lg rounded-tr-lg border border-border bg-bg-surface px-6 py-14 text-center">
              {activeSlot.state === 'pending' && (
                <Loader2 size={20} className="mx-auto mb-3 animate-spin text-text-muted" />
              )}
              <p className="mx-auto max-w-[42ch] text-[13.5px] leading-[1.8] text-text-secondary">
                {activeSlot.state === 'pending'
                  ? t(`quiz.paper.take.slot.stepBody.${activeSlot.step ?? 'writing'}`, {
                      attempt: activeSlot.attempt,
                      total: QUIZ_ARTICLE_MAX_ATTEMPTS,
                    })
                  : t(`quiz.paper.take.slot.${activeSlot.state}Body`)}
              </p>
              {activeSlot.state === 'pending' && (
                <p className="mx-auto mt-1.5 max-w-[42ch] text-[12.5px] leading-[1.8] text-text-muted">
                  {t('quiz.paper.take.slot.pendingBody')}
                </p>
              )}
              {/* 失败原因：认得出的错误码给现成文案（多半要改设置），认不出的
                * 直接把失败原文摆出来——没有它，用户只能对着「未生成完成」反复
                * 点重试，谁也不知道是模型没吐出内容还是请求被拒 */}
              {activeSlot.state === 'failed' && (activeSlot.errorCode || activeSlot.errorMessage) && (
                <p className="mx-auto mt-2 max-w-[42ch] text-[12.5px] leading-[1.7] text-text-muted">
                  {t('quiz.paper.take.slot.failedReason', {
                    reason: activeSlot.errorCode
                      ? t(aiErrorMessageKey(activeSlot.errorCode))
                      : activeSlot.errorMessage,
                  })}
                </p>
              )}
              {activeSlot.state === 'failed' && onRegenerateArticles && (
                <button
                  type="button"
                  onClick={() => onRegenerateArticles([activeSlot.groupIndex!])}
                  className="mt-5 inline-flex h-9 items-center gap-1.5 rounded-lg border border-border px-4 text-[13px] font-medium text-text-secondary hover:bg-bg-input"
                >
                  <RotateCw size={14} />
                  {t('quiz.paper.take.slot.regenerate')}
                </button>
              )}
            </div>
          )}

          {activePassage && (
            <div className="rounded-b-lg rounded-tr-lg border border-border bg-bg-surface p-6">
              <h2 className="font-serif text-[19px] font-semibold text-text-primary">{activePassage.title}</h2>
              <p className="mt-1 text-[12px] text-text-muted">
                {t('quiz.paper.take.passageMeta', {
                  difficulty: difficultyLabel,
                  words: activePassage.paragraphs.join(' ').split(/\s+/).filter(Boolean).length,
                })}
              </p>
              {/* 真题卷面惯例：正文两端对齐；连字符断词交给浏览器（容器是英文，
                * 标 lang 才能用对连字典），否则窄行会拉出大空隙。 */}
              <div lang="en" className="mt-4 max-w-[62ch] text-justify font-serif text-[15px] leading-[1.85] text-text-body hyphens-auto">
                {activePassage.paragraphs.map((para, i) => (
                  <p key={i} className="mb-3">
                    <span className="mr-1.5 select-none text-[11px] text-text-muted">¶{i + 1}</span>
                    {para}
                  </p>
                ))}
              </div>

              <div className="mt-6 space-y-5 border-t border-border-light pt-5">
                {quiz.readingQuestions
                  .filter((q) => q.passageId === activePassage.id)
                  .map((q, i) => (
                    <div key={q.id} className={i > 0 ? 'border-t border-border-light pt-5' : ''}>
                      <div className="font-serif text-[14.5px] leading-[1.6] text-text-primary">
                        <span className="mr-1 font-semibold text-accent-text">{t('quiz.paper.take.qPrefix', { n: i + 1 })}</span>
                        {q.stem}
                      </div>
                      <div className="mt-3 max-w-[560px] space-y-1.5">
                        {q.options.map((opt) => {
                          const picked = answers[q.id] === opt.label
                          return (
                            <button
                              key={opt.label}
                              type="button"
                              onClick={() => setAnswer(q.id, opt.label)}
                              className={`flex w-full items-start gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors ${
                                picked ? 'border-accent bg-accent-bg' : 'border-border hover:bg-bg-input'
                              }`}
                            >
                              <span
                                className={`mt-1 size-3.5 shrink-0 rounded-full border-2 ${
                                  picked ? 'border-accent bg-accent' : 'border-border'
                                }`}
                              />
                              <span className="font-serif text-[14px] leading-[1.6] text-text-primary">
                                {opt.label}. {opt.text}
                              </span>
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  ))}
              </div>
            </div>
          )}

          {activeTab === 'grammar' && openGrammarQuestions.length > 0 && (
            <div className="rounded-b-lg rounded-tr-lg border border-border bg-bg-surface p-6">
              <h2 className="font-serif text-[19px] font-semibold text-text-primary">
                {t('quiz.paper.take.grammarTabLabel')}
              </h2>
              <p className="mt-1 text-[12px] text-text-muted">{t('quiz.paper.take.grammarMeta', { count: openGrammarQuestions.length })}</p>
              <div className="mt-4 space-y-4">
                {openGrammarQuestions.map((q, i) => {
                  const parts = q.sentence.split('____')
                  return (
                    <div key={q.id} className={i > 0 ? 'border-t border-border-light pt-4' : ''}>
                      <div className="font-serif text-[14.5px] leading-[1.8] text-text-primary">
                        <span className="mr-1 font-semibold text-accent-text">{t('quiz.paper.take.gPrefix', { n: i + 1 })}</span>
                        {parts.map((part, pi) => (
                          <span key={pi}>
                            {part}
                            {pi < parts.length - 1 && (
                              <input
                                value={answers[q.id] ?? ''}
                                onChange={(e) => setAnswer(q.id, e.target.value)}
                                placeholder={t('quiz.paper.take.blankPlaceholder')}
                                /* Autocorrect grading an answer before the
                                 * grader sees it is the worst kind of wrong
                                 * mark: the reader typed the right word and
                                 * the keyboard replaced it. */
                                autoCapitalize="off"
                                autoCorrect="off"
                                spellCheck={false}
                                className="mx-1 w-32 rounded-md border border-border bg-bg-input px-2 py-0.5 font-serif text-[14px] text-text-primary focus:border-accent focus:outline-none"
                              />
                            )}
                          </span>
                        ))}{' '}
                        <span className="text-[13px] text-text-muted">({q.hint})</span>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="flex min-h-16 shrink-0 items-center gap-3 border-t border-border bg-bg-surface px-4 pb-[max(0.5rem,var(--spacing-safe-bottom))]">
        <button
          type="button"
          disabled={submitting || quiz.status !== 'ready'}
          onClick={handleSubmitClick}
          className="flex h-9 items-center rounded-lg bg-accent px-4 text-[13.5px] font-medium text-white transition-colors disabled:opacity-50"
        >
          {submitting ? t('quiz.paper.take.submitting') : t('quiz.paper.take.submit')}
        </button>
        {quiz.status !== 'ready' && (
          <span className="text-[12.5px] text-text-muted">{t('quiz.paper.take.submitGate')}</span>
        )}
        {submitError && <span className="text-[12.5px] text-danger-text">{submitError}</span>}
        <span className="flex-1" />
        <span className="text-[13px] text-text-secondary">
          {t('quiz.paper.take.answeredCount', { answered: answeredCount, total: totalQuestions })}
        </span>
      </div>

      {confirmOpen && (
        <ConfirmDialog
          title={t('quiz.paper.take.confirmTitle')}
          description={t('quiz.paper.take.confirmBody', {
            answered: answeredCount,
            total: totalQuestions,
            unanswered: totalQuestions - answeredCount,
          })}
          primaryLabel={t('quiz.paper.take.confirmSubmit')}
          onPrimary={() => void doSubmit()}
          secondaryLabel={t('quiz.paper.take.confirmBack')}
          onSecondary={() => setConfirmOpen(false)}
        />
      )}
    </div>
  )
}
