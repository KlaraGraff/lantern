/**
 * 样张用的书架。
 *
 * 和 `harness/fixture-data.ts` 分开：那一份是给 smoke 测试用的，刻意挑成
 * 「每个分支都走一遍」（缺文件的书、空封面、PDF），好看不是它的目标。这一份
 * 相反 —— 它要上 README，所以每本都是真书、真封面、真页数。
 *
 * 十二本全部来自 Standard Ebooks（公有领域 / CC0），封面是书里自带的那一张，
 * 由 `scripts/prepare-promo-books.mjs` 抽出。为什么必须是公版：这些图会公开
 * 发布，出版社版本的封面不能用。
 *
 * 「读完 9 本」不是随手填的数 —— 第 6 张图（词汇难度）会说「比你读过的书难」，
 * 那个对照组就是下面 status 为 finished 的九本，数得出来。
 */
import { PROMO_COVERS, bookUrl, coverUrl } from "./covers.generated";
import type { HarnessBook } from "../fixture-data";

const DAY = 86_400_000;
const now = Date.now();
const ago = (days: number) => Math.floor((now - days * DAY) / 1000);

/** 主角书。第 1、2、3、4、6 张图的正文、查词、对话、引用都出自它。 */
export const HERO_BOOK_ID = "pride-and-prejudice";

/** 第 5 张图的掌握度时间线要引用它，所以它得真在书架上。 */
export const SECOND_BOOK_ID = "emma";

interface Shelf {
  slug: string;
  genre: string;
  pages: number;
  status: "reading" | "finished" | "unread";
  progress: number;
  /** 加入书库的天数，决定书架默认排序（最近在前）。 */
  added: number;
  /** 最后一次翻开的天数。 */
  touched: number;
}

/**
 * 顺序就是书架上的顺序（库按 updated_at 倒序排）。在读的排前面，读完的居中，
 * 没开始的垫底 —— 一个真实书库本来就长这样。
 */
const SHELF: Shelf[] = [
  { slug: "pride-and-prejudice",            genre: "Fiction",    pages: 432, status: "reading",  progress: 34, added: 12,  touched: 0 },
  { slug: "emma",                           genre: "Fiction",    pages: 474, status: "reading",  progress: 12, added: 9,   touched: 2 },
  { slug: "heart-of-darkness",              genre: "Fiction",    pages: 124, status: "reading",  progress: 61, added: 24,  touched: 5 },
  { slug: "jane-eyre",                      genre: "Fiction",    pages: 532, status: "finished", progress: 100, added: 96, touched: 8 },
  { slug: "the-great-gatsby",               genre: "Fiction",    pages: 180, status: "finished", progress: 100, added: 78, touched: 14 },
  { slug: "the-picture-of-dorian-gray",     genre: "Fiction",    pages: 254, status: "finished", progress: 100, added: 133, touched: 21 },
  { slug: "dracula",                        genre: "Fiction",    pages: 418, status: "finished", progress: 100, added: 150, touched: 29 },
  { slug: "alices-adventures-in-wonderland", genre: "Fiction",   pages: 192, status: "finished", progress: 100, added: 168, touched: 36 },
  { slug: "the-wind-in-the-willows",        genre: "Fiction",    pages: 256, status: "finished", progress: 100, added: 181, touched: 44 },
  { slug: "the-adventures-of-tom-sawyer",   genre: "Fiction",    pages: 274, status: "finished", progress: 100, added: 205, touched: 52 },
  { slug: "meditations",                    genre: "Philosophy", pages: 254, status: "finished", progress: 100, added: 240, touched: 61 },
  { slug: "moby-dick",                      genre: "Fiction",    pages: 654, status: "finished", progress: 100, added: 268, touched: 79 },
];

function toBook(shelf: Shelf): HarnessBook {
  const meta = PROMO_COVERS[shelf.slug];
  if (!meta) {
    throw new Error(
      `harness/promo: 书架上有 "${shelf.slug}"，但封面里没有。\n` +
        `先把对应的 .epub 放进 harness/books/，再跑 node scripts/prepare-promo-books.mjs。`,
    );
  }
  return {
    id: shelf.slug,
    title: meta.title,
    author: meta.author,
    description: null,
    cover_path: coverUrl(shelf.slug),
    file_path: bookUrl(shelf.slug),
    format: "epub",
    source_format: "epub",
    source_sha256: shelf.slug.padEnd(64, "0").slice(0, 64),
    render_format: "epub",
    preparation_state: "ready",
    preparation_error: null,
    genre: shelf.genre,
    pages: shelf.pages,
    status: shelf.status,
    progress: shelf.progress,
    current_cfi: shelf.progress > 0 ? "epubcfi(/6/8!/4/2/2)" : null,
    created_at: ago(shelf.added),
    updated_at: ago(shelf.touched),
    available: true,
    cover_data: coverUrl(shelf.slug),
  };
}

/** 只保留封面真的抽出来了的书 —— 少下了一两本，书架少一格，不炸。 */
export const PROMO_BOOKS: HarnessBook[] = SHELF.filter(
  (s) => PROMO_COVERS[s.slug],
).map(toBook);

export const PROMO_COLLECTIONS = [
  { id: "col-austen", name: "Austen", book_count: 2, sort_order: 0, created_at: ago(60), updated_at: ago(2) },
  { id: "col-gothic", name: "读到一半的", book_count: 3, sort_order: 1, created_at: ago(40), updated_at: ago(5) },
];
