import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { transform } from "esbuild";
import postcss from "postcss";

export const SAFARI_15_TARGET = "safari15";
export const READER_TRANSFORM_MANIFEST = "foliate-js/reader-safari15-manifest.json";

const JS_TRANSFORM_OPTIONS = {
  charset: "utf8",
  format: "esm",
  legalComments: "inline",
  loader: "js",
  target: SAFARI_15_TARGET,
};

const CSS_TRANSFORM_OPTIONS = {
  charset: "utf8",
  legalComments: "inline",
  loader: "css",
  minify: true,
  target: SAFARI_15_TARGET,
};

const MODERN_CSS_COLOR = /\b(?:oklch|oklab|lab|lch|color-mix)\(/iu;
const PDF_ANNOTATION_HAS_SELECTOR =
  "section:has(div.annotationContent) canvas.annotationContent";
const PDF_ANNOTATION_FALLBACK_SELECTOR =
  "section div.annotationContent ~ canvas.annotationContent";

const LEGACY_UNIT_REPLACEMENTS = [
  [/(-?(?:\d+(?:\.\d+)?|\.\d+))dvh\b/giu, "$1vh"],
  [/(-?(?:\d+(?:\.\d+)?|\.\d+))svh\b/giu, "$1vh"],
  [/(-?(?:\d+(?:\.\d+)?|\.\d+))lvh\b/giu, "$1vh"],
  [/(-?(?:\d+(?:\.\d+)?|\.\d+))dvw\b/giu, "$1vw"],
  [/(-?(?:\d+(?:\.\d+)?|\.\d+))svw\b/giu, "$1vw"],
  [/(-?(?:\d+(?:\.\d+)?|\.\d+))lvw\b/giu, "$1vw"],
  [/(-?(?:\d+(?:\.\d+)?|\.\d+))rlh\b/giu, "$1rem"],
  [/(-?(?:\d+(?:\.\d+)?|\.\d+))lh\b/giu, "$1em"],
];

const normalizePath = (path) => path.split(sep).join("/");

export const listFiles = async (root, predicate = () => true) => {
  const files = [];

  const visit = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && predicate(path)) files.push(path);
    }
  };

  await visit(root);
  return files;
};

export const transformJavaScriptForSafari15 = async (source, sourcefile) => {
  const result = await transform(source, {
    ...JS_TRANSFORM_OPTIONS,
    sourcefile,
  });
  return result.code;
};

const layerDepth = (atRule) => {
  let depth = 0;
  for (let parent = atRule.parent; parent; parent = parent.parent) depth += 1;
  return depth;
};

const replaceLegacyUnits = (value) =>
  LEGACY_UNIT_REPLACEMENTS.reduce(
    (result, [pattern, replacement]) => result.replace(pattern, replacement),
    value,
  );

const hasPreviousDeclaration = (declaration, property, value) => {
  for (let node = declaration.prev(); node; node = node.prev()) {
    if (node.type === "decl" && node.prop === property && node.value === value) {
      return true;
    }
  }
  return false;
};

const convertCustomColor = async (value, sourcefile) => {
  const result = await transform(`.__safari15_color{color:${value}}`, {
    ...CSS_TRANSFORM_OPTIONS,
    sourcefile,
  });
  const root = postcss.parse(result.code, { from: sourcefile });
  let converted;
  root.walkDecls("color", (declaration) => {
    if (!converted && !MODERN_CSS_COLOR.test(declaration.value)) {
      converted = declaration.value;
    }
  });
  if (!converted || MODERN_CSS_COLOR.test(converted)) {
    throw new Error(`Could not create a Safari 15 color fallback for ${value}`);
  }
  return converted;
};

export const makeCssCompatibleWithSafari15 = async (source, from = undefined) => {
  const root = postcss.parse(source, { from });
  const stats = {
    flattenedLayers: 0,
    legacyUnitFallbacks: 0,
    textWrapFallbacks: 0,
    convertedCustomColors: 0,
    hasSelectorFallbacks: 0,
  };

  const layers = [];
  root.walkAtRules("layer", (atRule) => layers.push(atRule));
  layers.sort((a, b) => layerDepth(b) - layerDepth(a));

  for (const layer of layers) {
    if (layer.nodes?.length) layer.replaceWith(...layer.nodes);
    else layer.remove();
    stats.flattenedLayers += 1;
  }

  const declarations = [];
  root.walkDecls((declaration) => declarations.push(declaration));

  for (const declaration of declarations) {
    const fallbackValue = replaceLegacyUnits(declaration.value);
    if (
      fallbackValue !== declaration.value
      && !hasPreviousDeclaration(declaration, declaration.prop, fallbackValue)
    ) {
      declaration.parent.insertBefore(
        declaration,
        declaration.clone({ value: fallbackValue }),
      );
      stats.legacyUnitFallbacks += 1;
    }

    if (declaration.prop !== "text-wrap") continue;

    const whiteSpace = declaration.value.trim() === "nowrap" ? "nowrap" : "normal";
    if (!hasPreviousDeclaration(declaration, "white-space", whiteSpace)) {
      declaration.parent.insertBefore(
        declaration,
        declaration.clone({ prop: "white-space", value: whiteSpace }),
      );
      stats.textWrapFallbacks += 1;
    }
  }

  const transformed = await transform(root.toString(), {
    ...CSS_TRANSFORM_OPTIONS,
    sourcefile: from,
  });
  const output = postcss.parse(transformed.code, { from });
  const convertedColors = new Map();

  const customColors = [];
  output.walkDecls((declaration) => {
    if (
      declaration.prop.startsWith("--color-")
      && MODERN_CSS_COLOR.test(declaration.value)
    ) {
      customColors.push(declaration);
    }
  });
  for (const declaration of customColors) {
    let converted = convertedColors.get(declaration.value);
    if (!converted) {
      converted = await convertCustomColor(declaration.value, from);
      convertedColors.set(declaration.value, converted);
    }
    declaration.value = converted;
    stats.convertedCustomColors += 1;
  }

  output.walkRules((rule) => {
    if (!rule.selector.includes(PDF_ANNOTATION_HAS_SELECTOR)) return;
    rule.selector = rule.selector.replace(
      PDF_ANNOTATION_HAS_SELECTOR,
      PDF_ANNOTATION_FALLBACK_SELECTOR,
    );
    stats.hasSelectorFallbacks += 1;
  });

  return { css: output.toString(), stats };
};

export const buildReaderAssets = async ({ distDir = resolve("dist") } = {}) => {
  const root = resolve(distDir);
  const readerRoot = join(root, "foliate-js");
  await rm(join(readerRoot, "node_modules"), { recursive: true, force: true });
  const readerJavaScript = await listFiles(readerRoot, (path) => path.endsWith(".js"));

  if (readerJavaScript.length === 0) {
    throw new Error(`No Reader JavaScript found under ${readerRoot}`);
  }

  const transformedHashes = {};
  for (const path of readerJavaScript) {
    const source = await readFile(path, "utf8");
    const sourcefile = normalizePath(relative(root, path));
    const output = await transformJavaScriptForSafari15(source, sourcefile);
    await writeFile(path, output, "utf8");
    transformedHashes[sourcefile] = createHash("sha256").update(output).digest("hex");
  }
  await writeFile(
    join(root, READER_TRANSFORM_MANIFEST),
    `${JSON.stringify({
      schemaVersion: 1,
      target: SAFARI_15_TARGET,
      files: transformedHashes,
    }, null, 2)}\n`,
    "utf8",
  );

  const cssFiles = await listFiles(root, (path) => path.endsWith(".css"));
  const cssStats = {
    flattenedLayers: 0,
    legacyUnitFallbacks: 0,
    textWrapFallbacks: 0,
    convertedCustomColors: 0,
    hasSelectorFallbacks: 0,
  };

  for (const path of cssFiles) {
    const source = await readFile(path, "utf8");
    const { css, stats } = await makeCssCompatibleWithSafari15(source, path);
    await writeFile(path, css, "utf8");
    for (const key of Object.keys(cssStats)) cssStats[key] += stats[key];
  }

  return {
    target: SAFARI_15_TARGET,
    readerJavaScriptFiles: readerJavaScript.length,
    cssFiles: cssFiles.length,
    css: cssStats,
  };
};

const distArgument = (arguments_) => {
  const index = arguments_.indexOf("--dist");
  if (index === -1) return resolve("dist");
  if (!arguments_[index + 1]) throw new Error("--dist requires a directory");
  return resolve(arguments_[index + 1]);
};

const isMain = process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  try {
    const result = await buildReaderAssets({ distDir: distArgument(process.argv.slice(2)) });
    console.log(
      `Reader assets: ${result.readerJavaScriptFiles} JS files -> ${result.target}; `
      + `${result.css.flattenedLayers} CSS layers flattened; `
      + `${result.css.legacyUnitFallbacks} unit fallbacks and `
      + `${result.css.textWrapFallbacks} text-wrap fallbacks added; `
      + `${result.css.convertedCustomColors} custom colors converted.`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
