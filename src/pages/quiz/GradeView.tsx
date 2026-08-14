/**
 * 评卷屏（status === 'submitted'）。样张：docs/impls/cijuan-merge-mockup.html §E。
 * 判分/讲解/追问原位长在题目下面，不跳新页。错题默认展开、对题折叠。
 *
 * 解析三态渲染依据 useQuizPaper.ts 的 explanationTriState（该函数的判定规则见其
 * 头注释）：running → 骨架屏；missing → 「没写成 / 点击补生成」；ready → 正文。
 * 三态判定与展示分离——本文件只负责「拿到状态后怎么画」。
 */
import { useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, ChevronDown, Loader2, MessageCircleQuestion, RotateCw } from 'lucide-react'
import AskDrawer from './AskDrawer.tsx'
import { useAskThread } from './useAskThread.ts'
import { explanationTriState, type ExplanationTriState } from './useQuizPaper.ts'
import type { ExplanationSessionState } from './explanation-session.ts'
import { aiErrorMessageKey } from '../../utils/aiError.ts'
import { TOP_INSET } from '../../utils/top-inset.ts'
import type {
  AskThread,
  GrammarFillQuestion,
  Quiz,
  ReadingOption,
  ReadingQuestion,
} from '../../quiz/types.ts'

function readingAskCtx(q: ReadingQuestion): string {
  return `${q.stem}\n${q.options.map((o) => `${o.label}. ${o.text}`).join('\n')}`
}
function optionAskCtx(q: ReadingQuestion, opt: ReadingOption): string {
  const meaning = opt.meaning ? `（${opt.meaning}）` : ''
  const note = opt.note ? `\n${opt.note}` : ''
  return `${q.stem}\n选项 ${opt.label}. ${opt.text}${meaning}${note}`
}
function grammarAskCtx(q: GrammarFillQuestion): string {
  return q.sentence.replace('____', q.answer)
}

/** 目标词在引句里做一次不区分大小写的高亮，找不到就原样返回整段。 */
function highlightWord(text: string, word: string) {
  const idx = text.toLowerCase().indexOf(word.toLowerCase())
  if (idx === -1) return text
  return (
    <>
      {text.slice(0, idx)}
      <mark className="rounded bg-accent-bg px-0.5 text-accent-text">{text.slice(idx, idx + word.length)}</mark>
      {text.slice(idx + word.length)}
    </>
  )
}

function SkeletonBar({ width }: { width: string }) {
  return <span className="block h-3 animate-pulse rounded bg-bg-input" style={{ width }} />
}

function ExplanationSkeleton({ t }: { t: (key: string) => string }) {
  return (
    <div className="space-y-4 pt-3">
      <div className="flex items-center gap-2 rounded-md bg-accent-bg px-3 py-2 text-[12.5px] text-accent-text">
        <Loader2 size={13} className="shrink-0 animate-spin" />
        {t('quiz.paper.grade.explanationRunning')}
      </div>
      {['quiz.paper.grade.sectionStem', 'quiz.paper.grade.sectionWord', 'quiz.paper.grade.sectionSource'].map((key) => (
        <div key={key}>
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-muted">{t(key)}</div>
          <div className="space-y-1.5">
            <SkeletonBar width="85%" />
            <SkeletonBar width="55%" />
          </div>
        </div>
      ))}
    </div>
  )
}

/**
 * disabled：另一组的补生成正在跑时置真——runExplanationSession 对同卷重入直接
 * 返回 null（无任何 UI 反馈），所以别的组的入口必须先禁掉，不给静默无响应的机会。
 */
function ExplanationMissing(props: {
  onGenerate: () => void
  disabled: boolean
  /** 失败原因：会话里识别出 AI 错误码时是对应文案（如钉住的模型被删），否则是默认的「上次生成中断了」 */
  reason: string
  t: (key: string) => string
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 pt-3">
      <p className="min-w-[220px] flex-1 text-[12.5px] leading-[1.7] text-text-secondary">
        {props.t('quiz.paper.grade.explanationMissing')}
        <span className="text-text-muted"> {props.reason}</span>
      </p>
      <button
        type="button"
        onClick={props.onGenerate}
        disabled={props.disabled}
        className="flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-border px-3 text-[12.5px] font-medium text-text-secondary hover:bg-bg-input disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
      >
        <RotateCw size={13} />
        {props.t('quiz.paper.grade.generateButton')}
      </button>
    </div>
  )
}

export default function GradeView(props: {
  quiz: Quiz
  paperId: number
  elapsedMs: number | null
  explanationSession: ExplanationSessionState | undefined
  regenerateExplanations: (passageIds: string[]) => void
  saveAskThreads: (threads: AskThread[]) => Promise<void>
  onExit: () => void
  onRetake: () => void
  onGoToPool: () => void
}) {
  const { quiz, explanationSession, regenerateExplanations, saveAskThreads, onExit, onRetake, onGoToPool } = props
  const { t, i18n } = useTranslation()
  const result = quiz.result
  const dateLabel = new Date(quiz.createdAt).toLocaleDateString(i18n.language.startsWith('zh') ? 'zh-CN' : 'en-US', {
    month: 'numeric',
    day: 'numeric',
  })
  const difficultyLabel = t(`quiz.paper.difficulty.${quiz.config.difficulty}`)

  const verdictById = useMemo(
    () => new Map((result?.verdicts ?? []).map((v) => [v.questionId, v])),
    [result],
  )

  const tabs = useMemo(() => {
    const list = quiz.passages.map((p, i) => {
      const qs = quiz.readingQuestions.filter((q) => q.passageId === p.id)
      const correct = qs.filter((q) => verdictById.get(q.id)?.correct).length
      return { key: `p:${p.id}`, label: t('quiz.paper.take.passageLabel', { n: i + 1 }), total: qs.length, correct }
    })
    if (quiz.grammarQuestions.length > 0) {
      const correct = quiz.grammarQuestions.filter((q) => verdictById.get(q.id)?.correct).length
      list.push({
        key: 'grammar',
        label: t('quiz.paper.take.grammarTabLabel'),
        total: quiz.grammarQuestions.length,
        correct,
      })
    }
    return list
  }, [quiz, verdictById, t])

  const [activeTab, setActiveTab] = useState(tabs[0]?.key ?? '')
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {}
    for (const v of result?.verdicts ?? []) init[v.questionId] = !v.correct
    return init
  })
  function toggle(id: string) {
    setExpanded((cur) => ({ ...cur, [id]: !cur[id] }))
  }

  const paraRefs = useRef<Record<string, HTMLParagraphElement | null>>({})
  const [flashKey, setFlashKey] = useState<string | null>(null)
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])
  function goToSource(passageId: string, paragraph: number) {
    setActiveTab(`p:${passageId}`)
    const key = `${passageId}-${paragraph}`
    timers.current.push(
      setTimeout(() => {
        paraRefs.current[key]?.scrollIntoView({ behavior: 'smooth', block: 'center' })
        setFlashKey(key)
      }, 60),
      setTimeout(() => setFlashKey((cur) => (cur === key ? null : cur)), 1860),
    )
  }

  const ask = useAskThread({
    quizId: quiz.id,
    initialThreads: quiz.askThreads ?? [],
    enabled: true,
    onPersist: (threads) => void saveAskThreads(threads),
  })

  const activePassage = quiz.passages.find((p) => `p:${p.id}` === activeTab)
  const vocabCount = quiz.words.filter((w) => w.origin === 'vocab').length

  function explainState(passageId: string): ExplanationTriState {
    return explanationTriState(explanationSession, quiz, passageId)
  }

  /**
   * 「没写成」的原因文案：会话记了 AI 错误码就说真实原因（钉住的模型被删 →
   * 引导去设置），没记（含 App 重启后 session 为 undefined 的冷启动）用默认的
   * 「上次生成中断了」——冷启动时缺失确实源自中断，默认文案是对的。
   */
  function missingReason(passageId: string): string {
    const code = explanationSession?.missingErrorCodes[passageId]
    return code ? t(aiErrorMessageKey(code)) : t('quiz.paper.grade.explanationMissingReason')
  }

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
        <span className="text-[14px] font-semibold text-text-primary">{t('quiz.paper.grade.title')}</span>
        <span className="text-[12.5px] text-text-muted">
          {t('quiz.paper.take.meta', { date: dateLabel, difficulty: difficultyLabel, count: quiz.words.length })}
        </span>
      </div>

      <div className={`flex-1 overflow-y-auto ${ask.drawerOpen ? 'md:mr-[340px]' : ''}`}>
        {/* pb carries the home indicator's inset — unlike TakeView there's no
            fixed bottom bar here to absorb it, only a floating ask button. */}
        <div className="mx-auto max-w-[720px] px-4 pt-6 pb-[calc(var(--spacing-safe-bottom)+1.5rem)]">
          {result && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-border bg-bg-surface px-4 py-3">
              <span className="text-[19px] font-semibold text-text-primary">
                {result.score} / {result.total}
                {props.elapsedMs != null && (
                  <span className="ml-2 text-[12px] font-normal text-text-muted">
                    {t('quiz.paper.take.elapsed', { time: formatMs(props.elapsedMs) })}
                  </span>
                )}
              </span>
              {result.wrongWords.length > 0 && (
                <span className="text-[12.5px] text-text-secondary">
                  {quiz.config.demo
                    ? t('quiz.paper.grade.demoWrongWords')
                    : t('quiz.paper.grade.wrongWordsHint', { words: result.wrongWords.join('、') })}
                </span>
              )}
              <span className="flex-1" />
              <button
                type="button"
                onClick={onGoToPool}
                className="flex h-8 items-center rounded-md border border-border px-3 text-[12.5px] font-medium text-text-secondary hover:bg-bg-input"
              >
                {t('quiz.paper.grade.goToPool')}
              </button>
              <button
                type="button"
                onClick={onRetake}
                className="flex h-8 items-center rounded-md border border-border px-3 text-[12.5px] font-medium text-text-secondary hover:bg-bg-input"
              >
                {t('quiz.paper.grade.retake')}
              </button>
            </div>
          )}

          {vocabCount > 0 && (
            <div className="mt-3 rounded-lg border border-border-light bg-bg-muted px-4 py-2.5 text-[12.5px] text-text-secondary">
              {t('quiz.paper.grade.vocabBanner', { vocab: vocabCount, total: quiz.words.length })}
            </div>
          )}

          <div className="mt-5 flex gap-1 border-b border-border-light">
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
                {tabItem.label} <span className="ml-1 text-text-muted">{tabItem.correct}/{tabItem.total}</span>
              </button>
            ))}
          </div>

          {activePassage && (
            <div className="rounded-b-lg rounded-tr-lg border border-border bg-bg-surface p-6">
              <h3 className="font-serif text-[17px] font-semibold text-text-primary">{activePassage.title}</h3>
              {/* 与 TakeView 同款：真题卷面惯例两端对齐 + 浏览器连字符断词 */}
              <div lang="en" className="mt-3 max-w-[62ch] text-justify font-serif text-[14px] leading-[1.85] text-text-body hyphens-auto">
                {activePassage.paragraphs.map((para, i) => {
                  const key = `${activePassage.id}-${i + 1}`
                  return (
                    <p
                      key={key}
                      ref={(el) => {
                        paraRefs.current[key] = el
                      }}
                      data-ask-from={t('quiz.paper.ask.fromPassage', { n: activePassage.title, p: i + 1 })}
                      data-ask-ctx={para}
                      className={`mb-3 rounded px-1 -mx-1 transition-colors ${flashKey === key ? 'bg-accent-bg' : ''}`}
                    >
                      <span className="mr-1.5 select-none text-[11px] text-text-muted">¶{i + 1}</span>
                      {para}
                    </p>
                  )
                })}
              </div>

              <div className="mt-2 space-y-0 divide-y divide-border-light border-t border-border-light">
                {quiz.readingQuestions
                  .filter((q) => q.passageId === activePassage.id)
                  .map((q, i) => {
                    const v = verdictById.get(q.id)
                    if (!v) return null
                    const isOpen = expanded[q.id] ?? false
                    const state = explainState(q.passageId)
                    return (
                      <div key={q.id} className="py-4">
                        <div
                          className="flex flex-wrap items-baseline gap-x-2 gap-y-1"
                          data-ask-from={t('quiz.paper.ask.fromReading', { n: i + 1 })}
                          data-ask-ctx={readingAskCtx(q)}
                        >
                          <VerdictBadge correct={v.correct} t={t} />
                          <span className="font-serif text-[14px] leading-[1.6] text-text-primary">
                            <span className="mr-1 font-semibold text-accent-text">{t('quiz.paper.take.qPrefix', { n: i + 1 })}</span>
                            {q.stem}
                          </span>
                          <span className="text-[12px] text-text-muted">
                            {t('quiz.paper.grade.targetWord')} <b className="font-serif text-text-secondary">{q.targetWord}</b>
                          </span>
                        </div>

                        {!isOpen ? (
                          <button
                            type="button"
                            onClick={() => toggle(q.id)}
                            className="mt-2 flex items-center gap-1 text-[12px] text-text-muted hover:text-text-secondary"
                          >
                            <ChevronDown size={13} />
                            {t('quiz.paper.grade.foldHint')}
                          </button>
                        ) : (
                          <>
                            <div className="mt-3 space-y-1.5">
                              {q.options.map((opt) => {
                                const isRight = opt.label === q.answer
                                const isPicked = opt.label === v.userAnswer && !isRight
                                return (
                                  <div
                                    key={opt.label}
                                    data-ask-from={t('quiz.paper.ask.fromOption', { n: i + 1, label: opt.label })}
                                    data-ask-ctx={optionAskCtx(q, opt)}
                                    className={`rounded-lg border px-3 py-2 text-[13.5px] leading-[1.6] ${
                                      isRight
                                        ? 'border-success-text/40 bg-success-text/5'
                                        : isPicked
                                          ? 'border-danger-border bg-danger-bg'
                                          : 'border-border-light'
                                    }`}
                                  >
                                    <div className="flex flex-wrap items-baseline gap-x-1.5">
                                      <span className="font-serif text-text-primary">
                                        {opt.label}. {opt.text}
                                      </span>
                                      {opt.label === v.userAnswer && (
                                        <span className="rounded bg-bg-input px-1.5 py-0.5 text-[10.5px] font-medium text-text-muted">
                                          {t('quiz.paper.grade.yourPick')}
                                        </span>
                                      )}
                                      {state === 'ready' && opt.meaning && (
                                        <span className="text-[12px] text-text-muted">{opt.meaning}</span>
                                      )}
                                    </div>
                                    {state === 'ready' && opt.note && (
                                      <p className="mt-1 text-[12px] leading-[1.6] text-text-secondary">{opt.note}</p>
                                    )}
                                  </div>
                                )
                              })}
                            </div>

                            {state === 'running' && <ExplanationSkeleton t={t} />}
                            {state === 'missing' && (
                              <ExplanationMissing
                                onGenerate={() => regenerateExplanations([q.passageId])}
                                disabled={explanationSession?.running ?? false}
                                reason={missingReason(q.passageId)}
                                t={t}
                              />
                            )}
                            {state === 'ready' && (
                              <div className="mt-3 space-y-3.5 border-t border-border-light pt-3.5">
                                {(q.stemTranslation || q.howToSolve) && (
                                  <div>
                                    <SectionLabel t={t} k="quiz.paper.grade.sectionStem" />
                                    {q.stemTranslation && (
                                      <p className="text-[13px] leading-[1.7] text-text-secondary">{q.stemTranslation}</p>
                                    )}
                                    {q.howToSolve && (
                                      <p className="mt-1 text-[13px] leading-[1.7] text-text-secondary">
                                        <b className="text-accent-text">{t('quiz.paper.grade.howToSolve')}</b>
                                        {'：'}
                                        {q.howToSolve}
                                      </p>
                                    )}
                                  </div>
                                )}
                                {q.wordNote && (
                                  <div>
                                    <SectionLabel t={t} k="quiz.paper.grade.sectionWord" />
                                    <p className="rounded-md bg-bg-muted px-3 py-2 font-serif text-[13px] leading-[1.7] text-text-primary">
                                      {q.wordNote}
                                    </p>
                                  </div>
                                )}
                                <div>
                                  <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-muted">
                                    {t('quiz.paper.grade.sectionSource', { p: q.source.paragraph })}
                                  </div>
                                  <div
                                    data-ask-from={t('quiz.paper.ask.fromSource', { n: i + 1 })}
                                    data-ask-ctx={q.source.quote}
                                    className="rounded-md border border-border-light px-3 py-2"
                                  >
                                    <q className="font-serif text-[13px] leading-[1.7] text-text-primary">
                                      {highlightWord(q.source.quote, q.targetWord)}
                                    </q>
                                    <button
                                      type="button"
                                      onClick={() => goToSource(q.source.passageId, q.source.paragraph)}
                                      className="mt-1.5 block text-[12px] font-medium text-accent-text hover:underline"
                                    >
                                      {t('quiz.paper.grade.gotoSource', { p: q.source.paragraph })}
                                    </button>
                                  </div>
                                </div>
                                {q.answerDispute && <DisputeBanner text={q.answerDispute} t={t} />}
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    )
                  })}
              </div>
            </div>
          )}

          {activeTab === 'grammar' && quiz.grammarQuestions.length > 0 && (
            <div className="rounded-b-lg rounded-tr-lg border border-border bg-bg-surface p-6">
              <div className="divide-y divide-border-light">
                {quiz.grammarQuestions.map((q, i) => {
                  const v = verdictById.get(q.id)
                  if (!v) return null
                  const isOpen = expanded[q.id] ?? false
                  const state = explainState(q.passageId)
                  const parts = q.sentence.split('____')
                  const wrongForms = q.wrongForms ?? []
                  const userNorm = (v.userAnswer || '').trim().toLowerCase()
                  const matchedWrong = wrongForms.filter((wf) => wf.form.trim().toLowerCase() === userNorm)
                  const shownWrong = matchedWrong.length > 0 ? matchedWrong : userNorm ? wrongForms : []
                  const wrongTitleKey =
                    matchedWrong.length > 0 ? 'quiz.paper.grade.whyWrong' : 'quiz.paper.grade.commonWrong'
                  return (
                    <div key={q.id} className="py-4">
                      <div
                        className="flex flex-wrap items-baseline gap-x-2 gap-y-1"
                        data-ask-from={t('quiz.paper.ask.fromGrammar', { n: i + 1 })}
                        data-ask-ctx={grammarAskCtx(q)}
                      >
                        <VerdictBadge correct={v.correct} t={t} />
                        <span className="font-serif text-[14px] leading-[1.6] text-text-primary">
                          <span className="mr-1 font-semibold text-accent-text">{t('quiz.paper.take.gPrefix', { n: i + 1 })}</span>
                          {parts.map((part, pi) => (
                            <span key={pi}>
                              {part}
                              {pi < parts.length - 1 && <b>{q.answer}</b>}
                            </span>
                          ))}
                        </span>
                        <span className="text-[12px] text-text-muted">
                          {t('quiz.paper.grade.targetWord')} <b className="font-serif text-text-secondary">{q.targetWord}</b>
                        </span>
                      </div>

                      {!isOpen ? (
                        <button
                          type="button"
                          onClick={() => toggle(q.id)}
                          className="mt-2 flex items-center gap-1 text-[12px] text-text-muted hover:text-text-secondary"
                        >
                          <ChevronDown size={13} />
                          {t('quiz.paper.grade.foldHint')}
                        </button>
                      ) : (
                        <>
                          {state === 'running' && <ExplanationSkeleton t={t} />}
                          {state === 'missing' && (
                            <ExplanationMissing
                              onGenerate={() => regenerateExplanations([q.passageId])}
                              disabled={explanationSession?.running ?? false}
                              reason={missingReason(q.passageId)}
                              t={t}
                            />
                          )}
                          {state === 'ready' && (
                            <div className="mt-3 space-y-3.5 border-t border-border-light pt-3.5">
                              <div>
                                <SectionLabel t={t} k="quiz.paper.grade.sectionSentence" />
                                {q.sentenceTranslation && (
                                  <p className="text-[13px] leading-[1.7] text-text-secondary">{q.sentenceTranslation}</p>
                                )}
                                <p className="mt-1 text-[12.5px] text-text-secondary">
                                  {t('quiz.paper.grade.yourAnswer')}{' '}
                                  <b className="font-serif text-danger-text">{v.userAnswer || t('quiz.paper.grade.blank')}</b>
                                  {' · '}
                                  {t('quiz.paper.grade.correctAnswer')} <b className="font-serif text-success-text">{q.answer}</b>
                                </p>
                              </div>
                              {((q.grammarPoints?.length ?? 0) > 0 || (q.reasoning?.length ?? 0) > 0) && (
                                <div>
                                  <SectionLabel t={t} k="quiz.paper.grade.sectionChain" />
                                  {q.grammarPoints && q.grammarPoints.length > 0 && (
                                    <div className="mb-1.5 flex flex-wrap gap-1.5">
                                      {q.grammarPoints.map((gp, gpi) => (
                                        <span
                                          key={`${gp}-${gpi}`}
                                          className="rounded-full bg-accent-bg px-2 py-0.5 text-[11px] font-medium text-accent-text"
                                        >
                                          {gp}
                                        </span>
                                      ))}
                                    </div>
                                  )}
                                  {q.reasoning && q.reasoning.length > 0 && (
                                    <ol className="list-decimal space-y-1 pl-4 text-[13px] leading-[1.7] text-text-secondary">
                                      {q.reasoning.map((step, si) => (
                                        <li key={si}>{step}</li>
                                      ))}
                                    </ol>
                                  )}
                                </div>
                              )}
                              {!v.correct && shownWrong.length > 0 && (
                                <div>
                                  <SectionLabel t={t} k={wrongTitleKey} />
                                  <div className="space-y-1.5">
                                    {shownWrong.map((wf, wi) => (
                                      <div key={wi} className="rounded-md bg-danger-bg px-3 py-2 text-[12.5px] leading-[1.6]">
                                        <span className="mr-1.5 font-serif font-semibold text-danger-text">{wf.form}</span>
                                        <span className="text-text-secondary">{wf.note}</span>
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              )}
                              {q.wordMeaning && (
                                <p className="text-[12.5px] text-text-secondary">
                                  {t('quiz.paper.grade.targetWord')} <b className="font-serif text-text-primary">{q.targetWord}</b>{' '}
                                  {q.wordMeaning}
                                </p>
                              )}
                              {v.judgeNote && (
                                <p className="text-[12px] text-text-muted">{t('quiz.paper.grade.judgeNote', { note: v.judgeNote })}</p>
                              )}
                              {q.answerDispute && <DisputeBanner text={q.answerDispute} t={t} />}
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  )
                })}
              </div>
              <div className="mt-2 rounded-lg border border-border-light bg-bg-muted px-3 py-2.5 text-[12px] leading-[1.7] text-text-muted">
                {t('quiz.paper.grade.gradingNote')}
              </div>
            </div>
          )}
        </div>
      </div>

      {ask.askPop && (
        <button
          type="button"
          style={{ left: ask.askPop.x, top: ask.askPop.y }}
          onMouseDown={(e) => e.preventDefault()}
          onClick={ask.openThread}
          className="fixed z-50 flex -translate-x-1/2 -translate-y-full items-center gap-1 rounded-full bg-text-primary px-2.5 py-1.5 text-[12px] font-medium text-white shadow-context"
        >
          <MessageCircleQuestion size={13} />
          {t('quiz.paper.ask.trigger')}
        </button>
      )}

      {ask.drawerOpen && (
        <AskDrawer
          threads={ask.threads}
          activeThread={ask.activeThread}
          onSelectThread={ask.selectThread}
          onClose={ask.closeDrawer}
          onSend={ask.sendMessage}
          onRetry={ask.retry}
          sendingThreadId={ask.sendingThreadId}
          error={ask.error}
        />
      )}
    </div>
  )
}

function VerdictBadge({ correct, t }: { correct: boolean; t: (key: string) => string }) {
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
        correct ? 'bg-success-text/10 text-success-text' : 'bg-danger-bg text-danger-text'
      }`}
    >
      {correct ? t('quiz.paper.grade.correct') : t('quiz.paper.grade.wrong')}
    </span>
  )
}

function SectionLabel({ t, k }: { t: (key: string) => string; k: string }) {
  return <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-muted">{t(k)}</div>
}

function DisputeBanner({ text, t }: { text: string; t: (key: string) => string }) {
  return (
    <div className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-[12px] leading-[1.6] text-warning">
      <b className="mr-1">{t('quiz.paper.grade.disputeTag')}</b>
      {text}
    </div>
  )
}

function formatMs(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}
