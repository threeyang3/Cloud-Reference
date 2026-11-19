'use strict';

/** Capture the exact note and editor, not only its current text.
 * Two different notes can have identical contents. If a tab is re-used while
 * the picker is open, never insert into its new document. Unsupported embedded
 * editors safely fall back to copying instead of guessing their ownership.
 */
function captureInsertion(plugin, editor, file, from, to) {
  const snapshot = editor.getValue();
  const start = {...from}, end = {...to};
  return text => {
    if (plugin.closed || !file) return false;
    const {workspace, vault} = plugin.app;
    if (vault.getAbstractFileByPath?.(file.path) !== file) return false;
    const leaves = workspace.getLeavesOfType?.('markdown') || [];
    if (!leaves.some(leaf => leaf.view?.file === file && leaf.view.editor === editor)) return false;
    if (editor.getValue() !== snapshot) return false;
    editor.replaceRange(text, start, end);
    return true;
  };
}
module.exports = {captureInsertion};
