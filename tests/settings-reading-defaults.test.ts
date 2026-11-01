import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

import { createDefaultReaderSettings } from "../src/pages/reader/useReaderSettingsSync.ts";

/** Every `const [name, setX] = useState(initial)` initializer in a component, evaluated. */
function useStateInitializers(file: string, globals: Record<string, unknown>) {
  const source = readFileSync(file, "utf8");
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: Record<string, unknown> = {};
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && ts.isArrayBindingPattern(node.name) && node.initializer
      && ts.isCallExpression(node.initializer)
      && node.initializer.expression.getText(tree) === "useState") {
      const element = node.name.elements[0];
      const name = ts.isBindingElement(element) ? element.name : element;
      const initial = node.initializer.arguments[0];
      if (ts.isIdentifier(name) && initial) {
        // The initializer may be a lazily-called factory; calling it is what React does.
        // Only the initialisers that stand on their own are worth evaluating;
        // one that reads a prop (the sub-page view) cannot be judged here.
        const standalone = !/\binitialView\b/.test(initial.getText(tree));
        if (standalone) {
          try {
            found[name.getText(tree)] = runInNewContext(
              `(${initial.getText(tree)}) instanceof Function ? (${initial.getText(tree)})() : (${initial.getText(tree)})`,
              globals,
            );
          } catch {
            // Not standalone either; leave it out.
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return found;
}

test("the Reading pane's unsaved rows start at the reader's own defaults", () => {
  const defaults = createDefaultReaderSettings();
  const initial = useStateInitializers("src/components/settings/ReadingSettings.tsx", {
    getDefaultReaderTheme: () => defaults.theme,
    parseReaderCustomTheme: () => defaults.customTheme,
    createDefaultReaderSettings,
    DEFAULT_PREVIOUS_PAGE_BINDING: defaults.previousPageBinding,
    DEFAULT_NEXT_PAGE_BINDING: defaults.nextPageBinding,
  });
  // Rows whose settings key may be absent: the pane then keeps this value for
  // the rest of the session, so it has to be the value the reader resolves.
  assert.equal(initial.readerTheme, defaults.theme);
  assert.equal(initial.fontFamily, defaults.font);
  assert.equal(initial.cjkFontFamily, defaults.cjkFont);
  assert.equal(initial.fontSize, defaults.fontSize);
  assert.equal(initial.paragraphSpacing, defaults.paragraphSpacing);
  assert.equal(initial.readingMode, defaults.readingMode);
  assert.equal(initial.pageLayout, String(defaults.pageColumns));
  assert.equal(initial.showChapterProgress, defaults.showChapterProgress);
  assert.equal(initial.showBookProgress, defaults.showBookProgress);
  assert.equal(initial.showPageNumbers, defaults.showPageNumbers);
  assert.equal(initial.lineSpacing, defaults.lineSpacing);
  assert.equal(initial.margins, defaults.margins);
});

test("the menu's move-down bound counts only the rows it can actually reorder", () => {
  const file = "src/components/settings/SelectionMenuSettings.tsx";
  const tree = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let expression = "";
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === "total" && node.initializer) {
      expression = node.initializer.getText(tree);
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  assert.ok(expression, "total is no longer declared");
  const value = [{ id: "a" }, { id: "b" }];
  // The draft row lives outside `value`; `reorderArray` refuses `to >= value.length`,
  // so the bound the arrows disable against must stay on the reorderable length.
  const total = runInNewContext(`(${expression})`, { value, newAction: { item: { id: "draft" } } });
  assert.equal(total, value.length);
});
