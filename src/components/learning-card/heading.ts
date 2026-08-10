/**
 * Whether a module's own `heading` is worth drawing under the module's title.
 *
 * The card already prints a title over every module ("当前语境含义"), and models
 * reliably open the module by naming it again ("语境含义"), so the reader gets
 * the same words twice before any content. The prompt now asks for the field to
 * be left out; this guard is what makes it true for cards that were generated
 * before that, cached, or produced by a model that ignores the instruction.
 *
 * Only a heading that is *contained* in the title is dropped — equal to it, or
 * a prefix/suffix of it. A heading that adds words the title does not have
 * ("Tone shift" under "Tone", the lemma under "Word info") is content, not a
 * restatement, and stays.
 *
 * Nothing here imports React or i18n: the caller resolves the title, so this
 * can be asserted in a plain `node --test` run.
 */

/** Lower-cased, stripped of the inline Markdown and edge punctuation models add. */
function normalise(text: string) {
  return text
    .replace(/[*`=]/g, "")
    .replace(/\s+/g, "")
    .replace(/^[「『“"'（(【\[]+|[」』”"'）)】\]]+$/g, "")
    .replace(/[:：.。!！?？、,，]+$/g, "")
    .toLowerCase()
    .trim();
}

export function isRedundantHeading(heading: string | undefined, title: string | undefined) {
  if (!heading || !title) return false;
  const head = normalise(heading);
  const label = normalise(title);
  if (!head || !label) return false;
  return label.startsWith(head) || label.endsWith(head);
}
