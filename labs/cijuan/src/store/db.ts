import Dexie, { type Table } from 'dexie'
import type { Quiz, WrongWordEntry } from '../types'

/**
 * IndexedDB 数据库：存试卷（quizzes）与错词池（wrongWords）。
 */
export class CijuanDB extends Dexie {
  quizzes!: Table<Quiz, number>
  wrongWords!: Table<WrongWordEntry, number>

  constructor() {
    super('cijuan')
    this.version(1).stores({
      quizzes: '++id, createdAt, status',
      // word 唯一索引：错词池里每个词只有一条记录
      wrongWords: '++id, &word, nextDueAt, cleared',
    })
  }
}

export const db = new CijuanDB()
