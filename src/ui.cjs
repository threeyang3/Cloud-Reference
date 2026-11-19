'use strict';
const {Modal, PluginSettingTab, Setting, Notice} = require('obsidian');
const {reference, markdownOf, publicError, fail} = require('./reference.cjs');
const {check} = require('./runtime.cjs');
function el(parent, tag, text, attrs = {}) {
  const e = parent.ownerDocument.createElement(tag);
  if (text !== undefined) e.textContent = text;
  for (const [key, value] of Object.entries(attrs)) e.setAttribute(key, value);
  parent.appendChild(e); return e;
}
function button(parent, label, action) {
  const b = el(parent, 'button', label, {type: 'button'});
  b.addEventListener('click', () => { if (!b.disabled) Promise.resolve().then(action).catch(e => new Notice(publicError(e))); });
  return b;
}
function input(parent, label, type = 'text') {
  const l = el(parent, 'label', undefined, {class: 'cr-field'}); el(l, 'span', label);
  return el(l, 'input', undefined, {type, autocomplete: 'off', spellcheck: 'false'});
}
function rootOf(accountId) { return reference({provider: 'baidu', accountId, fileId: '0', kind: 'folder', path: '/', name: '我的网盘'}); }
class TrackedModal extends Modal {
  constructor(plugin) { super(plugin.app); this.plugin = plugin; this.life = new AbortController(); this.plugin.modals.add(this); }
  onClose() { this.life.abort(); this.plugin.modals.delete(this); this.contentEl.replaceChildren(); }
}
class AuthModal extends TrackedModal {
  onOpen() {
    const c = this.contentEl; c.classList.add('cr-modal'); el(c, 'h2', '连接百度网盘');
    el(c, 'p', '登录在隔离的百度官方页面进行。OpenList 负责授权码交换与令牌续期，能够接触授权凭据；文件请求直接发送给百度。不依赖漫笺。');
    this.status = el(c, 'p', '', {role: 'status', 'aria-live': 'polite'});
    this.login = button(c, '开始官方网页授权', () => this.obtain(() => this.plugin.authorize({signal: this.life.signal})));
    const fallback = el(c, 'details'); el(fallback, 'summary', '手动授权（隔离窗口不可用时）');
    el(fallback, 'p', '仅接受 OpenList 内置应用签发的新令牌。不要复制其他客户端正在使用的令牌。');
    button(fallback, '打开 OpenList 授权网页', () => this.plugin.external('https://api.oplist.org/'));
    this.secret = input(fallback, 'Refresh Token', 'password'); this.secret.maxLength = 4096;
    this.manual = button(fallback, '验证手动令牌', () => this.obtain(() => {
      const value = this.secret.value.trim(); this.secret.value = '';
      if (!value) fail('invalid', '请输入 Refresh Token。');
      return this.plugin.auth.renew(value, this.life.signal);
    }));
    this.retry = button(c, '重试验证已取得的授权', () => this.verifyCandidate()); this.retry.disabled = true;
    const label = el(c, 'label', undefined, {class: 'cr-consent'});
    this.persist = el(label, 'input', undefined, {type: 'checkbox'});
    el(label, 'span', '允许将明文凭据保存在 Vault，随坚果云同步；持有 Vault 副本的人可能访问我的网盘。');
    el(c, 'p', '不勾选仅保留本次会话。同步不等于加密，也不能保证多设备续期无冲突。授权范围以百度页面为准；本版不调用网盘写入接口。', {class: 'cr-muted'});
    this.save = button(c, '确认账号并保存', async () => {
      if (!this.candidate?.identity || this.busy) return;
      this.busy = true; this.controls();
      try {
        const {identity, pair} = this.candidate;
        await this.plugin.credentials.install(identity, pair, 'openlist', this.persist.checked, this.life.signal);
        this.plugin.service.cache.clear(); if (this.life.signal.aborted) return;
        new Notice(`已连接 ${identity.label}`); this.close();
      } catch (e) { if (!this.life.signal.aborted) this.status.textContent = publicError(e); }
      finally { this.busy = false; if (!this.life.signal.aborted) this.controls(); }
    });
    this.controls();
  }
  controls() {
    this.login.disabled = this.manual.disabled = Boolean(this.busy);
    this.retry.disabled = Boolean(this.busy) || !this.candidate;
    this.save.disabled = Boolean(this.busy) || !this.candidate?.identity;
  }
  async obtain(producer) {
    if (this.busy || this.life.signal.aborted) return;
    this.busy = true; this.candidate = null; clearTimeout(this.expiry); this.controls(); this.status.textContent = '正在获取授权…';
    try {
      const pair = await producer(); check(this.life.signal);
      this.candidate = {pair};
      this.expiry = setTimeout(() => { this.candidate = null; this.controls(); this.status.textContent = '未保存的授权已超时，请重新开始。'; }, 300000);
      await this.validateCandidate();
    } catch (e) { if (!this.life.signal.aborted) this.status.textContent = publicError(e); }
    finally { this.busy = false; if (!this.life.signal.aborted) this.controls(); }
  }
  async verifyCandidate() {
    if (this.busy || !this.candidate) return;
    this.busy = true; this.controls();
    try { await this.validateCandidate(); }
    catch (e) { if (!this.life.signal.aborted) this.status.textContent = publicError(e); }
    finally { this.busy = false; if (!this.life.signal.aborted) this.controls(); }
  }
  async validateCandidate() {
    const candidate = this.candidate; if (!candidate) return;
    this.status.textContent = '正在核验账号和根目录权限…';
    const identity = await this.plugin.provider.verify(candidate.pair.accessToken, this.life.signal);
    check(this.life.signal); if (this.candidate !== candidate) return;
    candidate.identity = identity;
    this.status.textContent = `已验证 ${identity.label}（账号 ${identity.accountId}）。请核对后保存。`;
  }
  onClose() { clearTimeout(this.expiry); if (this.secret) this.secret.value = ''; this.candidate = null; super.onClose(); }
}
function classify(item) {
  if (item.kind === 'folder') return 'folder';
  const name = item.name.toLowerCase();
  if (/\.pdf$/.test(name)) return 'pdf';
  if (/\.(png|jpe?g|webp|gif|svg|bmp|avif)$/.test(name)) return 'image';
  if (/\.(mp4|mkv|mov|webm|avi|m4v)$/.test(name)) return 'video';
  if (/\.(mp3|flac|wav|m4a|ogg|aac)$/.test(name)) return 'audio';
  return 'other';
}
class Picker extends TrackedModal {
  constructor(plugin, {folder, signal, intent = 'pick'} = {}, resolve) {
    super(plugin); this.folder = folder; this.intent = intent; this.resolveResult = resolve;
    this.selected = null; this.stack = []; this.generation = 0; this.items = []; this.pageOffset = 0;
    this.externalSignal = signal; this.abortExternal = () => this.close(); signal?.addEventListener('abort', this.abortExternal, {once: true});
  }
  onOpen() { this.render().catch(e => { if (!this.life.signal.aborted) { new Notice(publicError(e)); this.close(); } }); }
  async render() {
    const c = this.contentEl; c.classList.add('cr-modal'); el(c, 'h2', this.intent === 'browse' ? '网盘目录' : '网盘资源 · 快速引用');
    const accounts = await this.plugin.credentials.accounts(); if (this.life.signal.aborted) return;
    if (!accounts.length) {
      el(c, 'p', '还没有已连接账号。连接后重新打开此窗口。');
      button(c, '连接百度网盘', () => { this.close(); new AuthModal(this.plugin).open(); }); return;
    }
    if (this.plugin.storage?.invalidCount) el(c, 'p', '部分账号文件无法读取，已隔离；请检查同步冲突或重新授权。', {class: 'cr-warning'});
    const toolbar = el(c, 'div', undefined, {class: 'cr-toolbar'});
    this.account = el(toolbar, 'select', undefined, {'aria-label': '账号'});
    for (const a of accounts) el(this.account, 'option', a.label, {value: a.accountId});
    if (this.folder) {
      this.folder = reference(this.folder);
      if (!accounts.some(a => a.accountId === this.folder.accountId)) fail('unauthorized', '此引用所属账号尚未连接。');
    } else this.folder = rootOf(accounts[0].accountId);
    this.account.value = this.folder.accountId;
    this.account.addEventListener('change', () => { this.stack = []; this.folder = rootOf(this.account.value); this.query.value = ''; this.lastPage = null; void this.reload(0); });
    this.back = button(toolbar, '返回', () => { const previous = this.stack.pop(); if (previous) { this.folder = previous; this.query.value = ''; this.lastPage = null; return this.reload(0); } });
    this.path = el(c, 'div', '', {class: 'cr-path'});
    this.query = input(c, '搜索当前目录及子目录'); this.query.placeholder = '输入关键词，留空浏览目录'; this.query.maxLength = 60;
    this.query.addEventListener('input', () => {
      this.stopRequest(); this.generation++; this.invalidateSelection(); this.lastPage = null;
      this.status.textContent = '等待输入完成…'; clearTimeout(this.timer); this.timer = setTimeout(() => this.reload(0), 400);
    });
    this.query.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); clearTimeout(this.timer); void this.reload(0); }
      if (e.key === 'ArrowDown' && this.rowButtons?.length) { e.preventDefault(); this.rowButtons[0].focus(); }
    });
    const filters = el(c, 'div', undefined, {class: 'cr-toolbar'});
    this.filter = el(filters, 'select', undefined, {'aria-label': '类型筛选'});
    for (const [value, label] of [['all', '全部'], ['folder', '文件夹'], ['pdf', 'PDF'], ['image', '图片'], ['video', '视频'], ['audio', '音频'], ['other', '其他']]) el(this.filter, 'option', label, {value});
    this.filter.addEventListener('change', () => this.renderRows());
    this.min = input(filters, '最小 MiB', 'number'); this.min.min = '0'; this.min.addEventListener('input', () => this.renderRows());
    this.max = input(filters, '最大 MiB', 'number'); this.max.min = '0'; this.max.addEventListener('input', () => this.renderRows());
    this.status = el(c, 'p', '', {role: 'status', 'aria-live': 'polite'});
    this.list = el(c, 'div', undefined, {class: 'cr-results', role: 'list'});
    const footer = el(c, 'div', undefined, {class: 'cr-toolbar'});
    this.previous = button(footer, '上一页', () => this.reload(Math.max(0, this.pageOffset - 50)));
    this.next = button(footer, '下一页', () => this.nextOffset !== null && this.reload(this.nextOffset));
    this.choose = button(footer, this.intent === 'browse' ? '打开选中资源' : '选择资源', () => this.acceptSelected());
    this.selectFolder = button(footer, this.intent === 'browse' ? '复制当前目录引用' : '引用当前目录', () => {
      if (!this.loading && this.verifiedFolder) return this.intent === 'browse' ? this.plugin.copy(markdownOf(this.verifiedFolder)) : this.finish(this.verifiedFolder);
    });
    button(footer, '刷新', () => { this.lastPage = null; return this.reload(0); });
    await this.reload(0); if (!this.life.signal.aborted) this.query.focus();
  }
  invalidateSelection() {
    this.items = []; this.nextOffset = null; this.selected = null; this.verifiedFolder = null; this.rowButtons = [];
    this.choose.disabled = this.selectFolder.disabled = this.next.disabled = this.previous.disabled = true;
    this.list.replaceChildren();
  }
  stopRequest() { this.request?.abort(); }
  async reload(offset = 0) {
    if (this.life.signal.aborted) return;
    clearTimeout(this.timer); this.stopRequest(); const generation = ++this.generation;
    const request = new AbortController(); this.request = request;
    const abort = () => request.abort(); this.life.signal.addEventListener('abort', abort, {once: true});
    this.loading = true; this.invalidateSelection(); this.list.setAttribute('aria-busy', 'true');
    this.path.textContent = this.folder.path; this.back.disabled = !this.stack.length; this.status.textContent = '正在请求网盘…';
    const query = this.query.value.trim();
    try {
      const result = query ? await this.plugin.service.search(this.folder, query, {offset, signal: request.signal}) :
        await this.plugin.service.browse(this.folder, {offset, signal: request.signal});
      if (request.signal.aborted || generation !== this.generation) return;
      this.folder = reference(result.folder); this.verifiedFolder = this.folder; this.path.textContent = this.folder.path;
      this.items = result.items; this.nextOffset = result.nextOffset; this.pageOffset = offset;
      const signature = result.items.map(item => item.fileId).join(','), scope = this.folder.accountId + ':' + this.folder.fileId + ':' + query;
      const repeated = offset > 0 && result.items.length > 0 && this.lastPage?.scope === scope && this.lastPage.offset !== offset && this.lastPage.signature === signature;
      this.lastPage = {scope, offset, signature}; if (repeated) this.nextOffset = null;
      this.status.textContent = `${query ? '搜索' : '目录'}第 ${offset / 50 + 1} 页，${result.items.length} 项；筛选仅作用于当前页。` +
        (repeated ? '网盘返回重复分页，已停止继续翻页。' : '') + (result.scopeFiltered ? '已排除范围外或重复条目。' : '');
      this.loading = false; this.selectFolder.disabled = false; this.previous.disabled = offset === 0;
      this.next.disabled = this.nextOffset === null; this.renderRows();
    } catch (e) { if (!request.signal.aborted && generation === this.generation) this.status.textContent = publicError(e); }
    finally {
      this.life.signal.removeEventListener('abort', abort);
      if (generation === this.generation) { this.loading = false; this.list.setAttribute('aria-busy', 'false'); }
    }
  }
  enter(item) {
    if (this.loading || this.life.signal.aborted) return;
    if (this.stack.length >= 64) this.stack.shift();
    this.stack.push(this.folder); this.folder = reference(item); this.query.value = ''; this.lastPage = null; return this.reload(0);
  }
  acceptSelected() {
    if (!this.selected || this.loading) return;
    if (this.intent === 'browse' && this.selected.kind === 'folder') return this.enter(this.selected);
    this.finish(this.selected);
  }
  renderRows() {
    this.list.replaceChildren(); this.rowButtons = []; this.selected = null; this.choose.disabled = true;
    if (this.loading) return;
    const kind = this.filter.value, min = Number(this.min.value || 0) * 1024 * 1024;
    const max = this.max.value === '' ? Infinity : Number(this.max.value) * 1024 * 1024;
    if (!Number.isFinite(min) || min < 0 || Number.isNaN(max) || max < min) { el(this.list, 'p', '请检查大小范围。'); return; }
    const rows = this.items.filter(x => (kind === 'all' || classify(x) === kind) &&
      (min === 0 && max === Infinity || Number.isFinite(x.size) && x.size >= min && x.size <= max));
    const generation = this.generation;
    for (const item of rows) {
      const row = el(this.list, 'div', undefined, {class: 'cr-row', role: 'listitem'});
      const pick = button(row, `${item.kind === 'folder' ? '目录' : '文件'} · ${item.name}`, () => {
        if (this.loading || this.life.signal.aborted || generation !== this.generation) return;
        this.selected = reference(item);
        for (const b of this.rowButtons) b.setAttribute('aria-pressed', 'false');
        pick.setAttribute('aria-pressed', 'true'); this.choose.disabled = false;
      });
      pick.setAttribute('aria-pressed', 'false'); this.rowButtons.push(pick);
      pick.addEventListener('keydown', e => {
        const index = this.rowButtons.indexOf(pick);
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); this.rowButtons[Math.max(0, Math.min(this.rowButtons.length - 1, index + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus(); }
        if (e.key === 'Enter' && !this.loading && generation === this.generation) { e.preventDefault(); this.selected = reference(item); this.acceptSelected(); }
      });
      el(row, 'small', item.path, {class: 'cr-path'});
      if (item.kind === 'folder') button(row, '进入', () => generation === this.generation && this.enter(item));
      row.addEventListener('contextmenu', e => { e.preventDefault(); if (!this.loading && generation === this.generation) this.plugin.menu(item, e); });
    }
    if (!rows.length) el(this.list, 'p', '当前页没有匹配条目。');
  }
  finish(ref) { this.result = reference(ref); this.close(); }
  onClose() {
    clearTimeout(this.timer); this.stopRequest(); this.externalSignal?.removeEventListener('abort', this.abortExternal);
    super.onClose(); this.resolveResult?.(this.result || null); this.resolveResult = null; this.items = []; this.rowButtons = [];
  }
}
class SettingsTab extends PluginSettingTab {
  constructor(plugin) { super(plugin.app, plugin); this.plugin = plugin; this.generation = 0; }
  display() {
    const generation = ++this.generation, c = this.containerEl; c.replaceChildren();
    el(c, 'h2', `Cloud Reference · ${this.plugin.manifest.version}`);
    new Setting(c).setName('百度网盘授权').setDesc('隔离官方登录窗口；宿主不支持时可手动导入 OpenList 令牌。')
      .addButton(b => b.setButtonText('连接账号').onClick(() => new AuthModal(this.plugin).open()));
    new Setting(c).setName('动态显示真实文件名').setDesc('仅阅读视图可见链接按需查询；后台查询并发 2，排队上限 32。超出时保留原名称，悬停或点击可更新。')
      .addToggle(t => t.setValue(this.plugin.settings.dynamicNames).onChange(async value => {
        this.plugin.settings.dynamicNames = value; await this.plugin.saveData(this.plugin.settings);
      }));
    el(c, 'p', '不建立持久搜索索引，不自动下载，不扫描整个库。默认打开网盘位置；只有已注册的外部打开器可另设默认行为。', {class: 'cr-muted'});
    new Setting(c).setName('性能诊断（无账号与路径）').setDesc('只读取计数，不触发网盘请求。')
      .addButton(b => b.setButtonText('复制诊断').onClick(() => this.plugin.copy(JSON.stringify(this.plugin.diagnostics(), null, 2))));
    const extension = input(c, '扩展名，例如 pdf'); const choices = el(c, 'select', undefined, {'aria-label': '默认打开器'});
    el(choices, 'option', '在网盘定位', {value: 'web'});
    for (const opener of this.plugin.service.openers.values()) el(choices, 'option', opener.label || opener.id, {value: opener.id});
    button(c, '保存打开方式', async () => {
      const key = extension.value.trim().replace(/^\./, '').toLowerCase();
      if (!/^[a-z0-9]{1,12}$/.test(key)) fail('invalid', '请输入有效扩展名。');
      if (!Object.hasOwn(this.plugin.settings.openers, key) && Object.keys(this.plugin.settings.openers).length >= 64) fail('limit', '最多保存 64 个扩展名规则。');
      this.plugin.settings.openers[key] = choices.value; await this.plugin.saveData(this.plugin.settings); new Notice('已保存。');
    });
    const box = el(c, 'div'); el(box, 'h3', '已连接账号');
    this.plugin.credentials.accounts().then(accounts => {
      if (!box.isConnected || generation !== this.generation || this.plugin.closed) return;
      if (this.plugin.storage.invalidCount) el(box, 'p', '部分凭据文件无效，请检查同步冲突；未影响其他有效账号。');
      for (const account of accounts) {
        const row = el(box, 'div', account.label, {class: 'cr-toolbar'});
        button(row, '移除凭据', () => {
          const confirm = new TrackedModal(this.plugin);
          confirm.onOpen = () => {
            el(confirm.contentEl, 'p', '移除会删除库内凭据并影响同步设备，但不撤销百度授权、不删除网盘文件。');
            button(confirm.contentEl, '取消', () => confirm.close());
            button(confirm.contentEl, '确认移除', async () => { await this.plugin.credentials.remove(account.accountId); this.plugin.service.cache.clear(); confirm.close(); this.display(); });
          };
          confirm.open();
        });
      }
    }).catch(e => { if (box.isConnected && generation === this.generation) el(box, 'p', publicError(e)); });
  }
  hide() { this.generation++; }
}
module.exports = {AuthModal, Picker, SettingsTab, TrackedModal, rootOf, el, button, classify};
