/**
 * 自动生成 —— 不要手改。
 * 来源：harness/books/*.epub（Standard Ebooks，公有领域 / CC0）。
 * 重新生成：node scripts/prepare-promo-books.mjs
 *
 * 封面图是 harness/promo/covers/<slug>.jpg（书里自带的那一张，压到 400px
 * 宽）。harness 的 Vite 中间件把它们挂在 /__harness/covers/ 下，所以这里只存
 * slug，不存 base64 —— 二进制放二进制的地方，源码里不塞一兆的字符串。
 */

export interface PromoCover {
  title: string;
  author: string;
}

/** slug -> 书里读出来的书名和作者。封面在 coverUrl(slug)。 */
export const PROMO_COVERS: Record<string, PromoCover> = {
  "alices-adventures-in-wonderland": {
    title: "Alice’s Adventures in Wonderland",
    author: "Lewis Carroll",
  },
  "dracula": {
    title: "Dracula",
    author: "Bram Stoker",
  },
  "emma": {
    title: "Emma",
    author: "Jane Austen",
  },
  "heart-of-darkness": {
    title: "Heart of Darkness",
    author: "Joseph Conrad",
  },
  "jane-eyre": {
    title: "Jane Eyre",
    author: "Charlotte Brontë",
  },
  "meditations": {
    title: "Meditations",
    author: "Marcus Aurelius",
  },
  "moby-dick": {
    title: "Moby Dick",
    author: "Herman Melville",
  },
  "pride-and-prejudice": {
    title: "Pride and Prejudice",
    author: "Jane Austen",
  },
  "the-adventures-of-tom-sawyer": {
    title: "The Adventures of Tom Sawyer",
    author: "Mark Twain",
  },
  "the-great-gatsby": {
    title: "The Great Gatsby",
    author: "F. Scott Fitzgerald",
  },
  "the-picture-of-dorian-gray": {
    title: "The Picture of Dorian Gray",
    author: "Oscar Wilde",
  },
  "the-wind-in-the-willows": {
    title: "The Wind in the Willows",
    author: "Kenneth Grahame",
  },
};

export const coverUrl = (slug: string) => `/__harness/covers/${slug}.jpg`;
export const bookUrl = (slug: string) => `/__harness/books/${slug}.epub`;
