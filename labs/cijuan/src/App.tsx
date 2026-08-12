import { useEffect, useState } from 'react'
import type { AnswerSheet, AppSettings, Quiz, QuizConfig, QuizWord, WrongWordEntry } from './types'
import { WORDS_PER_PASSAGE } from './types'
import { generateQuiz, generateMockQuiz, judgeGrammar, profileReady, type GenerateStep } from './llm'
import {
  loadSettings,
  saveSettings,
  gradeQuiz,
  saveQuiz,
  listQuizzes,
  submitQuiz,
  getDueWords,
  listWrongWords,
  clearAllWrongWords,
} from './ui/_store'
import { AppShell, type NavTarget } from './ui/AppShell'
import { Setup } from './ui/Setup'
import { Generating } from './ui/Generating'
import { QuizView } from './ui/QuizView'
import { WrongWordPool } from './ui/WrongWordPool'
import { History } from './ui/History'
import { SettingsModal } from './ui/SettingsModal'
import { formatElapsed } from './ui/util'

type Screen = 'setup' | 'generating' | 'quiz' | 'pool' | 'history'

const SCREEN_NAV: Record<Screen, NavTarget | null> = {
  setup: 'setup',
  generating: 'setup',
  quiz: 'setup',
  pool: 'pool',
  history: 'history',
}

export default function App() {
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings())
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [screen, setScreen] = useState<Screen>('setup')

  const [dueWords, setDueWords] = useState<WrongWordEntry[]>([])
  const [wrongWords, setWrongWords] = useState<WrongWordEntry[]>([])
  const [quizzes, setQuizzes] = useState<Quiz[]>([])

  const [activeQuiz, setActiveQuiz] = useState<Quiz | null>(null)
  const [answers, setAnswers] = useState<AnswerSheet>({})
  const [submitting, setSubmitting] = useState(false)
  const [quizStartedAt, setQuizStartedAt] = useState<number | null>(null)
  const [elapsedSec, setElapsedSec] = useState(0)
  // 交卷那一刻定格的用时：只有本会话现出现场生成→作答→交卷才有；从历史打开旧卷不知道原始用时
  const [submittedElapsedSec, setSubmittedElapsedSec] = useState<number | null>(null)

  const [genStep, setGenStep] = useState<GenerateStep>('splitting')
  const [genConfig, setGenConfig] = useState<QuizConfig | null>(null)
  const [genWords, setGenWords] = useState<QuizWord[]>([])
  const [genError, setGenError] = useState<string | null>(null)

  const [toast, setToast] = useState<string | null>(null)
  const showToast = (msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(null), 2200)
  }

  useEffect(() => {
    getDueWords().then(setDueWords)
  }, [])

  useEffect(() => {
    if (screen !== 'quiz' || quizStartedAt === null || activeQuiz?.status === 'submitted') return
    const id = setInterval(() => setElapsedSec(Math.floor((Date.now() - quizStartedAt) / 1000)), 1000)
    return () => clearInterval(id)
  }, [screen, quizStartedAt, activeQuiz?.status])

  function handleNavigate(target: NavTarget) {
    if (target === 'setup') {
      setScreen('setup')
      getDueWords().then(setDueWords)
    } else if (target === 'pool') {
      setScreen('pool')
      listWrongWords().then(setWrongWords)
    } else {
      setScreen('history')
      listQuizzes().then(setQuizzes)
    }
  }

  async function doGenerate(words: QuizWord[], config: QuizConfig) {
    setGenError(null)
    try {
      const useMock = settings.demoMode || !profileReady(settings.profile)
      const quiz = useMock
        ? await generateMockQuiz({ words, config, onProgress: setGenStep })
        : await generateQuiz({ profile: settings.profile, words, config, onProgress: setGenStep })
      const id = await saveQuiz(quiz)
      setActiveQuiz({ ...quiz, id })
      setAnswers({})
      setQuizStartedAt(Date.now())
      setElapsedSec(0)
      setSubmittedElapsedSec(null)
      setScreen('quiz')
    } catch (e) {
      setGenError(e instanceof Error ? e.message : '生成失败，请稍后重试')
    }
  }

  function handleStartGenerate(words: QuizWord[], config: QuizConfig) {
    setGenWords(words)
    setGenConfig(config)
    setGenStep('splitting')
    setGenError(null)
    setScreen('generating')
    void doGenerate(words, config)
  }

  async function handleSubmit() {
    if (!activeQuiz?.id) return
    setSubmitting(true)
    try {
      const usingDemo = settings.demoMode || !profileReady(settings.profile)
      const verdicts = await judgeGrammar({
        profile: usingDemo ? null : settings.profile,
        questions: activeQuiz.grammarQuestions,
        answers,
      })
      const result = gradeQuiz(activeQuiz, answers, verdicts)
      await submitQuiz(activeQuiz.id, result)
      // 原位评卷：不切屏，留在同一个 QuizView 实例里，quiz.status 一变它自己转入评卷态
      setSubmittedElapsedSec(elapsedSec)
      setActiveQuiz({ ...activeQuiz, status: 'submitted', result })
      getDueWords().then(setDueWords)
      listWrongWords().then(setWrongWords)
    } catch (e) {
      showToast(e instanceof Error ? e.message : '判分失败，请重试')
    } finally {
      setSubmitting(false)
    }
  }

  function handleOpenHistoryQuiz(quiz: Quiz) {
    const resuming = quiz.id === activeQuiz?.id
    setActiveQuiz(quiz)
    setScreen('quiz')
    if (quiz.status === 'submitted' && quiz.result) {
      setSubmittedElapsedSec(null) // 历史卷不知道原始用时，评卷条不显示「用时」
    } else {
      // 同一张卷子导航离开再回来：保留答到一半的作答，不清空
      if (!resuming) setAnswers({})
      setQuizStartedAt(Date.now())
      setElapsedSec(0)
      setSubmittedElapsedSec(null)
    }
  }

  function handleClearPool() {
    clearAllWrongWords().then(() => {
      listWrongWords().then(setWrongWords)
      getDueWords().then(setDueWords)
    })
  }

  function handleSaveSettings(next: AppSettings) {
    saveSettings(next)
    setSettings(next)
    setSettingsOpen(false)
  }

  const usingDemo = settings.demoMode || !profileReady(settings.profile)
  const keyLabel = usingDemo ? '演示模式' : 'API key 已连接'

  return (
    <>
      {screen !== 'generating' && (
        <AppShell
          active={SCREEN_NAV[screen]}
          onNavigate={handleNavigate}
          keyReady={!usingDemo}
          keyLabel={keyLabel}
          onOpenSettings={() => setSettingsOpen(true)}
          right={
            screen === 'quiz' && activeQuiz?.status !== 'submitted' ? (
              <span className="key-state">用时 {formatElapsed(elapsedSec)}</span>
            ) : null
          }
        />
      )}

      {screen === 'setup' && (
        <Setup
          settings={settings}
          onSettingsChange={(next) => {
            setSettings(next)
            saveSettings(next)
          }}
          dueWords={dueWords}
          onGenerate={handleStartGenerate}
        />
      )}

      {screen === 'generating' && genConfig && (
        <Generating
          step={genStep}
          config={genConfig}
          wordCount={genWords.length}
          passageCount={Math.max(1, Math.ceil(genWords.length / WORDS_PER_PASSAGE.max))}
          error={genError}
          onRetry={() => void doGenerate(genWords, genConfig)}
          onBack={() => {
            setGenError(null)
            setScreen('setup')
          }}
        />
      )}

      {screen === 'quiz' && activeQuiz && (
        <QuizView
          quiz={activeQuiz}
          answers={answers}
          onAnswersChange={setAnswers}
          onSubmit={handleSubmit}
          submitting={submitting}
          settings={settings}
          elapsedLabel={submittedElapsedSec != null ? formatElapsed(submittedElapsedSec) : null}
          onGoToPool={() => handleNavigate('pool')}
          onRetake={() => handleNavigate('setup')}
        />
      )}

      {screen === 'pool' && <WrongWordPool entries={wrongWords} onClearAll={handleClearPool} />}

      {screen === 'history' && <History quizzes={quizzes} onOpen={handleOpenHistoryQuiz} />}

      {settingsOpen && (
        <SettingsModal settings={settings} onSave={handleSaveSettings} onClose={() => setSettingsOpen(false)} />
      )}

      {toast && <div className="toast">{toast}</div>}
    </>
  )
}
