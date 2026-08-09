import { cjkFonts } from "./reader-settings";

/**
 * 中文字体下拉的选项。
 *
 * 字体链本身由 `reader-settings.ts` 的 `cjkFonts` 定义（那里管的是 CSS
 * family 串和 `unicode-range` 隔离）；这里只管它在界面上叫什么。分开是因为
 * 字体链没有语言之分，标签有——`system` 在中文界面叫「系统宋体」，在英文
 * 界面叫 System Serif，而 family 串两边一模一样。
 *
 * 标签按 id 查 i18n key，查不到就退回 `cjkFonts` 自带的英文 label。这样
 * 以后往 `cjkFonts` 里加一款字体，界面立刻能选，只是暂时显示英文名，而不是
 * 崩掉或者显示一个空行。
 */
export function getReaderCjkFontOptions(
  t: (key: string, options?: Record<string, unknown>) => string,
): { value: string; label: string }[] {
  return cjkFonts.map((font) => {
    const key = `readerSettings.cjkFontNames.${font.id}`;
    const translated = t(key);
    return { value: font.id, label: translated === key ? font.label : translated };
  });
}
