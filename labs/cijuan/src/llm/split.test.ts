import { describe, expect, it } from 'vitest'
import type { QuizWord } from '../types'
import { isWeakWord, parseWordInput, splitWords } from './split'

function makeWords(n: number): QuizWord[] {
  return Array.from({ length: n }, (_, i) => ({ word: `w${i}`, origin: 'today' as const }))
}

describe('splitWords', () => {
  it.each([
    [8, [8]],
    [12, [12]],
    [13, [7, 6]],
    [16, [8, 8]],
    [24, [12, 12]],
    [25, [9, 8, 8]],
  ])('把 %i 个词分成组大小 %j', (n, expectedSizes) => {
    const groups = splitWords(makeWords(n))
    expect(groups.map((g) => g.length)).toEqual(expectedSizes)
    expect(groups.flat()).toHaveLength(n)
  })

  it('每组不超过上限 12', () => {
    for (const n of [8, 12, 13, 16, 24, 25]) {
      const groups = splitWords(makeWords(n))
      for (const g of groups) expect(g.length).toBeLessThanOrEqual(12)
    }
  })

  it('空输入返回空数组', () => {
    expect(splitWords([])).toEqual([])
  })
})

describe('parseWordInput', () => {
  it('按换行/逗号/顿号/分号（含中英文标点）切分，空格不是分隔符', () => {
    const raw = 'apple, banana、cherry；date\nelder，grape;honey'
    expect(parseWordInput(raw)).toEqual([
      'apple',
      'banana',
      'cherry',
      'date',
      'elder',
      'grape',
      'honey',
    ])
  })

  it('词组不被空格拆散（in particular / take over）', () => {
    expect(parseWordInput('in particular\ntake over, look forward to')).toEqual([
      'in particular',
      'take over',
      'look forward to',
    ])
  })

  it('词组内多余空格压成一个，去重时也视为同一项', () => {
    expect(parseWordInput('in  particular, in particular')).toEqual(['in particular'])
  })

  it('剥掉行首序号与项目符号（2. / (3) / -），纯数字碎片丢弃', () => {
    expect(parseWordInput('1. subsidy\n2. particular\n(3) curb\n- allocate\n4、mitigate')).toEqual([
      'subsidy',
      'particular',
      'curb',
      'allocate',
      'mitigate',
    ])
  })

  it('序号剥离不误伤以数字开头的词（2nd）与序号后的词组', () => {
    expect(parseWordInput('2nd\n3. in particular')).toEqual(['2nd', 'in particular'])
  })

  it('大小写不敏感去重，保留首次出现的写法', () => {
    expect(parseWordInput('Apple, apple, APPLE, banana')).toEqual(['Apple', 'banana'])
  })

  it('去空白、丢弃空片段', () => {
    expect(parseWordInput('  foo ,, bar   ')).toEqual(['foo', 'bar'])
  })
})

describe('isWeakWord', () => {
  it('识别单独出现的功能词（the / of / is）', () => {
    expect(isWeakWord('the')).toBe(true)
    expect(isWeakWord('OF')).toBe(true)
    expect(isWeakWord('is')).toBe(true)
  })

  it('实义词与词组不受影响（in particular 里的 in 不算）', () => {
    expect(isWeakWord('subsidy')).toBe(false)
    expect(isWeakWord('in particular')).toBe(false)
    expect(isWeakWord('take over')).toBe(false)
  })
})
