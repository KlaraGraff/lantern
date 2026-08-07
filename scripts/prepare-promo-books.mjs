#!/usr/bin/env node
/**
 * 从 harness/books/ 里的公版 EPUB 抽出封面和书目信息，生成
 * harness/promo/covers.generated.ts。
 *
 * 为什么要生成而不是手写：README 的样张是用真实前端跑出来的，书架上那十二本
 * 的封面必须是书里真正带的那一张，不是我描一个色块。EPUB 原文件太大不进仓库
 * （见 harness/books/README.md），但抽出来压好的封面很小，进仓库，这样任何人
 * clone 下来都能重跑截图脚本。
 *
 * 依赖 macOS 自带的 unzip 和 sips —— 不引入新的图像库。
 *
 *   node scripts/prepare-promo-books.mjs
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BOOKS_DIR = join(root, "harness", "books");
const COVER_DIR = join(root, "harness", "promo", "covers");
const OUT_FILE = join(root, "harness", "promo", "covers.generated.ts");

/** 封面导出宽度（书卡最大 ~190 CSS px，截图按 2x 导出）。 */
const COVER_WIDTH = 400;
const JPEG_QUALITY = "68";

/* ------------------------------------------------------------------ *
 * EPUB 解包
 * ------------------------------------------------------------------ */

const unzipText = (epub, entry) =>
  execFileSync("unzip", ["-p", epub, entry], { maxBuffer: 64 << 20 }).toString("utf8");

const unzipBinary = (epub, entry) =>
  execFileSync("unzip", ["-p", epub, entry], { maxBuffer: 64 << 20 });

/** container.xml 指向 OPF；不猜路径。 */
function opfPath(epub) {
  const container = unzipText(epub, "META-INF/container.xml");
  const m = /full-path="([^"]+)"/.exec(container);
  if (!m) throw new Error("container.xml 里没有 rootfile");
  return m[1];
}

const attr = (tag, name) => new RegExp(`${name}="([^"]*)"`).exec(tag)?.[1] ?? null;

/**
 * 找封面图。两种声明方式都要认：EPUB 3 的 `properties="cover-image"`，
 * 和 EPUB 2 的 `<meta name="cover" content="<id>">`。
 */
function coverEntry(opf, opfDir) {
  const items = [...opf.matchAll(/<item\b[^>]*>/g)].map((m) => m[0]);

  let href = items
    .filter((t) => (attr(t, "properties") ?? "").split(/\s+/).includes("cover-image"))
    .map((t) => attr(t, "href"))[0];

  if (!href) {
    const id = /<meta\b[^>]*name="cover"[^>]*content="([^"]+)"/.exec(opf)?.[1];
    if (id) href = items.filter((t) => attr(t, "id") === id).map((t) => attr(t, "href"))[0];
  }
  if (!href) throw new Error("OPF 里找不到封面");
  return posix.normalize(posix.join(opfDir, decodeURIComponent(href)));
}

function meta(opf, tag) {
  const m = new RegExp(`<dc:${tag}\\b[^>]*>([\\s\\S]*?)</dc:${tag}>`).exec(opf);
  if (!m) return null;
  return m[1]
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#8217;|&rsquo;/g, "’")
    .trim();
}

/* ------------------------------------------------------------------ *
 * 压图
 * ------------------------------------------------------------------ */

function shrink(buffer, workDir, name) {
  const src = join(workDir, `${name}-src`);
  const out = join(workDir, `${name}.jpg`);
  writeFileSync(src, buffer);
  execFileSync("sips", [
    "-s", "format", "jpeg",
    "-s", "formatOptions", JPEG_QUALITY,
    "--resampleWidth", String(COVER_WIDTH),
    src, "--out", out,
  ], { stdio: "ignore" });
  return readFileSync(out);
}

/* ------------------------------------------------------------------ *
 * main
 * ------------------------------------------------------------------ */

const epubs = existsSync(BOOKS_DIR)
  ? readdirSync(BOOKS_DIR).filter((f) => f.endsWith(".epub")).sort()
  : [];

if (!epubs.length) {
  console.error(
    `harness/books/ 里没有 .epub。\n先按 harness/books/README.md 下载公版书。`,
  );
  process.exit(1);
}

const work = mkdtempSync(join(tmpdir(), "lantern-covers-"));
const records = [];
let failed = 0;

mkdirSync(COVER_DIR, { recursive: true });

try {
  for (const file of epubs) {
    const slug = basename(file, ".epub");
    const epub = join(BOOKS_DIR, file);
    process.stdout.write(`· ${slug} … `);
    try {
      const opfEntry = opfPath(epub);
      const opf = unzipText(epub, opfEntry);
      const raw = unzipBinary(epub, coverEntry(opf, posix.dirname(opfEntry)));
      const jpeg = shrink(raw, work, slug);
      writeFileSync(join(COVER_DIR, `${slug}.jpg`), jpeg);
      records.push({
        slug,
        title: meta(opf, "title") ?? slug,
        author: meta(opf, "creator") ?? "",
        kb: Math.round(jpeg.length / 1024),
      });
      console.log(`ok  ${Math.round(jpeg.length / 1024)}K`);
    } catch (error) {
      failed++;
      console.log(`失败 — ${error instanceof Error ? error.message : error}`);
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

// 用完就删：上一轮留下的封面如果这一轮没再生成，说明书被移出了 harness/books/，
// 留着只会让下游引用一个不存在的书。
for (const stale of readdirSync(COVER_DIR).filter((f) => f.endsWith(".jpg"))) {
  if (!records.some((r) => `${r.slug}.jpg` === stale)) {
    rmSync(join(COVER_DIR, stale));
    console.log(`· 删除已失效的封面 ${stale}`);
  }
}

mkdirSync(dirname(OUT_FILE), { recursive: true });

const body = records
  .map(
    (r) =>
      `  ${JSON.stringify(r.slug)}: {\n` +
      `    title: ${JSON.stringify(r.title)},\n` +
      `    author: ${JSON.stringify(r.author)},\n` +
      `  },`,
  )
  .join("\n");

writeFileSync(
  OUT_FILE,
  `/**\n` +
    ` * 自动生成 —— 不要手改。\n` +
    ` * 来源：harness/books/*.epub（Standard Ebooks，公有领域 / CC0）。\n` +
    ` * 重新生成：node scripts/prepare-promo-books.mjs\n` +
    ` *\n` +
    ` * 封面图是 harness/promo/covers/<slug>.jpg（书里自带的那一张，压到 ${COVER_WIDTH}px\n` +
    ` * 宽）。harness 的 Vite 中间件把它们挂在 /__harness/covers/ 下，所以这里只存\n` +
    ` * slug，不存 base64 —— 二进制放二进制的地方，源码里不塞一兆的字符串。\n` +
    ` */\n\n` +
    `export interface PromoCover {\n  title: string;\n  author: string;\n}\n\n` +
    `/** slug -> 书里读出来的书名和作者。封面在 coverUrl(slug)。 */\n` +
    `export const PROMO_COVERS: Record<string, PromoCover> = {\n${body}\n};\n\n` +
    `export const coverUrl = (slug: string) => \`/__harness/covers/\${slug}.jpg\`;\n` +
    `export const bookUrl = (slug: string) => \`/__harness/books/\${slug}.epub\`;\n`,
  "utf8",
);

const total = records.reduce((n, r) => n + r.kb, 0);
console.log(
  `\n${records.length} 本 → harness/promo/covers/（合计 ${total}K），` +
    `书目写入 covers.generated.ts` +
    (failed ? `，${failed} 本失败` : ""),
);
process.exit(failed ? 1 : 0);
