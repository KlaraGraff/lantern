import { useMemo, useState } from 'react'
import type { AppSettings, Difficulty, QuestionType, QuizConfig, QuizWord, WrongWordEntry } from '../types'
import { WORDS_PER_PASSAGE } from '../types'
import { parseWordInput, isWeakWord, estimateCostCNY, formatCost, presetFor, profileReady } from '../llm'
import { DIFFICULTY_LABELS } from './util'

const WORD_WARN = 40
const WORD_MAX = 60

const DIFFICULTY_OPTS: { id: Difficulty; label: string }[] = (
  Object.keys(DIFFICULTY_LABELS) as Difficulty[]
).map((id) => ({ id, label: DIFFICULTY_LABELS[id] }))

/** 屏 1：出题设置 —— 粘贴单词、选难度与题型 */
export function Setup(props: {
  settings: AppSettings
  onSettingsChange: (next: AppSettings) => void
  dueWords: WrongWordEntry[]
  onGenerate: (words: QuizWord[], config: QuizConfig) => void
}) {
  const { settings, onSettingsChange, dueWords, onGenerate } = props
  const [rawText, setRawText] = useState('')

  const parsed = useMemo(() => parseWordInput(rawText), [rawText])
  // 虚词（the/of 这类）无法按「不认识就答不出」出题：自动忽略，但在界面明示，不悄悄吞掉
  const todayWords = useMemo(() => parsed.filter((w) => !isWeakWord(w)), [parsed])
  const weakWords = useMemo(() => parsed.filter(isWeakWord), [parsed])
  // 粘贴词与到期重现词跨集合去重（大小写不敏感）：粘贴里已有的词不再作为重现词重复注入
  const dedupedDueWords = useMemo(() => {
    const pasted = new Set(todayWords.map((w) => w.toLowerCase()))
    return dueWords.filter((w) => !pasted.has(w.word.toLowerCase()))
  }, [dueWords, todayWords])
  const totalCount = todayWords.length + dedupedDueWords.length
  const passageCount = totalCount === 0 ? 0 : Math.ceil(totalCount / WORDS_PER_PASSAGE.max)

  const readingOn = settings.types.includes('reading')
  const grammarOn = settings.types.includes('grammarFill')

  function toggleType(t: QuestionType) {
    const on = settings.types.includes(t)
    const next = on ? settings.types.filter((x) => x !== t) : [...settings.types, t]
    if (next.length === 0) return // 至少保留一种题型
    onSettingsChange({ ...settings, types: next })
  }

  const cost = estimateCostCNY(settings.profile.model, totalCount, settings.maskedCheck)
  const canGenerate = totalCount > 0 && totalCount <= WORD_MAX

  function handleGenerate() {
    if (!canGenerate) return
    const words: QuizWord[] = [
      ...todayWords.map((word) => ({ word, origin: 'today' as const })),
      ...dedupedDueWords.map((w) => ({ word: w.word, origin: 'recur' as const })),
    ]
    const config: QuizConfig = {
      difficulty: settings.difficulty,
      types: settings.types,
      materialSource: 'ai-original',
      model: settings.profile.model,
      maskedCheck: settings.maskedCheck,
    }
    onGenerate(words, config)
  }

  const showNoKeyHint = !settings.demoMode && !profileReady(settings.profile)
  const usagePage = presetFor(settings.profile.provider).usagePage

  return (
    <div className="app-body">
      <div className="grid-2">
        <div>
          <div className="field-label">
            今日单词
            {totalCount > 0 && (
              <small>
                已识别 {totalCount} 个
                {dedupedDueWords.length > 0 ? `（含 ${dedupedDueWords.length} 个重现词）` : ''} · 将分成{' '}
                {passageCount} 篇阅读
              </small>
            )}
          </div>
          <div className={`wordbox ${totalCount === 0 ? 'empty' : ''}`}>
            <textarea
              value={rawText}
              onChange={(e) => setRawText(e.target.value)}
              placeholder={'粘贴今天背完的单词，一行一个或用逗号分隔\n词组（in particular）算一个词，行首序号会自动去掉'}
            />
            {totalCount > 0 && (
              <div className="chips" style={{ padding: '0 16px 14px' }}>
                {todayWords.map((w) => (
                  <span className="chip" key={w}>
                    {w}
                  </span>
                ))}
                {dedupedDueWords.map((w) => (
                  <span className="chip recur" key={w.word}>
                    {w.word}
                  </span>
                ))}
              </div>
            )}
          </div>
          {weakWords.length > 0 && (
            <div className="banner">
              <span className="tag">已忽略</span>
              <span>
                {weakWords.length} 个虚词出不了考点题，已自动忽略：<b className="en-serif">{weakWords.join('、')}</b>
              </span>
            </div>
          )}
          {dedupedDueWords.length > 0 && (
            <div className="banner">
              <span className="tag">重现</span>
              <span>
                错词池有 <b>{dedupedDueWords.length} 个词</b>到期，已混入本卷（虚线词签）。它们会被当成普通考点出题，不会被标出来。
              </span>
            </div>
          )}
          {showNoKeyHint && (
            <div className="banner">
              <span className="tag">提示</span>
              <span>未检测到 API key，出题会使用演示模式的内置样卷。可在右上角设置里填写 key，或直接开启演示模式。</span>
            </div>
          )}
        </div>

        <div>
          <div className="field-label">难度与风格</div>
          <div className="seg">
            {DIFFICULTY_OPTS.map((d) => (
              <button
                key={d.id}
                className={settings.difficulty === d.id ? 'on' : ''}
                onClick={() => onSettingsChange({ ...settings, difficulty: d.id })}
              >
                {d.label}
              </button>
            ))}
          </div>

          <div style={{ marginTop: 22 }}>
            <div className="field-label">
              出题素材 <small>真题相关为二期规划，位置先占上</small>
            </div>
            <div className="seg">
              <button className="on">AI 原创</button>
              <button disabled>真题改编 · 二期</button>
              <button disabled>真题检索 · 二期</button>
            </div>
          </div>
        </div>
      </div>

      <div style={{ marginTop: 26 }}>
        <div className="field-label">
          题型 <small>默认阅读 + 语法为主，可开关</small>
        </div>
        <div className="opt-row">
          <span>
            阅读理解 <span className="sub">每篇 1 短文 + 4~5 道选择题</span>
          </span>
          <button
            className={`switch ${readingOn ? '' : 'off'}`}
            aria-pressed={readingOn}
            aria-label="阅读理解"
            onClick={() => toggleType('reading')}
          />
        </div>
        <div className="opt-row">
          <span>
            语法填空 <span className="sub">给词变形填空，考语法 + 词性</span>
          </span>
          <button
            className={`switch ${grammarOn ? '' : 'off'}`}
            aria-pressed={grammarOn}
            aria-label="语法填空"
            onClick={() => toggleType('grammarFill')}
          />
        </div>
        <div className="opt-row">
          <span>
            选词填空 <span className="sub">词库挖空短文，四六级选词题型 · 二期</span>
          </span>
          <button className="switch off" disabled aria-label="选词填空（二期）" />
        </div>
      </div>

      <div className="cta-row">
        <button className="btn btn-primary" disabled={!canGenerate} onClick={handleGenerate}>
          生成今日试卷
        </button>
        <span className="meta">
          预计 1~2 分钟 ·{' '}
          {cost === null ? (
            <>
              费用以服务商账单为准
              {usagePage && (
                <a href={usagePage} target="_blank" rel="noreferrer" style={{ marginLeft: 6 }}>
                  查看用量 ↗
                </a>
              )}
            </>
          ) : (
            `本次 ${formatCost(cost)}`
          )}
        </span>
      </div>
      {totalCount > WORD_WARN && (
        <div className="banner" style={{ marginTop: 12 }}>
          <span className="tag">提示</span>
          <span>
            {totalCount > WORD_MAX
              ? `超过 ${WORD_MAX} 个词，已停用生成——请删掉一部分，分成两卷`
              : '词太多，生成慢且贵，建议分两卷'}
          </span>
        </div>
      )}
    </div>
  )
}
