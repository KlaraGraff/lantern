import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  AnswerSheet,
  AppSettings,
  AskMessage,
  AskThread,
  GrammarFillQuestion,
  Quiz,
  ReadingOption,
  ReadingQuestion,
} from '../types'
import { buildAskSystemPrompt, callChat, profileReady } from '../llm'
import { saveAskThreads } from './_store'
import { DIFFICULTY_LABELS, formatDateCN, highlightWord, loadDraft, saveDraft } from './util'
import { ConfirmModal } from './ConfirmModal'
import { AskDrawer } from './AskDrawer'

/** 追问气泡的位置与来源快照：选区变化时更新，点击时据此建一条新线程 */
interface AskPop {
  quote: string
  quoteFrom: string
  context: string
  x: number
  y: number
}

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

/** 评卷卡片展开态初值：错题展开、对题折叠；未交卷时为空表 */
function initExpanded(quiz: Quiz): Record<string, boolean> {
  const init: Record<string, boolean> = {}
  for (const v of quiz.result?.verdicts ?? []) init[v.questionId] = !v.correct
  return init
}

/** 屏 3/4 合一：试卷 —— 未交卷是作答态，交卷后原位转入评卷态（判分/讲解/选取追问都长在题目下面） */
export function QuizView(props: {
  quiz: Quiz
  answers: AnswerSheet
  onAnswersChange: (a: AnswerSheet) => void
  onSubmit: () => void
  submitting: boolean
  settings: AppSettings
  /** 本次作答的总用时（仅刚交卷那次会话里有；从历史打开旧卷时未知，不显示） */
  elapsedLabel: string | null
  onGoToPool: () => void
  onRetake: () => void
}) {
  const { quiz, answers, onAnswersChange, onSubmit, submitting, settings, elapsedLabel, onGoToPool, onRetake } = props

  const reviewMode = quiz.status === 'submitted' && !!quiz.result
  // 追问要联网调真实模型：当前没配好 key 不行，这张卷本身是演示卷（内置词表出的）也不行——
  // 演示卷没有真实生成上下文，就算这次 session 配了 key 也不该对它联网追问
  const askDisabled = quiz.config.demo || settings.demoMode || !profileReady(settings.profile)

  const tabs = useMemo(() => {
    const list = quiz.passages.map((p, i) => {
      const qs = quiz.readingQuestions.filter((q) => q.passageId === p.id)
      const correct = quiz.result ? qs.filter((q) => quiz.result!.verdicts.find((v) => v.questionId === q.id)?.correct).length : 0
      return { key: `p:${p.id}`, label: `Passage ${i + 1}`, total: qs.length, correct }
    })
    if (quiz.grammarQuestions.length > 0) {
      const correct = quiz.result
        ? quiz.grammarQuestions.filter((q) => quiz.result!.verdicts.find((v) => v.questionId === q.id)?.correct).length
        : 0
      list.push({ key: 'grammar', label: '语法填空', total: quiz.grammarQuestions.length, correct })
    }
    return list
  }, [quiz])

  const [activeTab, setActiveTab] = useState(tabs[0]?.key ?? '')
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [savedToast, setSavedToast] = useState(false)
  const paraRefs = useRef<Record<string, HTMLParagraphElement | null>>({})
  const [flashKey, setFlashKey] = useState<string | null>(null)

  // 评卷卡片展开态：错题默认展开、对题默认折叠。用渲染期派生而不是 effect 初始化——
  // effect 要到下一帧才跑，交卷瞬间会先闪一帧全折叠
  const expandKey = `${quiz.id ?? 'new'}:${quiz.status}`
  const [expandedState, setExpandedState] = useState(() => ({ key: expandKey, map: initExpanded(quiz) }))
  if (expandedState.key !== expandKey) {
    setExpandedState({ key: expandKey, map: initExpanded(quiz) })
  }
  const expanded = expandedState.map

  function toggle(id: string) {
    setExpandedState((s) => ({ ...s, map: { ...s.map, [id]: !s.map[id] } }))
  }

  // 选取追问：气泡 + 抽屉 + 线程列表，随当前卷子本地持有，直接落库，不进 App 状态。
  // threadsRef 与 state 同步：异步回调（AI 回复到达）要基于最新线程列表算 next，
  // 不能信闭包里的旧 askThreads，也不许在 setState updater 里做落库副作用（StrictMode 会双调）
  const [askThreads, setAskThreads] = useState<AskThread[]>(() => quiz.askThreads ?? [])
  const threadsRef = useRef(askThreads)
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [askPop, setAskPop] = useState<AskPop | null>(null)
  // 发送中/报错都记线程 id：发送时切到别的线程，加载态和错误条不能跟过去
  const [sendingThreadId, setSendingThreadId] = useState<string | null>(null)
  const [askError, setAskError] = useState<{ threadId: string; message: string } | null>(null)

  function commitThreads(next: AskThread[], persist: boolean) {
    threadsRef.current = next
    setAskThreads(next)
    if (persist && quiz.id) void saveAskThreads(quiz.id, next)
  }

  useEffect(() => {
    threadsRef.current = quiz.askThreads ?? []
    setAskThreads(threadsRef.current)
    setActiveThreadId(null)
    setDrawerOpen(false)
    setAskPop(null)
    setAskError(null)
    // 仅在切换到另一张卷子时重新从 quiz.askThreads 取初值；本组件后续对 askThreads 的写入
    // 直接进 state + 落库，不应反过来触发这个重置效果，故意不把 quiz.askThreads 放进依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quiz.id])

  // 监听选区：只在评卷模式生效，且只在打了 data-ask-from 标记的区域内才浮出气泡
  useEffect(() => {
    if (!reviewMode) return
    function onSelectionChange() {
      const sel = window.getSelection()
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
        setAskPop(null)
        return
      }
      const text = sel.toString().trim()
      if (!text) {
        setAskPop(null)
        return
      }
      const range = sel.getRangeAt(0)
      const node = range.commonAncestorContainer
      const el = node.nodeType === 1 ? (node as Element) : node.parentElement
      const from = el?.closest<HTMLElement>('[data-ask-from]')
      if (!from) {
        setAskPop(null)
        return
      }
      const rect = range.getBoundingClientRect()
      if (rect.width === 0 && rect.height === 0) {
        setAskPop(null)
        return
      }
      setAskPop({
        quote: text,
        quoteFrom: from.dataset.askFrom ?? '',
        context: from.dataset.askCtx ?? text,
        x: rect.left + rect.width / 2,
        y: rect.top,
      })
    }
    document.addEventListener('selectionchange', onSelectionChange)
    return () => document.removeEventListener('selectionchange', onSelectionChange)
  }, [reviewMode])

  function openAskThread() {
    if (!askPop) return
    const thread: AskThread = {
      id: crypto.randomUUID(),
      quote: askPop.quote,
      quoteFrom: askPop.quoteFrom,
      context: askPop.context,
      messages: [],
      createdAt: new Date().toISOString(),
    }
    // 空线程先不落库：一条消息没发就关掉的线程会被 closeDrawer 清理
    commitThreads([...threadsRef.current, thread], false)
    setActiveThreadId(thread.id)
    setDrawerOpen(true)
    setAskPop(null)
    window.getSelection()?.removeAllRanges()
  }

  function closeDrawer() {
    setDrawerOpen(false)
    // 一条消息都没发过的空线程不值得留着，关闭时顺手清掉（没落过库，无需重写库）
    commitThreads(
      threadsRef.current.filter((t) => !(t.id === activeThreadId && t.messages.length === 0)),
      false,
    )
    setActiveThreadId(null)
  }

  async function sendToApi(thread: AskThread) {
    if (!quiz.id || thread.messages.length === 0) return
    setSendingThreadId(thread.id)
    setAskError((cur) => (cur?.threadId === thread.id ? null : cur))
    try {
      const system = buildAskSystemPrompt({ quote: thread.quote, quoteFrom: thread.quoteFrom, context: thread.context })
      const reply = await callChat({
        profile: settings.profile,
        system,
        messages: thread.messages.map((m) => ({ role: m.role, content: m.content })),
        maxTokens: 1200,
      })
      const aiMsg: AskMessage = { role: 'assistant', content: reply, at: new Date().toISOString() }
      const finalThread: AskThread = { ...thread, messages: [...thread.messages, aiMsg] }
      commitThreads(
        threadsRef.current.map((t) => (t.id === thread.id ? finalThread : t)),
        true,
      )
    } catch (e) {
      setAskError({ threadId: thread.id, message: e instanceof Error ? e.message : '追问失败，请重试' })
    } finally {
      setSendingThreadId((cur) => (cur === thread.id ? null : cur))
    }
  }

  function handleAskSend(text: string) {
    const thread = threadsRef.current.find((t) => t.id === activeThreadId)
    if (!thread) return
    const userMsg: AskMessage = { role: 'user', content: text, at: new Date().toISOString() }
    const withUser: AskThread = { ...thread, messages: [...thread.messages, userMsg] }
    // 用户这一轮先落库：AI 回复失败或中途离开页面，提问本身也不能丢
    commitThreads(
      threadsRef.current.map((t) => (t.id === thread.id ? withUser : t)),
      true,
    )
    void sendToApi(withUser)
  }

  function handleAskRetry() {
    const errored = askError
    if (!errored) return
    const thread = threadsRef.current.find((t) => t.id === errored.threadId)
    if (thread && thread.messages.length > 0) void sendToApi(thread)
    else setAskError(null)
  }

  // 试卷草稿：进入未交卷的卷子时尝试恢复本地暂存的作答
  useEffect(() => {
    if (reviewMode) return
    const draft = loadDraft(quiz.id)
    if (draft && Object.keys(draft).length > 0) onAnswersChange({ ...draft, ...answers })
    // 仅在挂载/切换试卷时尝试恢复一次，answers/onAnswersChange 有意不进依赖数组
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quiz.id, reviewMode])

  // 自动暂存：每次作答变化都写一次草稿，导航离开再回来答案不丢
  useEffect(() => {
    if (!reviewMode && quiz.id) saveDraft(quiz.id, answers)
  }, [answers, quiz.id, reviewMode])

  const totalQuestions = quiz.readingQuestions.length + quiz.grammarQuestions.length
  const answeredCount = useMemo(() => {
    const ids = [...quiz.readingQuestions.map((q) => q.id), ...quiz.grammarQuestions.map((q) => q.id)]
    return ids.filter((id) => (answers[id] ?? '').trim() !== '').length
  }, [quiz, answers])

  function setAnswer(id: string, value: string) {
    if (reviewMode) return
    onAnswersChange({ ...answers, [id]: value })
  }

  function handleSubmitClick() {
    if (answeredCount < totalQuestions) {
      setConfirmOpen(true)
      return
    }
    doSubmit()
  }

  function doSubmit() {
    setConfirmOpen(false)
    saveDraft(quiz.id, {}) // 交卷后清掉草稿占位（写入空对象等价于失效，避免重新加载出旧作答）
    onSubmit()
  }

  function handleSaveDraft() {
    saveDraft(quiz.id, answers)
    setSavedToast(true)
    setTimeout(() => setSavedToast(false), 1600)
  }

  // 溯源跳转：切到对应 tab，滚动到段落并短暂高亮（原位评卷，跳转不再离开这个视图）
  const sourceTimers = useRef<ReturnType<typeof setTimeout>[]>([])
  useEffect(() => () => sourceTimers.current.forEach(clearTimeout), [])
  function goToSource(passageId: string, paragraph: number) {
    setActiveTab(`p:${passageId}`)
    const key = `${passageId}-${paragraph}`
    sourceTimers.current.push(
      setTimeout(() => {
        paraRefs.current[key]?.scrollIntoView({ behavior: 'smooth', block: 'center' })
        setFlashKey(key)
      }, 60),
      setTimeout(() => setFlashKey((cur) => (cur === key ? null : cur)), 1860),
    )
  }

  const activePassage = quiz.passages.find((p) => `p:${p.id}` === activeTab)
  const activePassageIndex = activePassage ? quiz.passages.findIndex((p) => p.id === activePassage.id) : -1

  const result = quiz.result
  const verdictById = useMemo(() => new Map((result?.verdicts ?? []).map((v) => [v.questionId, v])), [result])
  const dueDateLabel = result
    ? formatDateCN(new Date(new Date(result.submittedAt).getTime() + 2 * 86400000).toISOString())
    : ''

  return (
    <div className="app-body">
      {quiz.config.demo && <div className="center-note" style={{ textAlign: 'left', marginBottom: 12 }}>演示卷使用内置词表</div>}

      {reviewMode && result && (
        <div className="scorebar">
          <span className="big">
            {result.score} / {result.total}
            {elapsedLabel && <small> 用时 {elapsedLabel}</small>}
          </span>
          {result.wrongWords.length > 0 &&
            (quiz.config.demo ? (
              <span className="pool-hint">演示卷的错词不写入错词池</span>
            ) : (
              <span className="pool-hint">
                <b className="en-serif">{result.wrongWords.join('、')}</b> 已入错词池，2 天后重现
              </span>
            ))}
          <span className="spacer" />
          <button className="btn btn-ghost btn-sm" onClick={onGoToPool}>
            错词池
          </button>
          <button className="btn btn-ghost btn-sm" onClick={onRetake}>
            再出一卷
          </button>
        </div>
      )}

      <div className="tabs">
        {tabs.map((t) => (
          <button key={t.key} className={activeTab === t.key ? 'on' : ''} onClick={() => setActiveTab(t.key)}>
            {t.label}{' '}
            <span className="badge">
              {reviewMode ? `${t.correct}/${t.total}` : `${t.total} ${t.key === 'grammar' ? '空' : '题'}`}
            </span>
          </button>
        ))}
      </div>

      {activePassage && (
        <div className="passage">
          <h3 className="en-serif">{activePassage.title}</h3>
          <div className="p-meta">
            {DIFFICULTY_LABELS[quiz.config.difficulty]} Reading · 约{' '}
            {activePassage.paragraphs.join(' ').split(/\s+/).filter(Boolean).length} words
          </div>
          <div className="en-serif">
            {activePassage.paragraphs.map((para, i) => {
              const key = `${activePassage.id}-${i + 1}`
              return (
                <p
                  key={key}
                  ref={(el) => {
                    paraRefs.current[key] = el
                  }}
                  className={flashKey === key ? 'flash' : ''}
                  data-ask-from={reviewMode ? `Passage ${activePassageIndex + 1} · ¶${i + 1}` : undefined}
                  data-ask-ctx={reviewMode ? para : undefined}
                >
                  <span className="pnum">¶{i + 1}</span>
                  {para}
                </p>
              )
            })}
          </div>

          {quiz.readingQuestions
            .filter((q) => q.passageId === activePassage.id)
            .map((q, i) => {
              if (!reviewMode) {
                return (
                  <div className="q" key={q.id}>
                    <div className="stem">
                      <span className="qno">Q{i + 1}.</span>
                      {q.stem}
                    </div>
                    <div className="opts">
                      {q.options.map((opt) => {
                        const picked = answers[q.id] === opt.label
                        return (
                          <button
                            key={opt.label}
                            className={`opt ${picked ? 'picked' : ''}`}
                            onClick={() => setAnswer(q.id, opt.label)}
                          >
                            <span className="radio" />
                            <span className="en-serif">
                              {opt.label}. {opt.text}
                            </span>
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )
              }

              const v = verdictById.get(q.id)
              if (!v) return null
              const isOpen = expanded[q.id] ?? false
              const hasStructured = !!(q.stemTranslation || q.howToSolve || q.wordNote || q.options.some((o) => o.meaning || o.note))
              return (
                <div className="rcard" key={q.id}>
                  <div className="rcard-head" data-ask-from={`阅读 Q${i + 1}`} data-ask-ctx={readingAskCtx(q)}>
                    <span className={`verdict ${v.correct ? 'right' : 'wrong'}`}>{v.correct ? '✓ 答对' : '✗ 答错'}</span>
                    <span className="stemline en-serif">
                      Q{i + 1}. {q.stem}
                    </span>
                    <span className="word-tag">
                      考点词 <b className="en-serif">{q.targetWord}</b>
                    </span>
                  </div>
                  {isOpen && (
                    <div className="rcard-body">
                      <div className="rv-opts">
                        {q.options.map((opt) => {
                          const isRight = opt.label === q.answer
                          const isYourPick = opt.label === v.userAnswer
                          const isPicked = isYourPick && !isRight
                          return (
                            <div
                              key={opt.label}
                              className={`rv-opt ${isRight ? 'right' : ''} ${isPicked ? 'picked' : ''}`}
                              data-ask-from={`阅读 Q${i + 1} · 选项 ${opt.label}`}
                              data-ask-ctx={optionAskCtx(q, opt)}
                            >
                              <span className="tick">{isRight ? '✓' : isPicked ? '✗' : '·'}</span>
                              <span className="text en-serif">
                                {opt.label}. {opt.text}
                                {isYourPick && <span className="your-pick">你的选择</span>}
                              </span>
                              {opt.meaning && <span className="meaning">{opt.meaning}</span>}
                              {opt.note && <span className="why">{opt.note}</span>}
                            </div>
                          )
                        })}
                      </div>
                      <div className="explain">
                        {(q.stemTranslation || q.howToSolve) && (
                          <div className="sec">
                            <div className="sec-label">题目在问什么</div>
                            {q.stemTranslation && <div className="stem-zh">{q.stemTranslation}</div>}
                            {q.howToSolve && (
                              <div className="stem-zh" style={{ marginTop: 4 }}>
                                <b style={{ color: 'var(--accent)' }}>怎么下手</b>：{q.howToSolve}
                              </div>
                            )}
                          </div>
                        )}
                        {q.wordNote && (
                          <div className="sec">
                            <div className="sec-label">考点词</div>
                            <div className="wordcard">{q.wordNote}</div>
                          </div>
                        )}
                        {!hasStructured && q.explanation && (
                          <div className="sec">
                            <div className="sec-label">讲解</div>
                            <p className="legacy-explain">{q.explanation}</p>
                          </div>
                        )}
                        <div className="sec">
                          <div className="sec-label">溯源 · 第 {q.source.paragraph} 段</div>
                          <div className="source">
                            <div className="src-label">答案依据</div>
                            <q className="en-serif">{highlightWord(q.source.quote, q.targetWord)}</q>
                            <br />
                            <button className="goto" onClick={() => goToSource(q.source.passageId, q.source.paragraph)}>
                              跳到原文 ¶{q.source.paragraph} ↑
                            </button>
                          </div>
                        </div>
                        {!v.correct && !quiz.config.demo && (
                          <div className="recur-note">
                            ↻ {q.targetWord} 已加入错词池，将于 {dueDateLabel} 混入新卷重现。
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                  <button className="fold-hint" onClick={() => toggle(q.id)}>
                    {isOpen ? '收起讲解 ▴' : '点开看逐选项讲解 ▾'}
                  </button>
                </div>
              )
            })}
        </div>
      )}

      {activeTab === 'grammar' && (
        <div>
          {quiz.grammarQuestions.map((q, i) => {
            // 句子里 ____ 可能不止一处，全量按段落 join，中间统一插同一个输入框
            const parts = q.sentence.split('____')
            if (!reviewMode) {
              return (
                <div className="q" key={q.id}>
                  <div className="stem en-serif" style={{ fontWeight: 400 }}>
                    <span className="qno" style={{ fontWeight: 600 }}>
                      G{i + 1}.
                    </span>
                    {parts.map((part, pi) => (
                      <span key={pi}>
                        {part}
                        {pi < parts.length - 1 && (
                          <input
                            className="blank-input"
                            value={answers[q.id] ?? ''}
                            onChange={(e) => setAnswer(q.id, e.target.value)}
                            placeholder="填写"
                          />
                        )}
                      </span>
                    ))}{' '}
                    <span className="basword">({q.hint})</span>
                  </div>
                </div>
              )
            }

            const v = verdictById.get(q.id)
            if (!v) return null
            const isOpen = expanded[q.id] ?? false
            const hasStructured = !!(q.sentenceTranslation || q.grammarPoints?.length || q.reasoning?.length || q.wordMeaning)
            const wrongForms = q.wrongForms ?? []
            const userNorm = (v.userAnswer || '').trim().toLowerCase()
            const matchedWrong = wrongForms.filter((wf) => wf.form.trim().toLowerCase() === userNorm)
            // 匹配到用户的误填才叫「为什么你的答案不对」；匹配不到只能当「常见错填」讲，
            // 未作答的人连错法都没有，整块不出
            const shownWrong = matchedWrong.length > 0 ? matchedWrong : userNorm ? wrongForms : []
            const wrongTitle = matchedWrong.length > 0 ? '为什么你的答案不对' : '常见错填'
            return (
              <div className="rcard" key={q.id}>
                <div className="rcard-head" data-ask-from={`语法填空 G${i + 1}`} data-ask-ctx={grammarAskCtx(q)}>
                  <span className={`verdict ${v.correct ? 'right' : 'wrong'}`}>{v.correct ? '✓ 答对' : '✗ 答错'}</span>
                  <span className="stemline en-serif">
                    G{i + 1}.{' '}
                    {parts.map((part, pi) => (
                      <span key={pi}>
                        {part}
                        {pi < parts.length - 1 && <b>{q.answer}</b>}
                      </span>
                    ))}
                  </span>
                  <span className="word-tag">
                    考点词 <b className="en-serif">{q.targetWord}</b>
                  </span>
                </div>
                {isOpen && (
                  <div className="rcard-body">
                    <div className="explain">
                      <div className="sec">
                        <div className="sec-label">原句与翻译</div>
                        {q.sentenceTranslation && <div className="stem-zh">{q.sentenceTranslation}</div>}
                        <div className="oneline-word">
                          你的答案：<b className="en-serif">{v.userAnswer || '（未作答）'}</b> · 正确答案：
                          <b className="en-serif">{q.answer}</b>
                        </div>
                      </div>
                      {((q.grammarPoints?.length ?? 0) > 0 || (q.reasoning?.length ?? 0) > 0) && (
                        <div className="sec">
                          <div className="sec-label">语法讲解</div>
                          {q.grammarPoints && q.grammarPoints.length > 0 && (
                            <div>
                              {q.grammarPoints.map((gp, gpi) => (
                                <span className="gp-tag" key={`${gp}-${gpi}`}>
                                  {gp}
                                </span>
                              ))}
                            </div>
                          )}
                          {q.reasoning && q.reasoning.length > 0 && (
                            <ul className="chain">
                              {q.reasoning.map((step, si) => (
                                <li key={si}>{step}</li>
                              ))}
                            </ul>
                          )}
                        </div>
                      )}
                      {!hasStructured && q.explanation && (
                        <div className="sec">
                          <div className="sec-label">讲解</div>
                          <p className="legacy-explain">{q.explanation}</p>
                        </div>
                      )}
                      {!v.correct && shownWrong.length > 0 && (
                        <div className="sec">
                          <div className="sec-label">{wrongTitle}</div>
                          {shownWrong.map((wf, wi) => (
                            <div className="badform" key={wi}>
                              <span className="f en-serif">{wf.form}</span>
                              <span>{wf.note}</span>
                            </div>
                          ))}
                        </div>
                      )}
                      {q.wordMeaning && (
                        <div className="oneline-word">
                          考点词 <b className="en-serif">{q.targetWord}</b> {q.wordMeaning}
                        </div>
                      )}
                      {v.judgeNote && <div className="judge-note">AI 判分说明：{v.judgeNote}</div>}
                      {!v.correct && !quiz.config.demo && (
                        <div className="recur-note">
                          ↻ {q.targetWord} 已加入错词池，将于 {dueDateLabel} 混入新卷重现。
                        </div>
                      )}
                    </div>
                  </div>
                )}
                <button className="fold-hint" onClick={() => toggle(q.id)}>
                  {isOpen ? '收起讲解 ▴' : '点开看讲解 ▾'}
                </button>
              </div>
            )
          })}
        </div>
      )}

      {!reviewMode && (
        <>
          <div style={{ height: 84 }} />
          <div className="sheetbar">
            <button className="btn btn-primary" disabled={submitting} onClick={handleSubmitClick}>
              {submitting ? '判分中…' : '交卷判分'}
            </button>
            <button className="btn btn-ghost" onClick={handleSaveDraft}>
              存草稿
            </button>
            <span className="spacer" style={{ flex: 1 }} />
            <span className="count">
              已答 {answeredCount} / {totalQuestions}
            </span>
          </div>
        </>
      )}

      {confirmOpen && (
        <ConfirmModal
          title="还有题没答"
          body={`已答 ${answeredCount} / ${totalQuestions} 题，未作答的题按错处理。确定现在交卷吗？`}
          confirmLabel="仍然交卷"
          onConfirm={doSubmit}
          onCancel={() => setConfirmOpen(false)}
        />
      )}

      {savedToast && <div className="toast">已保存到本地草稿</div>}

      {askPop && (
        <button
          className="ask-pop"
          style={{ left: askPop.x, top: askPop.y }}
          // mousedown 的默认行为会折叠文档选区 → selectionchange 把气泡卸掉 →
          // mouseup 落空，click 永远不触发。划词工具条必须拦掉这个默认行为
          onMouseDown={(e) => e.preventDefault()}
          onClick={openAskThread}
        >
          ✦ 问 AI
        </button>
      )}

      {drawerOpen && (
        <AskDrawer
          threads={askThreads}
          activeThreadId={activeThreadId}
          onSelectThread={setActiveThreadId}
          onClose={closeDrawer}
          onSend={handleAskSend}
          onRetry={handleAskRetry}
          sendingThreadId={sendingThreadId}
          error={askError}
          disabled={askDisabled}
        />
      )}
    </div>
  )
}
