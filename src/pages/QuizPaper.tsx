/**
 * 词卷试卷页：做题（status=ready）与评卷（status=submitted）同路由，按卷状态切换。
 * 样张：docs/impls/cijuan-merge-mockup.html §D / §E（含解析骨架/补生成态与追问抽屉）。
 *
 * 本文件只负责「按状态切视图 + 接住交卷回调」，做题/评卷的实际渲染都在
 * quiz/TakeView.tsx、quiz/GradeView.tsx；数据加载/提交/追问持久化在 useQuizPaper.ts。
 */
import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { useTranslation } from 'react-i18next'
import { ArrowLeft } from 'lucide-react'
import { useQuizPaper } from './quiz/useQuizPaper.ts'
import TakeView from './quiz/TakeView.tsx'
import GradeView from './quiz/GradeView.tsx'
import type { QuizResult } from '../quiz/types.ts'

export default function QuizPaper() {
  const { paperId } = useParams<{ paperId: string }>()
  const navigate = useNavigate()
  const { t } = useTranslation()
  const numericId = paperId != null && paperId !== '' ? Number(paperId) : NaN
  const validId = Number.isFinite(numericId) ? numericId : null

  const { quiz, status, submit, saveAskThreads, explanationSession, regenerateExplanations } =
    useQuizPaper(validId)

  // 做题用时只在「本次交卷会话」里有意义：换卷（或从评卷页刷新回做题态，理论上
  // 不会发生但保险起见）时清空，不带着上一张卷的用时串场。
  const [elapsedMs, setElapsedMs] = useState<number | null>(null)
  useEffect(() => {
    setElapsedMs(null)
  }, [validId])

  function exit() {
    navigate(-1)
  }
  function retake() {
    navigate('/quiz')
  }
  function goToPool() {
    navigate('/quiz?tab=pool')
  }

  if (status === 'loading') {
    return <div className="h-screen bg-bg-page" />
  }

  if (status === 'not-found' || !quiz || validId == null) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3 bg-bg-page px-6 text-center">
        <p className="text-[14px] text-text-secondary">{t('quiz.paper.notFound')}</p>
        <button
          type="button"
          onClick={exit}
          className="flex h-9 items-center gap-1.5 rounded-lg border border-border px-4 text-[13px] font-medium text-text-secondary hover:bg-bg-input"
        >
          <ArrowLeft size={15} />
          {t('quiz.paper.exit')}
        </button>
      </div>
    )
  }

  if (quiz.status === 'ready') {
    return (
      <TakeView
        quiz={quiz}
        onExit={exit}
        onSubmit={async (result: QuizResult, ms: number) => {
          await submit(result)
          setElapsedMs(ms)
        }}
      />
    )
  }

  return (
    <GradeView
      key={quiz.id}
      quiz={quiz}
      paperId={validId}
      elapsedMs={elapsedMs}
      explanationSession={explanationSession}
      regenerateExplanations={regenerateExplanations}
      saveAskThreads={saveAskThreads}
      onExit={exit}
      onRetake={retake}
      onGoToPool={goToPool}
    />
  )
}
