import type { Quiz } from '../types'
import { formatDateISO } from './util'

/** 历史试卷列表（样张未覆盖此屏，沿用同一套 token 与表格风格） */
export function History(props: { quizzes: Quiz[]; onOpen: (quiz: Quiz) => void }) {
  const { quizzes, onOpen } = props
  return (
    <div className="app-body">
      <div className="field-label">历史试卷 <small>{quizzes.length} 份</small></div>
      {quizzes.length === 0 ? (
        <div className="empty-state">还没有出过卷，去「出题」生成第一份吧。</div>
      ) : (
        <div className="tablewrap">
          {quizzes.map((q) => (
            <div className="hist-row" key={q.id} onClick={() => onOpen(q)}>
              <span className="date en-serif">{formatDateISO(q.createdAt)}</span>
              <span className="words">{q.words.length} 词 · {q.config.difficulty.toUpperCase()}</span>
              <span className="score">
                {q.status === 'submitted' && q.result ? `${q.result.score} / ${q.result.total}` : '未交卷'}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
