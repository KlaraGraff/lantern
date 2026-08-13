/**
 * 做题屏（status === 'ready'）。样张：docs/impls/cijuan-merge-mockup.html §D。
 * 版式对照 labs/cijuan/src/ui/QuizView.tsx 的未交卷分支：文章与题目同处一张卷面，
 * 题间细分隔线，题号按 Georgia 衬线 + 着重色，选项单选圆点限宽单栏。
 *
 * 作答态不给任何正误线索——选项不变色、不判分、不显示答案。判分只在交卷后发生。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeft } from 'lucide-react'
import ConfirmDialog from '../../components/settings/ConfirmDialog.tsx'
import { gradeQuiz } from '../../quiz/grading.ts'
import { judgeGrammar } from '../../quiz/judge.ts'
import { parseQuizAiProfileId } from '../../quiz/transport.ts'
import { useSettings } from '../../hooks/useSettings.ts'
import type { AnswerSheet, Quiz, QuizResult } from '../../quiz/types.ts'
import { countAnswered, formatElapsed } from './useQuizPaper.ts'

type Tab = { key: string; label: string; count: number; countLabel: string }

export default function TakeView(props: {
  quiz: Quiz
  onSubmit: (result: QuizResult, elapsedMs: number) => Promise<void>
  onExit: () => void
}) {
  const { quiz, onSubmit, onExit } = props
  const { t, i18n } = useTranslation()
  const { settings } = useSettings()

  const tabs = useMemo<Tab[]>(() => {
    const list: Tab[] = quiz.passages.map((p, i) => {
      const count = quiz.readingQuestions.filter((q) => q.passageId === p.id).length
      return {
        key: `p:${p.id}`,
        label: t('quiz.paper.take.passageLabel', { n: i + 1 }),
        count,
        countLabel: t('quiz.paper.take.questionCount', { count }),
      }
    })
    if (quiz.grammarQuestions.length > 0) {
      const count = quiz.grammarQuestions.length
      list.push({
        key: 'grammar',
        label: t('quiz.paper.take.grammarTabLabel'),
        count,
        countLabel: t('quiz.paper.take.blankCount', { count }),
      })
    }
    return list
  }, [quiz, t])

  const [activeTab, setActiveTab] = useState(tabs[0]?.key ?? '')
  const [answers, setAnswers] = useState<AnswerSheet>({})
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  // 做题用时：只存内存，评卷页在交卷当次会话里展示，不落库（方案 §四.4）
  const startRef = useRef(Date.now())
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  const allQuestionIds = useMemo(
    () => [...quiz.readingQuestions.map((q) => q.id), ...quiz.grammarQuestions.map((q) => q.id)],
    [quiz],
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
      const elapsedMs = Date.now() - startRef.current
      await onSubmit(result, elapsedMs)
    } catch (error) {
      console.error('quiz submit failed:', error)
      setSubmitError(t('quiz.paper.take.submitError'))
      setSubmitting(false)
    }
  }

  const activePassage = quiz.passages.find((p) => `p:${p.id}` === activeTab)
  const difficultyLabel = t(`quiz.paper.difficulty.${quiz.config.difficulty}`)
  const wordsCount = quiz.words.length
  const dateLabel = new Date(quiz.createdAt).toLocaleDateString(i18n.language.startsWith('zh') ? 'zh-CN' : 'en-US', {
    month: 'numeric',
    day: 'numeric',
  })

  return (
    <div className="flex h-screen flex-col bg-bg-page">
      <div className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-bg-surface px-4">
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
        <span className="text-[12.5px] text-text-muted">
          {t('quiz.paper.take.elapsed', { time: formatElapsed(now - startRef.current) })}
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
                {tabItem.label} <span className="ml-1 text-text-muted">{tabItem.countLabel}</span>
              </button>
            ))}
          </div>

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

          {activeTab === 'grammar' && quiz.grammarQuestions.length > 0 && (
            <div className="rounded-b-lg rounded-tr-lg border border-border bg-bg-surface p-6">
              <h2 className="font-serif text-[19px] font-semibold text-text-primary">
                {t('quiz.paper.take.grammarTabLabel')}
              </h2>
              <p className="mt-1 text-[12px] text-text-muted">{t('quiz.paper.take.grammarMeta', { count: quiz.grammarQuestions.length })}</p>
              <div className="mt-4 space-y-4">
                {quiz.grammarQuestions.map((q, i) => {
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

      <div className="flex h-16 shrink-0 items-center gap-3 border-t border-border bg-bg-surface px-4">
        <button
          type="button"
          disabled={submitting}
          onClick={handleSubmitClick}
          className="flex h-9 items-center rounded-lg bg-accent px-4 text-[13.5px] font-medium text-white transition-colors disabled:opacity-50"
        >
          {submitting ? t('quiz.paper.take.submitting') : t('quiz.paper.take.submit')}
        </button>
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
