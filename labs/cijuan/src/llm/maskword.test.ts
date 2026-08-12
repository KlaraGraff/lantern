import { describe, expect, it } from 'vitest'
import { maskWord, wordForms } from './prompts'

// 这些用例来自审查实测出的漏遮/误遮反例，回归护栏
describe('maskWord', () => {
  it('遮住去 e 加 ing 的形态（allocate → allocating）', () => {
    expect(maskWord('They are allocating funds; half is allocated.', 'allocate')).toBe(
      'They are ████ funds; half is ████.',
    )
  })

  it('遮住辅音+y 变形（vary → varies / varied）', () => {
    expect(maskWord('Results vary; the outcome varies and has varied.', 'vary')).toBe(
      'Results ████; the outcome ████ and has ████.',
    )
  })

  it('不误遮形近但无关的词（art 不遮 article / artist）', () => {
    expect(maskWord('The article by the artist explores art.', 'art')).toBe(
      'The article by the artist explores ████.',
    )
  })

  it('不误遮共享前缀的词（run 不遮 runway / rural）', () => {
    expect(maskWord('They run a rural runway.', 'run')).toBe('They ████ a rural runway.')
  })

  it('遮双写尾字母形态（run → running）', () => {
    expect(maskWord('He keeps running daily.', 'run')).toBe('He keeps ████ daily.')
  })

  it('大小写不敏感', () => {
    expect(maskWord('Subsidy matters. The subsidies grew.', 'subsidy')).toBe(
      '████ matters. The ████ grew.',
    )
  })
})

describe('wordForms', () => {
  it('包含原形与常见屈折', () => {
    const forms = wordForms('allocate')
    expect(forms).toContain('allocate')
    expect(forms).toContain('allocated')
    expect(forms).toContain('allocating')
    expect(forms).toContain('allocates')
  })

  it('词组：首词屈折（动词短语）与尾词屈折（名词短语）都覆盖', () => {
    const phrasal = wordForms('take over')
    expect(phrasal).toContain('take over')
    expect(phrasal).toContain('takes over')
    expect(phrasal).toContain('taking over')
    const noun = wordForms('climate change')
    expect(noun).toContain('climate changes')
  })
})

describe('maskWord · 词组', () => {
  it('整体遮住词组及其屈折，不遮成员单词单独出现', () => {
    expect(maskWord('He takes over the firm; we take a break.', 'take over')).toBe(
      'He ████ the firm; we take a break.',
    )
  })

  it('遮住固定搭配（in particular）', () => {
    expect(maskWord('Cities, in particular, suffer most.', 'in particular')).toBe(
      'Cities, ████, suffer most.',
    )
  })
})
