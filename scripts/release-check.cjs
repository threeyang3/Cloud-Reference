'use strict';
const fs = require('node:fs'), path = require('node:path');
const root = path.resolve(__dirname, '..');
const acceptance = JSON.parse(fs.readFileSync(path.join(root, 'docs/acceptance.json'), 'utf8'));
const required = ['baidu-live-auth', 'baidu-live-search', 'folder-move', 'obsidian-macos', 'obsidian-windows', 'credential-sync', 'obsidian-performance'];
const missing = required.filter(id => {
  const gate = acceptance.gates.find(item => item.id === id);
  return !gate || gate.status !== 'passed' || typeof gate.evidence !== 'string' || !gate.evidence.trim();
});
if (missing.length) {
  console.error('Stable promotion blocked. Missing real-environment evidence: ' + missing.join(', '));
  process.exitCode = 1;
} else console.log('Recorded stable-release evidence is complete. Review it before tagging a release.');
