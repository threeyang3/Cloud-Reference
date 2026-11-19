'use strict';
// Host/DOM contract doubles only; not evidence of a real Obsidian GUI run.
const test = require('node:test'), assert = require('node:assert/strict');
const Module = require('node:module'), os = require('node:os');
const {CloudService} = require('../src/service.cjs');
const {linkOf} = require('../src/reference.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
const ref = {provider: 'baidu', accountId: '123', fileId: '456', kind: 'file', name: 'old.pdf', path: '/old.pdf'};
class Plugin {
  async loadData() { return {}; }
  addSettingTab() {}
  addCommand() {}
  registerEditorSuggest() {}
  registerMarkdownPostProcessor(fn) { this.processor = fn; }
  registerObsidianProtocolHandler() {}
}
class Child {
  constructor(element) { this.containerEl = element; }
  unload() { this.onunload?.(); }
}
let Main;
const nativeLoad = Module._load;
try {
  Module._load = function(id, ...args) {
    return id === 'obsidian' ? {Plugin, MarkdownRenderChild: Child, Modal: class {},
      PluginSettingTab: class {}, Setting: class {}, Notice: class {}, EditorSuggest: class {}, Menu: class {}} : nativeLoad.call(this, id, ...args);
  };
  Main = require('../src/main.cjs');
} finally { Module._load = nativeLoad; }
function fixture(t) {
  const events = [], plugin = new Main();
  plugin.app = {vault: {adapter: {getBasePath: () => os.tmpdir()}, configDir: '.obsidian'},
    workspace: {trigger(name) { events.push(name); }}};
  plugin.manifest = {id: 'cloud-reference', version: '0.2.2'};
  t.after(() => plugin.onunload());
  return {plugin, events};
}
function anchor(r = ref, label = r.name) {
  const attributes = new Map([['href', linkOf(r)], ['title', r.path]]), handlers = new Map(), classes = new Set();
  return {textContent: label, childElementCount: 0, isConnected: true, attributes, handlers, classes,
    get title() { return attributes.get('title') || ''; }, set title(value) { attributes.set('title', value); },
    getAttribute: key => attributes.has(key) ? attributes.get(key) : null,
    setAttribute: (key, value) => attributes.set(key, String(value)), removeAttribute: key => attributes.delete(key),
    classList: {add: value => classes.add(value), remove: value => classes.delete(value)},
    addEventListener(type, fn) { if (!handlers.has(type)) handlers.set(type, new Set()); handlers.get(type).add(fn); },
    removeEventListener(type, fn) { handlers.get(type)?.delete(fn); },
    emit(type) { for (const fn of [...(handlers.get(type) || [])]) fn({preventDefault() {}, stopPropagation() {}}); },
  };
}
function render(plugin, links, observers = []) {
  const element = {querySelector: () => links[0], querySelectorAll: () => links,
    ownerDocument: {defaultView: {IntersectionObserver: class {
      constructor(callback) { this.callback = callback; observers.push(this); }
      observe() {} unobserve() {} disconnect() { this.disconnected = true; }
    }}}};
  let child;
  plugin.processor(element, {addChild(value) { child = value; child.onload(); }});
  return child;
}

test('disabling while settings load is pending cannot resurrect a plugin', async t => {
  const {plugin, events} = fixture(t); let release;
  plugin.loadData = () => new Promise(resolve => { release = resolve; });
  const loading = plugin.onload(); plugin.onunload(); release({}); await loading;
  assert.equal(plugin.api, undefined); assert.equal(plugin.transport, undefined);
  assert.equal(events.includes('cloud-reference:ready'), false);
});
test('failed registration tears down initialized resources before propagating error', async t => {
  const {plugin, events} = fixture(t);
  plugin.addCommand = () => { throw Error('fixture registration failure'); };
  await assert.rejects(plugin.onload(), /registration failure/);
  assert.equal(plugin.transport.closed, true); assert.equal(plugin.credentials.lifetime.signal.aborted, true);
  assert.equal(plugin.api, undefined); assert.equal(events.includes('cloud-reference:ready'), false);
});
test('one failing view cleanup cannot prevent network and credential teardown', async t => {
  const {plugin} = fixture(t); await plugin.onload(); let modalClosed = 0;
  plugin.renderChildren.add({unload() { throw Error('fixture broken view'); }});
  plugin.modals.add({close() { modalClosed++; }});
  assert.doesNotThrow(() => plugin.onunload());
  assert.equal(modalClosed, 1); assert.equal(plugin.transport.closed, true);
  assert.equal(plugin.credentials.lifetime.signal.aborted, true); assert.equal(plugin.modals.size, 0);
});
test('repeated unload emits exactly one lifecycle notification', async t => {
  const {plugin, events} = fixture(t); await plugin.onload(); plugin.onunload(); plugin.onunload();
  assert.equal(events.filter(name => name === 'cloud-reference:unloaded').length, 1);
});
test('default opener uses freshly resolved extension with only one metadata request', async t => {
  const {plugin} = fixture(t); await plugin.onload(); let queries = 0, opened;
  plugin.supportsBaiduClient = () => true;
  plugin.launchBaiduClient = () => { throw Error('wrong opener'); };
  plugin.settings.openers.pdf = 'pdf-reader'; plugin.settings.openers.mp4 = 'video-reader';
  plugin.provider.stat = async () => { queries++; return {...ref, name: 'new.mp4', path: '/renamed/new.mp4'}; };
  plugin.service.registerOpener({id: 'pdf-reader', canOpen: r => r.name.endsWith('.pdf'), open() { throw Error('wrong opener'); }});
  plugin.service.registerOpener({id: 'video-reader', canOpen: r => r.name.endsWith('.mp4'), open(r) { opened = r; }});
  await plugin.open(ref); assert.equal(opened.name, 'new.mp4'); assert.equal(queries, 1);
});
test('extension named constructor does not resolve through Object.prototype', async t => {
  const {plugin} = fixture(t); await plugin.onload(); let destination;
  plugin.supportsBaiduClient = () => false;
  const item = {...ref, name: 'file.constructor', path: '/file.constructor'};
  plugin.provider.stat = async () => item; plugin.external = async url => { destination = url; };
  await plugin.open(item); assert.match(destination, /^https:\/\/pan\.baidu\.com\//);
});
test('macOS file and folder defaults dispatch the updated location to Baidu Netdisk', async t => {
  const {plugin} = fixture(t);
  await plugin.onload();
  plugin.supportsBaiduClient = () => true;
  const launches = [];
  plugin.launchBaiduClient = (url, {signal}) => {
    assert.equal(signal.aborted, false);
    const value = url.split('?param=')[1];
    launches.push(JSON.parse(Buffer.from(value, 'base64').toString('utf8')));
  };
  plugin.external = () => { throw Error('unexpected web launch'); };
  plugin.pick = () => { throw Error('unexpected Obsidian picker'); };
  let resolves = 0;
  plugin.provider.stat = async entry => {
    resolves++;
    return {...entry, path: '/moved/' + entry.name};
  };
  await plugin.open(ref);
  await plugin.open({...ref, kind: 'folder', name: 'folder', path: '/folder'});
  assert.equal(resolves, 2);
  assert.equal(launches[0].fs_id, ref.fileId);
  assert.equal(launches[0].path, '/moved/old.pdf');
  assert.deepEqual(launches[1], {path: '/moved/folder', is_dir: 1});
});
test('failed native launch does not redirect, while an explicit web opener remains available', async t => {
  const {plugin} = fixture(t);
  await plugin.onload();
  plugin.supportsBaiduClient = () => true;
  plugin.provider.stat = async entry => entry;
  plugin.launchBaiduClient = async () => { throw Error('fixture missing client'); };
  const launches = [];
  plugin.external = async url => { launches.push(url); };
  await assert.rejects(plugin.open(ref), /fixture missing client/);
  assert.deepEqual(launches, []);
  await plugin.open(ref, {opener: 'web'});
  assert.match(launches[0], /^https:\/\/pan\.baidu\.com\//);
});
test('the explicit Obsidian folder picker remains independent of the client default', async t => {
  const {plugin} = fixture(t);
  await plugin.onload();
  plugin.supportsBaiduClient = () => true;
  const folder = {...ref, kind: 'folder', name: 'folder', path: '/folder'};
  const active = new AbortController();
  const picks = [];
  plugin.pick = async options => { picks.push(options); return null; };
  plugin.launchBaiduClient = () => { throw Error('unexpected app launch'); };
  await plugin.browseFolder(folder, {signal: active.signal});
  assert.deepEqual(picks, [{folder: {...folder, v: 1}, signal: active.signal, intent: 'browse'}]);
});
test('external opener receives a frozen credential-free identity', async () => {
  const service = new CloudService({stat: async () => ({...ref, accessToken: 'fixture-not-public'})});
  service.registerOpener({id: 'reader', canOpen(r) { assert.equal(Object.isFrozen(r), true); assert.equal(r.accessToken, undefined); return true; },
    open(r) { assert.equal(r.accessToken, undefined); }});
  try { await service.openWith('reader', ref); } finally { service.close(); }
});
test('reprocessing the same anchor cannot install duplicate handlers', async t => {
  const {plugin} = fixture(t); await plugin.onload(); const a = anchor(); let opens = 0;
  plugin.open = async () => { opens++; }; render(plugin, [a]); render(plugin, [a]);
  a.emit('click'); await tick(); assert.equal(opens, 1); assert.equal(a.handlers.get('click').size, 1);
});
test('dynamic label is restored on unload so reenabling can follow later renames', async t => {
  const {plugin} = fixture(t); await plugin.onload(); const a = anchor();
  plugin.resolve = async () => ({...ref, name: 'second.pdf', path: '/moved/second.pdf'});
  const child = render(plugin, [a]); a.emit('mouseenter'); await tick();
  assert.equal(a.textContent, 'second.pdf'); child.unload();
  assert.equal(a.textContent, ref.name); assert.equal(a.title, ref.path); assert.equal(a.classes.has('cr-link'), false);
  plugin.resolve = async () => ({...ref, name: 'third.pdf'});
  render(plugin, [a]); a.emit('mouseenter'); await tick(); assert.equal(a.textContent, 'third.pdf');
});
test('label lookup cannot overwrite an anchor repurposed by another renderer', async t => {
  const {plugin} = fixture(t); await plugin.onload(); const a = anchor(); let release;
  plugin.resolve = () => new Promise(resolve => { release = resolve; });
  render(plugin, [a]); a.emit('mouseenter');
  a.setAttribute('href', 'https://example.invalid/different'); a.textContent = 'other'; a.title = 'other title';
  release({...ref, name: 'late.pdf', path: '/late.pdf'}); await tick();
  assert.equal(a.textContent, 'other'); assert.equal(a.title, 'other title'); plugin.onunload();
  assert.equal(a.textContent, 'other'); assert.equal(a.title, 'other title');
});
test('disabling dynamic names also stops already mounted observers', async t => {
  const {plugin} = fixture(t); await plugin.onload(); const a = anchor(), observers = []; let queries = 0;
  plugin.resolve = async () => { queries++; return ref; }; render(plugin, [a], observers);
  plugin.settings.dynamicNames = false; observers[0].callback([{target: a, isIntersecting: true}]); await tick();
  assert.equal(queries, 0);
});
test('many hover events on one pending link share a single render request', async t => {
  const {plugin} = fixture(t); await plugin.onload(); const a = anchor(); let queries = 0, release;
  plugin.resolve = () => { queries++; return new Promise(resolve => { release = resolve; }); };
  render(plugin, [a]); for (let i = 0; i < 100; i++) a.emit('mouseenter');
  assert.equal(queries, 1); release(ref); await tick();
});

test('custom labels are not automatically queried merely by entering the viewport', async t => {
  const {plugin} = fixture(t); await plugin.onload(); const a = anchor(ref, '我的重点教材'), observed = [];
  const child = render(plugin, [a], observed); let requests = 0;
  plugin.resolve = async () => { requests++; return {...ref, name: 'new.pdf'}; };
  observed[0]?.callback([{target: a, isIntersecting: true}]); await tick(); assert.equal(requests, 0);
  a.emit('mouseenter'); await tick(); assert.equal(requests, 1); assert.equal(a.textContent, '我的重点教材');
  child.unload(); assert.equal(a.textContent, '我的重点教材');
});
test('a late name response is discarded after dynamic names have been disabled', async t => {
  const {plugin} = fixture(t); await plugin.onload(); const a = anchor(); let release;
  plugin.resolve = () => new Promise(resolve => { release = resolve; }); render(plugin, [a]); a.emit('mouseenter');
  plugin.settings.dynamicNames = false; release({...ref, name: 'late.pdf', path: '/late.pdf'}); await tick();
  assert.equal(a.textContent, ref.name); assert.equal(a.title, ref.path);
});
test('unloading a link without an original title does not leave a generated title', async t => {
  const {plugin} = fixture(t); await plugin.onload(); const a = anchor(); a.removeAttribute('title');
  plugin.resolve = async () => ({...ref, path: '/current.pdf'}); const child = render(plugin, [a]);
  a.emit('mouseenter'); await tick(); assert.equal(a.title, '/current.pdf'); child.unload();
  assert.equal(a.getAttribute('title'), null); assert.ok([...a.handlers.values()].every(handlers => handlers.size === 0));
});
test('independent source labels survive sharing one metadata lookup', async t => {
  const {plugin} = fixture(t); await plugin.onload(); const one = anchor(), two = anchor(ref, '自定义标题'); let loads = 0, release;
  plugin.provider.stat = () => { loads++; return new Promise(resolve => { release = resolve; }); };
  render(plugin, [one]); render(plugin, [two]); one.emit('mouseenter'); two.emit('mouseenter'); await tick();
  assert.equal(loads, 1); release({...ref, name: 'new.pdf'}); await tick();
  assert.equal(one.textContent, 'new.pdf'); assert.equal(two.textContent, '自定义标题');
});
test('late observer callbacks after unload do not initiate new requests', async t => {
  const {plugin} = fixture(t); await plugin.onload(); const a = anchor(), observers = []; let requests = 0;
  plugin.resolve = async () => { requests++; return ref; }; const child = render(plugin, [a], observers); child.unload();
  observers[0].callback([{target: a, isIntersecting: true}]); a.emit('mouseenter'); await tick();
  assert.equal(requests, 0); assert.equal(observers[0].disconnected, true);
});
test('repurposed links retain their native click behavior', async t => {
  const {plugin} = fixture(t); await plugin.onload(); const a = anchor(); let opens = 0, prevented = 0;
  plugin.open = async () => { opens++; }; render(plugin, [a]); a.setAttribute('href', 'https://example.invalid/other');
  for (const fn of a.handlers.get('click')) fn({preventDefault() { prevented++; }, stopPropagation() {}});
  await tick(); assert.equal(opens, 0); assert.equal(prevented, 0);
});
test('an opener unregistered during its capability check is never invoked', async () => {
  const service = new CloudService({stat: async () => ref}); let opened = false, remove;
  remove = service.registerOpener({id: 'reader', canOpen() { remove(); return true; }, open() { opened = true; }});
  await assert.rejects(service.openWith('reader', ref), e => e.code === 'opener'); assert.equal(opened, false); service.close();
});
test('async capability checks are rejected without leaking a rejected promise', async () => {
  const service = new CloudService({stat: async () => ref}); let opened = false;
  service.registerOpener({id: 'reader', canOpen() { return Promise.reject(Error('fixture async check')); }, open() { opened = true; }});
  await assert.rejects(service.openWith('reader', ref), e => e.code === 'opener'); await tick();
  assert.equal(opened, false); service.close();
});
