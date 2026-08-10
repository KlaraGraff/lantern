#!/usr/bin/env node
/**
 * 算出第 7 张样张（「这本书对你」）里的每一个数字。
 *
 * 那张图说的是「本机就能回答这本书对你难不难」，所以图上的数字不能是编的 ——
 * 它们必须是**真的数出来的**。这个脚本就是那次计算：把 `harness/books/` 里
 * 那十二本真的 EPUB 逐本读进来，按端上一模一样的规则分词、分类、求和，把结果
 * 写进 `harness/promo/coverage.generated.ts`，样张的 mock 层直接引用。
 *
 *   node scripts/promo-coverage.mjs                    # 重算并写文件
 *   node scripts/promo-coverage.mjs --dry              # 只打印，不写
 *   node scripts/promo-coverage.mjs --reader=8000,9000 # 换一档读者试算（配 --dry 用）
 *
 * ## 和端上的对应关系
 *
 * | 这里 | 端上 |
 * | --- | --- |
 * | `blockText()` | `src-tauri/src/ai/grounding/extract.rs::extract_epub`（同一组块级标签） |
 * | `tokenize()`  | `book_difficulty.rs::tokenize_cased`（同样的小写化、撇号处理、单字符丢弃） |
 * | `classify()`  | `coverage.rs::classify`（掌握 → 人名 → 眼熟 → 还不认识，同样的顺序） |
 * | 频率表 | `src-tauri/src/word_frequency/english-fiction.tsv`，同一个文件 |
 *
 * ## 唯一需要假设的东西：这位读者认识哪些词
 *
 * 书那一侧全是事实（总词次、词形数、哪些词全书没小写过）。读者那一侧不是 ——
 * 样张读者是虚构的，他的已掌握词表得先定下来。定法写在下面 `READER` 里，一句
 * 话：**频率表前 8 000 名算「读顺了」，8 001–9 000 名算「眼熟」**，再加上生词本
 * 里那几个已经到「眼熟 / 读顺了」的词。
 *
 * 这条假设是明写的，不是藏起来的；除它之外，图上没有一个数字是手填的。
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** 主角书：整张图（覆盖率、词次构成、还不认识那一列）说的都是它。 */
const HERO = "pride-and-prejudice";
const BOOKS_DIR = resolve(root, "harness/books");
const TSV = resolve(root, "src-tauri/src/word_frequency/english-fiction.tsv");
const OUT = resolve(root, "harness/promo/coverage.generated.ts");
/**
 * 书架上读完的九本 —— 覆盖率的对照组就是它们，`baselineBooks` 数的是这个。
 * 名单跟着 `harness/promo/library.ts` 里 status 为 finished 的那几行走；
 * 那边改了书架，这里要跟着改，否则「读过 9 本」和书架上数得出来的对不上。
 */
const FINISHED = [
  "jane-eyre",
  "the-great-gatsby",
  "the-picture-of-dorian-gray",
  "dracula",
  "alices-adventures-in-wonderland",
  "the-wind-in-the-willows",
  "the-adventures-of-tom-sawyer",
  "meditations",
  "moby-dick",
];
/** 在读的三本和读到哪儿了，同样抄自 `library.ts`。 */
const READING = { "pride-and-prejudice": 0.34, emma: 0.12, "heart-of-darkness": 0.61 };

/**
 * 样张读者。
 *
 * 8 000 / 9 000 这两个门槛挑出来的是**一个还在学的人**：读得下 Austen，但每
 * 两页会撞上一个不认识的词。往上调到 12 000，覆盖率涨到 97%，图倒是好看了，
 * 可那样的读者根本不需要这个软件 —— 图会变成一句空话。
 */
const READER = {
  masteredRank: 8_000,
  familiarRank: 9_000,
  /** 生词本里已经到「眼熟 / 读顺了」的词，端上也算进已掌握集合。 */
  savedKnown: ["tolerable", "waited", "discretion"],
  /** 生词本里还没到的词，连同查过几次 —— 它们会出现在「还不认识」里。 */
  savedUnknown: { deigned: 2, circumspection: 3, bestow: 1 },
};

const readerArg = process.argv.find((arg) => arg.startsWith("--reader="));
if (readerArg) {
  const [mastered, familiar] = readerArg.slice(9).split(",").map(Number);
  READER.masteredRank = mastered;
  READER.familiarRank = familiar || mastered + 1000;
}

/**
 * 这本书的人名地名。
 *
 * 端上这一份来自 `book_person_aliases`（migration 059），由应用自己的名字识别
 * 跑出来；`load_alias_names` 只取其中大写开头的词。这里手抄一份等价的，因为
 * harness 不跑那一趟。规则本身没变：**人名不算「你还没学会的词」**——把伊丽莎白
 * 的姓氏列进生词表，是对读者的冒犯。
 */
const ALIASES = [
  "Elizabeth", "Lizzy", "Eliza", "Jane", "Mary", "Catherine", "Kitty", "Lydia",
  "Bennet", "Darcy", "Fitzwilliam", "Bingley", "Caroline", "Louisa", "Hurst",
  "Georgiana", "Wickham", "Collins", "William", "Lucas", "Charlotte", "Maria",
  "Gardiner", "Philips", "Forster", "Denny", "Chamberlayne", "Pratt", "Younge",
  "Reynolds", "Hill", "Sarah", "Nicholls", "Annesley", "Metcalfe", "Long",
  "Goulding", "King", "Watson", "Harrington", "Pope", "Webbs", "Robinson",
  "Jones", "Stone", "Haggerston", "Morris", "Anne", "Bourgh", "Rosings",
  "Hunsford", "Longbourn", "Netherfield", "Pemberley", "Meryton", "Lambton",
  "Brighton", "Ramsgate", "Gracechurch", "Cheapside", "Hertfordshire",
  "Derbyshire", "Kent", "London", "Lakes", "Matlock", "Dovedale", "Chatsworth",
  "Blenheim", "Warwick", "Kenilworth", "Birmingham", "Newcastle", "Epsom",
  "Clapham", "Barnet", "Hatfield", "Scotland", "Gretna", "Green", "Grosvenor",
  "James", "Michaelmas", "Christmas", "Easter", "Lucases", "Bennets",
  "Bingleys", "Gardiners", "Collinses", "Philipses", "Forsters", "Darcys",
];

/* ------------------------------------------------------------------ *
 * EPUB → 正文
 * ------------------------------------------------------------------ */

const unzip = (epub, entry) =>
  execFileSync("unzip", ["-p", epub, entry], { maxBuffer: 128 << 20 }).toString("utf8");

/** OPF 里 spine 的顺序，就是端上 `doc.spine` 走的顺序。 */
function spineHrefs(epub) {
  const container = unzip(epub, "META-INF/container.xml");
  const opfPath = /full-path="([^"]+)"/.exec(container)?.[1];
  if (!opfPath) throw new Error("container.xml 里没有 full-path");
  const opf = unzip(epub, opfPath);
  const base = opfPath.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/") + 1) : "";
  const manifest = new Map();
  for (const tag of opf.matchAll(/<item\b[^>]*>/g)) {
    const id = /id="([^"]+)"/.exec(tag[0])?.[1];
    const href = /href="([^"]+)"/.exec(tag[0])?.[1];
    if (id && href) manifest.set(id, base + decodeURIComponent(href));
  }
  return [...opf.matchAll(/<itemref\b[^>]*idref="([^"]+)"/g)]
    .map((m) => manifest.get(m[1]))
    .filter(Boolean);
}

/** 端上取正文用的那组块级标签。 */
const BLOCKS = new Set([
  "p", "h1", "h2", "h3", "h4", "h5", "h6", "li", "blockquote",
  "dd", "dt", "td", "th", "figcaption", "pre",
]);

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”" };

const decode = (text) =>
  text
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (whole, name) => ENTITIES[name.toLowerCase()] ?? whole);

/**
 * 一个 XHTML 文件里所有块级元素的文字。
 *
 * 嵌套的算两遍（`<blockquote><p>` 里的话既进 blockquote 又进 p）—— 这不是
 * 疏漏，端上的 `Html::select` 就是这么返回的，这里要的是同一个数。
 */
function blockText(xhtml) {
  const source = xhtml.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ");
  const open = []; // 当前打开着的、我们关心的元素，各自攒各自的文字
  const out = [];
  let at = 0;
  for (const tag of source.matchAll(/<\/?([a-zA-Z][\w:-]*)[^>]*?(\/?)>/g)) {
    const text = source.slice(at, tag.index);
    at = tag.index + tag[0].length;
    if (text) for (const buffer of open) buffer.text += text;
    const name = tag[1].toLowerCase();
    if (!BLOCKS.has(name)) continue;
    const closing = tag[0].startsWith("</");
    const selfClosing = tag[2] === "/";
    if (closing) {
      // 找到最近的同名元素收掉；标签不配对的文件不至于把后面全吃了。
      for (let i = open.length - 1; i >= 0; i -= 1) {
        if (open[i].name !== name) continue;
        out.push(...open.splice(i).map((buffer) => buffer.text));
        break;
      }
    } else if (!selfClosing) {
      open.push({ name, text: "" });
    }
  }
  out.push(...open.map((buffer) => buffer.text));
  return out.map((text) => decode(text).replace(/\s+/g, " ").trim()).filter(Boolean);
}

/* ------------------------------------------------------------------ *
 * 分词：book_difficulty.rs::tokenize_cased 的等价实现
 * ------------------------------------------------------------------ */

function tokenize(text, tally) {
  let current = "";
  let capital = false;
  let started = false;
  const flush = () => {
    const token = current.replace(/^'+|'+$/g, "");
    if ([...token].length > 1 && !/^[0-9]+$/u.test(token)) {
      const entry = tally.get(token) ?? { tokens: 0, capitalized: 0 };
      entry.tokens += 1;
      if (capital) entry.capitalized += 1;
      tally.set(token, entry);
    }
    current = "";
    capital = false;
    started = false;
  };
  for (const character of text) {
    if (/[\p{L}\p{N}]/u.test(character)) {
      if (!started) {
        capital = character.toLowerCase() !== character;
        started = true;
      }
      current += character.toLowerCase();
    } else if (character === "'" || character === "’") {
      current += "'";
    } else {
      flush();
    }
  }
  flush();
}

/* ------------------------------------------------------------------ *
 * 数
 * ------------------------------------------------------------------ */

const ranks = (() => {
  const table = new Map();
  for (const line of readFileSync(TSV, "utf8").split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const [word, rank] = line.split("\t");
    if (word && rank) table.set(word, Number(rank));
  }
  // `parse_table` 里的 CORRECTIONS：上游把 "cannot" 切成了 "can not"，那一行
  // 记的是残渣（31 132）。被切开的复合词不比它任何一部分难，所以取组成部分里
  // 较难的那个名次。
  for (const [word, parts] of [["cannot", ["can", "not"]]]) {
    const partRanks = parts.map((part) => table.get(part));
    if (partRanks.every((rank) => rank !== undefined)) {
      table.set(word, Math.max(...partRanks));
    }
  }
  return table;
})();

/**
 * `lookup_with` 的查表那一段：精确匹配，外加 `'s` / `s'` 结尾时取词干的名次，
 * 两者里名次更小（更常见）的赢。全表只有 15 个带 `'s` 的词条、全部排在
 * 17 000 名开外，那不是真词频，是上游分词切走 `'s` 之后剩的残渣。
 * 这里只认直撇号 —— `tokenize()` 已经把弯撇号统一过了。
 */
function rankOf(word) {
  const exact = ranks.get(word);
  const stem = possessiveStem(word);
  const stemRank = stem === null ? undefined : ranks.get(stem);
  if (exact === undefined) return stemRank;
  if (stemRank === undefined) return exact;
  return Math.min(exact, stemRank);
}

function possessiveStem(word) {
  if (word.endsWith("'")) {
    const stem = word.slice(0, -1);
    return stem.endsWith("s") && stem.length > 1 ? stem : null;
  }
  if (word.endsWith("'s")) {
    const stem = word.slice(0, -2);
    return stem.length > 0 ? stem : null;
  }
  return null;
}

const known = new Set(READER.savedKnown);
/** 人名表只有主角书有；别的书靠「表里没有 + 全书没小写过」那条规则认名字。 */
const namesFor = (bookId) =>
  bookId === HERO ? new Set(ALIASES.map((name) => name.toLowerCase())) : new Set();

/** 一本书的四类词次。分类顺序照抄 `coverage.rs::classify`。 */
function measure(bookId) {
  const epub = resolve(BOOKS_DIR, `${bookId}.epub`);
  const tally = new Map();
  let sections = 0;
  for (const href of spineHrefs(epub)) {
    const blocks = blockText(unzip(epub, href));
    if (!blocks.length) continue;
    sections += 1;
    for (const block of blocks) tokenize(block, tally);
  }

  const names = namesFor(bookId);
  const row = {
    bookId,
    sections,
    totalTokens: 0,
    distinctWords: tally.size,
    masteredTokens: 0,
    familiarTokens: 0,
    nameTokens: 0,
    unknownTokens: 0,
    nameWords: 0,
    unknownWords: 0,
    unknown: [],
  };
  for (const [word, entry] of tally) {
    row.totalTokens += entry.tokens;
    const rank = rankOf(word);
    const listed = rank !== undefined;
    if (known.has(word) || (listed && rank <= READER.masteredRank)) {
      row.masteredTokens += entry.tokens;
    } else if (names.has(word) || (!listed && entry.capitalized === entry.tokens)) {
      row.nameTokens += entry.tokens;
      row.nameWords += 1;
    } else if (listed && rank <= READER.familiarRank && !(word in READER.savedUnknown)) {
      row.familiarTokens += entry.tokens;
    } else {
      row.unknownTokens += entry.tokens;
      row.unknownWords += 1;
      row.unknown.push({ word, tokens: entry.tokens, rank: rank ?? null });
    }
  }
  // 次数多的在前，同次数按字母 —— 端上 `load_unknown_words` 的排法。
  row.unknown.sort((a, b) => b.tokens - a.tokens || a.word.localeCompare(b.word));
  row.forms = new Set(tally.keys());
  return row;
}

const shelf = readdirSync(BOOKS_DIR)
  .filter((file) => file.endsWith(".epub"))
  .map((file) => file.slice(0, -5))
  .sort((a, b) => (a === HERO ? -1 : b === HERO ? 1 : a.localeCompare(b)))
  .map(measure);

const hero = shelf.find((row) => row.bookId === HERO);
if (!hero) throw new Error(`harness/books/ 里没有 ${HERO}.epub`);

/**
 * 这位读者到今天为止「读过的量」，也就是词汇画像里那两个数。
 *
 * 词次算读完的九本，加上在读那三本按进度折算的部分。词形只数读完的九本 ——
 * 一本读到 34% 的书里已经出现过哪些词形，这里数不出来，就不算进去。
 */
const exposure = {
  tokens: Math.round(
    shelf.reduce(
      (sum, row) =>
        sum +
        (FINISHED.includes(row.bookId) ? row.totalTokens : row.totalTokens * (READING[row.bookId] ?? 0)),
      0,
    ),
  ),
  words: new Set(shelf.filter((row) => FINISHED.includes(row.bookId)).flatMap((row) => [...row.forms])).size,
};

const percent = (part, whole) => `${((part / whole) * 100).toFixed(1)}%`;

console.table(
  shelf.map((row) => ({
    书: row.bookId,
    总词次: row.totalTokens,
    词形: row.distinctWords,
    读顺了: percent(row.masteredTokens, row.totalTokens),
    "覆盖率（含眼熟）": percent(
      row.masteredTokens + row.nameTokens + row.familiarTokens,
      row.totalTokens,
    ),
    还不认识词形: row.unknownWords,
  })),
);
const familiarShare = hero.familiarTokens / hero.totalTokens;
console.log(
  `\n${HERO}：${percent(hero.masteredTokens + hero.nameTokens, hero.totalTokens)}–` +
    `${percent(hero.masteredTokens + hero.nameTokens + hero.familiarTokens, hero.totalTokens)}，` +
    `眼熟占全书 ${(familiarShare * 100).toFixed(2)}%` +
    `（≤1% 才画成一个点，现在${familiarShare <= 0.01 ? "画点" : "会画成区间"}）\n`,
);
console.log("出现最多的「还不认识」：");
console.table(hero.unknown.slice(0, 24));

if (process.argv.includes("--dry")) process.exit(0);

const coverageRow = (row) =>
  [
    "  {",
    `    bookId: ${JSON.stringify(row.bookId)},`,
    `    totalTokens: ${row.totalTokens},`,
    `    distinctWords: ${row.distinctWords},`,
    `    masteredTokens: ${row.masteredTokens},`,
    `    familiarTokens: ${row.familiarTokens},`,
    `    nameTokens: ${row.nameTokens},`,
    `    unknownTokens: ${row.unknownTokens},`,
    `    nameWords: ${row.nameWords},`,
    `    unknownWords: ${row.unknownWords},`,
    "  },",
  ].join("\n");

const lines = [
  "/**",
  " * 由 `node scripts/promo-coverage.mjs` 生成，不要手改。",
  " *",
  " * 第 7 张样张（「这本书对你」）里的每一个数字，都数自 `harness/books/` 下那十二本",
  " * 真 EPUB，用的是端上同一套分词和分类规则。要换读者的假设或重新数，改脚本再跑一次。",
  " */",
  "",
  "/**",
  " * 这份数字背后唯一的假设：样张读者认识哪些词。",
  ` * 频率表前 ${READER.masteredRank.toLocaleString("en-US")} 名算「读顺了」，往后到第 ${READER.familiarRank.toLocaleString("en-US")} 名算「眼熟」。`,
  " */",
  "export const PROMO_COVERAGE_READER = {",
  `  masteredRank: ${READER.masteredRank},`,
  `  familiarRank: ${READER.familiarRank},`,
  `  savedKnown: [${READER.savedKnown.map((word) => JSON.stringify(word)).join(", ")}],`,
  "  savedUnknown: { " +
    Object.entries(READER.savedUnknown).map(([word, lookups]) => `${word}: ${lookups}`).join(", ") +
    " },",
  "} as const;",
  "",
  "/** 书架上读完的九本 —— 覆盖率的对照组，`baselineBooks` 数的就是它。 */",
  `export const PROMO_BASELINE_BOOKS = ${FINISHED.length};`,
  "",
  "/**",
  " * 词汇画像里的「读过的量」：词次含在读那三本按进度折算的部分，词形只数读完的九本。",
  " */",
  `export const PROMO_EXPOSURE = { tokens: ${exposure.tokens}, words: ${exposure.words} } as const;`,
  "",
  "/** 每本书的四类词次（`BookReaderCoverage` 的字段名）。主角书排第一。 */",
  "export const PROMO_COVERAGE_ROWS = [",
  ...shelf.map(coverageRow),
  "] as const;",
  "",
  "/**",
  " * 主角书里读者还不认识的词，次数多的在前 —— 端上 `load_unknown_words` 的排法。",
  " * 只留前 60 个：界面按 40 次 / 5 次分组，尾巴那一堆只会露出几个词的预览。",
  " */",
  "export const PROMO_UNKNOWN_WORDS = [",
  ...hero.unknown.slice(0, 60).map((entry) =>
    `  { word: ${JSON.stringify(entry.word)}, tokens: ${entry.tokens}, rank: ${entry.rank ?? "null"} },`),
  "] as const;",
  "",
];
writeFileSync(OUT, lines.join("\n"));
console.log(`\n写入 ${OUT.replace(root + "/", "")}`);
