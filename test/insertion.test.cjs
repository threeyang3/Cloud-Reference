'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const {captureInsertion} = require('../src/insertion.cjs');
function fixture() {
  const file = {path: 'one.md'}, other = {path: 'two.md'}, writes = [];
  let contents = 'same text';
  const editor = {getValue: () => contents, replaceRange: (...args) => writes.push(args)};
  const view = {file, editor}, leaves = [{view}], files = new Map([[file.path, file], [other.path, other]]);
  const plugin = {closed: false, app: {workspace: {getLeavesOfType: () => leaves}, vault: {getAbstractFileByPath: name => files.get(name)}}};
  const from = {line: 0, ch: 0}, to = {line: 0, ch: 4};
  return {file, other, editor, writes, view, leaves, files, plugin, from, to, change: value => { contents = value; },
    capture: () => captureInsertion(plugin, editor, file, from, to)};
}
test('insertion targets the captured editor and original selection', () => {
  const f = fixture(), insert = f.capture(); f.from.ch = 7; f.to.ch = 9;
  assert.equal(insert('[fixture](url)'), true);
  assert.deepEqual(f.writes[0], ['[fixture](url)', {line: 0, ch: 0}, {line: 0, ch: 4}]);
});
test('switching a tab to an identical-content note never overwrites the new note', () => {
  const f = fixture(), insert = f.capture(); f.view.file = f.other;
  assert.equal(insert('link'), false); assert.equal(f.writes.length, 0);
});
test('editing the original note while choosing a cloud resource prevents replacement', () => {
  const f = fixture(), insert = f.capture(); f.change('edited');
  assert.equal(insert('link'), false); assert.equal(f.writes.length, 0);
});
test('closed or detached editors, deleted files and plugin unload all fall back safely', () => {
  for (const action of ['close', 'delete', 'unload', 'editor']) {
    const f = fixture(), insert = f.capture();
    if (action === 'close') f.leaves.length = 0;
    if (action === 'delete') f.files.delete(f.file.path);
    if (action === 'unload') f.plugin.closed = true;
    if (action === 'editor') f.view.editor = {};
    assert.equal(insert('link'), false); assert.equal(f.writes.length, 0);
  }
});
test('renaming the same live file preserves its editor identity', () => {
  const f = fixture(), insert = f.capture();
  f.files.delete(f.file.path); f.file.path = 'renamed.md'; f.files.set(f.file.path, f.file);
  assert.equal(insert('link'), true);
});
test('deleting and recreating a file at the same path is not the original note', () => {
  const f = fixture(), insert = f.capture(); f.files.set(f.file.path, {...f.file});
  assert.equal(insert('link'), false);
});
test('unsupported embedded editor or missing file context never guesses a destination', () => {
  const f = fixture(); delete f.plugin.app.workspace.getLeavesOfType;
  assert.equal(f.capture()('link'), false);
  assert.equal(captureInsertion(f.plugin, f.editor, null, f.from, f.to)('link'), false);
});
