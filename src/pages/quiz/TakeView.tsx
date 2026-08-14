/**
 * 做题屏（status === 'ready' | 'generating'）。样张：docs/impls/cijuan-merge-mockup.html §D。
 * 版式对照 labs/cijuan/src/ui/QuizView.tsx 的未交卷分支：文章与题目同处一张卷面，
 * 题间细分隔线，题号按 Georgia 衬线 + 着重色，选项单选圆点限宽单栏。
 *
 * 作答态不给任何正误线索——选项不变色、不判分、不显示答案。判分只在交卷后发生。
 *
 * 渐进发卷（docs/impls/quiz-progressive-delivery.md §五）：status === 'generating'
 * 时篇位标签来自生成计划（generation.groups，篇号 = 组下标），四种槽位状态——
 * open（就绪且前篇全就绪，可做）/ locked（就绪但有前篇未就绪，按篇序解锁）/
 * pending（会话在跑，该篇还在生成）/ failed（没生成成或上次中断，可单篇重生成）。
 * 计数（页脚已答/总数、语法页）只算 open 篇的题；交卷前后端双重门（这里禁用
 * 按钮 + 提示，后端 submit_quiz_paper 对 generating 卷拒绝）。全部就绪翻 ready
 * 后静默换快照，槽位 key 按组下标不变，用户停在哪个标签就还在哪个标签。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, Loader2, RotateCw } from 'lucide-react'
import ConfirmDialog from '../../components/settings/ConfirmDialog.tsx'
import { gradeQuiz } from '../../quiz/grading.ts'
import { judgeGrammar } from '../../quiz/judge.ts'
import { parseQuizAiProfileId } from '../../quiz/transport.ts'
import { useSettings } from '../../hooks/useSettings.ts'
import { TOP_INSET } from '../../utils/top-inset.ts'
import type { AnswerSheet, Passage, Quiz, QuizResult } from '../../quiz/types.ts'
import type { GenerationSessionState } from './generation-session.ts'
import { countAnswered, formatElapsed } from './useQuizPaper.ts'
import { ActiveTimer } from './active-timer.ts'
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
  /** pending 槽位的活阶段（写稿/复核/重出），页签小字与占位面板用 */
  step?: PendingStep
}

export default function TakeView(props: {
  quiz: Quiz
  onSubmit: (result: QuizResult, elapsedMs: number) => Promise<void>
  onExit: () => void
  generationSession?: GenerationSessionState
  onRegenerateArticles?: (groupIndexes: number[]) => void
}) {
  const { quiz, onSubmit, onExit, generationSession, onRegenerateArticles } = props
  const { t, i18n } = useTranslation()
  const { settings } = useSettings()

  const slots = useMemo(() => deriveSlots(quiz, generationSession), [quiz, generationSession])

  // 计数与作答只认 open 篇：locked/pending/failed 篇的题不进总数，
  // 全部就绪翻 ready 后 slots 全 open，总数自然长上去
  const openPassageIds = useMemo(
    () => new Set(slots.filter((s) => s.state === 'open').map((s) => s.passage!.id)),
    [slots],
  )
  const openGrammarQuestions = useMemo(
    () => quiz.grammarQuestions.filter((q) => openPassageIds.has(q.passageId)),
    [quiz, openPassageIds],
  )

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
      }
      if (slot.state === 'open') {
        const count = quiz.readingQuestions.filter((q) => q.passageId === slot.passage!.id).length
        return { ...base, sub: t('quiz.paper.take.questionCount', { count }) }
      }
      if (slot.state === 'pending') {
        // 生成中的篇报出流水线的活阶段（写稿中/复核中/重出中），不再是笼统的「生成中」
        return { ...base, sub: t(`quiz.paper.take.slot.step.${slot.step ?? 'writing'}`) }
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
  const [answers, setAnswers] = useState<AnswerSheet>({})
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  // 做题用时：只存内存，评卷页在交卷当次会话里展示，不落库（方案 §四.4）。
  // 只算前台活跃时长——后台不计，超过阈值的发呆整段不计（active-timer.ts）。
  const timerRef = useRef<ActiveTimer | null>(null)
  if (timerRef.current == null) {
    timerRef.current = new ActiveTimer(Date.now())
    if (document.visibilityState === 'hidden') timerRef.current.setForeground(false, Date.now())
  }
  const timer = timerRef.current
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])
  useEffect(() => {
    const onActivity = () => timer.activity(Date.now())
    const onBlur = () => timer.setForeground(false, Date.now())
    const onFocus = () => timer.setForeground(true, Date.now())
    const onVisibility = () => timer.setForeground(document.visibilityState !== 'hidden', Date.now())
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
  }, [timer])

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
        <span className="text-[12.5px] text-text-muted">
          {t('quiz.paper.take.meta', { date: dateLabel, difficulty: difficultyLabel, count: wordsCount })}
        </span>
        <span className="flex-1" />
        {quiz.status === 'generating' && quiz.generation && (
          <span className="text-[12.5px] text-text-muted">
            {t('quiz.paper.take.readyCount', {
              ready: slots.filter((s) => s.state === 'open' || s.state === 'locked').length,
              total: quiz.generation.groups.length,
            })}
          </span>
        )}
        <span className="text-[12.5px] text-text-muted">
          {t('quiz.paper.take.elapsed', { time: formatElapsed(timer.elapsedMs(now)) })}
        </span>
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
                  ? t(`quiz.paper.take.slot.stepBody.${activeSlot.step ?? 'writing'}`)
                  : t(`quiz.paper.take.slot.${activeSlot.state}Body`)}
              </p>
              {activeSlot.state === 'pending' && (
                <p className="mx-auto mt-1.5 max-w-[42ch] text-[12.5px] leading-[1.8] text-text-muted">
                  {t('quiz.paper.take.slot.pendingBody')}
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
              <div className="mt-4 max-w-[62ch] font-serif text-[15px] leading-[1.85] text-text-body">
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
