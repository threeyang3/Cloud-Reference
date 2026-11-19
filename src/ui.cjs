'use strict';
const {Modal, PluginSettingTab, Setting, Notice, setIcon} = require('obsidian');
const {reference, markdownOf, publicError, fail} = require('./reference.cjs');
const {check} = require('./runtime.cjs');
const {BAIDU_CLIENT, supportsBaiduClient} = require('./native.cjs');
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
  constructor(plugin, {account = null, onSaved} = {}) {
    super(plugin);
    this.account = account;
    this.onSaved = onSaved;
  }
  onOpen() {
    const c = this.contentEl; c.classList.add('cr-modal');
    el(c, 'h2', this.account ? '重新授权百度网盘' : '连接百度网盘');
    if (this.account) el(c, 'p', `请授权原账号 ${this.account.label}。`);
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
    if (this.account) {
      el(c, 'p', this.account.persistent ? '新凭据将以明文替换此库中原有的凭据，并可随库同步。持有库副本的人可能访问这个账号。' : '新的授权仅保留在本次会话。', {class: 'cr-muted'});
    } else {
      const label = el(c, 'label', undefined, {class: 'cr-consent'});
      this.persist = el(label, 'input', undefined, {type: 'checkbox'});
      el(label, 'span', '允许将明文凭据保存在 Vault，随坚果云同步；持有 Vault 副本的人可能访问我的网盘。');
      el(c, 'p', '不勾选仅保留本次会话。同步不等于加密，也不能保证多设备续期无冲突。授权范围以百度页面为准；本版不调用网盘写入接口。', {class: 'cr-muted'});
    }
    this.save = button(c, this.account ? '确认并更新授权' : '确认账号并保存', async () => {
      if (!this.candidate?.identity || this.busy) return;
      this.busy = true; this.controls();
      try {
        const {identity, pair} = this.candidate;
        const persistent = this.account?.persistent ?? this.persist.checked;
        await this.plugin.credentials.install(identity, pair, 'openlist', persistent, this.life.signal);
        this.plugin.service.cache.clear(); if (this.life.signal.aborted) return;
        new Notice(`已连接 ${identity.label}`); this.close(); this.onSaved?.();
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
    if (this.account && identity.accountId !== this.account.accountId) {
      this.candidate = null; clearTimeout(this.expiry);
      fail('identity', '该授权属于其他账号，请重新授权原账号。');
    }
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
const ACCOUNT_STATES = {
  connected: ['已有授权', 'ready'],
  'renewal-due': ['下次访问时续期', 'notice'],
  renewing: ['正在续期', 'notice'],
  recovery: ['待恢复', 'warning']
};

function settingsSection(parent, title, description) {
  const section = el(parent, 'section', undefined, {class: 'cr-settings-section'});
  const head = el(section, 'div', undefined, {class: 'cr-settings-section-head'});
  const intro = el(head, 'div');
  el(intro, 'h3', title);
  el(intro, 'p', description);
  return {section, head};
}

function settingsFeedback(parent) {
  return el(parent, 'p', '', {class: 'cr-settings-feedback', role: 'status', 'aria-live': 'polite'});
}

function showFeedback(element, text, tone = '') {
  element.textContent = text;
  element.setAttribute('data-tone', tone);
}

class SettingsTab extends PluginSettingTab {
  constructor(plugin) {
    super(plugin.app, plugin);
    this.plugin = plugin;
    this.accountLoad = 0;
    this.saving = false;
  }

  display() {
    this.hide();
    this.view = new AbortController();
    const c = this.containerEl;
    c.replaceChildren();
    const root = el(c, 'div', undefined, {class: 'cr-settings'});
    const header = el(root, 'header', undefined, {class: 'cr-settings-header'});
    const icon = el(header, 'span', undefined, {class: 'cr-settings-icon', 'aria-hidden': 'true'});
    setIcon?.(icon, 'cloud');
    const title = el(header, 'div', undefined, {class: 'cr-settings-title'});
    el(title, 'h2', 'Cloud Reference');
    el(title, 'p', '在 Obsidian 中浏览、搜索和引用百度网盘文件。');
    el(header, 'span', `v${this.plugin.manifest.version}`, {class: 'cr-settings-version'});

    this.renderAccounts(root, this.view.signal);
    this.renderReferences(root);
    this.renderDiagnostics(root);
  }

  renderAccounts(root, signal) {
    const {section, head} = settingsSection(root, '账号与授权', '这里显示本地授权状态。选择「验证连接」检查网盘访问。');
    const actions = el(head, 'div', undefined, {class: 'cr-settings-actions'});
    const connect = button(actions, '连接百度网盘', () => new AuthModal(this.plugin, {onSaved: load}).open());
    connect.classList.add('mod-cta');
    const reload = button(actions, '刷新状态', () => load());
    const panel = el(section, 'div', undefined, {class: 'cr-settings-panel'});
    const list = el(panel, 'div', undefined, {class: 'cr-settings-account-list'});
    const feedback = settingsFeedback(section);
    const load = async () => {
      if (signal.aborted || this.plugin.closed) return;
      const request = ++this.accountLoad;
      reload.disabled = true;
      list.setAttribute('aria-busy', 'true');
      showFeedback(feedback, '正在读取账号…');
      try {
        const accounts = await this.plugin.credentials.accountDetails();
        if (signal.aborted || request !== this.accountLoad) return;
        list.replaceChildren();
        if (!accounts.length) el(list, 'p', '连接账号后，就可以在笔记中插入网盘引用。', {class: 'cr-settings-empty'});
        for (const account of accounts) this.renderAccount(list, account, load, signal);
        const invalid = this.plugin.storage.invalidCount;
        showFeedback(feedback, invalid ? `${invalid} 个凭据文件无法读取。请检查同步冲突，或重新授权对应账号。` : '', invalid ? 'warning' : '');
      } catch (error) {
        if (!signal.aborted && request === this.accountLoad) showFeedback(feedback, publicError(error), 'error');
      } finally {
        if (!signal.aborted && request === this.accountLoad) {
          reload.disabled = false;
          list.setAttribute('aria-busy', 'false');
        }
      }
    };
    void load();
  }

  renderAccount(list, account, reload, signal) {
    const row = el(list, 'div', undefined, {class: 'cr-settings-account'});
    const head = el(row, 'div', undefined, {class: 'cr-settings-account-head'});
    el(head, 'strong', account.label, {class: 'cr-settings-account-name'});
    const [label, tone] = ACCOUNT_STATES[account.status];
    const status = el(head, 'span', label, {class: 'cr-settings-status', 'data-tone': tone});
    el(row, 'p', account.persistent ? '明文保存在此库，可随库同步' : '仅本次会话', {class: 'cr-settings-account-meta'});
    const actions = el(row, 'div', undefined, {class: 'cr-settings-actions'});
    button(actions, '浏览网盘', () => this.plugin.browseFolder(rootOf(account.accountId)));
    const verify = button(actions, '验证连接', async () => {
      if (verify.disabled || signal.aborted) return;
      verify.disabled = true;
      showFeedback(feedback, '正在验证账号和根目录访问…');
      try {
        await this.plugin.operation(signal, active =>
          this.plugin.credentials.use(account.accountId, async token => {
            const identity = await this.plugin.provider.verify(token, active);
            if (identity.accountId !== account.accountId) fail('identity', '授权账号不匹配，请重新授权。');
          }, active));
        if (signal.aborted) return;
        showFeedback(status, '连接正常', 'ready');
        showFeedback(feedback, '已验证身份和根目录访问。', 'ready');
      } catch (error) {
        if (signal.aborted) return;
        if (error.code === 'repair') showFeedback(status, '待恢复', 'warning');
        else if (error.code === 'unauthorized' || error.code === 'identity') showFeedback(status, '需要重新授权', 'warning');
        showFeedback(feedback, publicError(error), 'error');
      } finally {
        if (!signal.aborted) verify.disabled = false;
      }
    });
    button(actions, '重新授权', async () => {
      const current = (await this.plugin.credentials.accountDetails()).find(item => item.accountId === account.accountId);
      if (signal.aborted) return;
      if (!current) { await reload(); return; }
      new AuthModal(this.plugin, {account: current, onSaved: reload}).open();
    });
    button(actions, '移除凭据', () => {
      const confirmation = new TrackedModal(this.plugin);
      confirmation.onOpen = () => {
        el(confirmation.contentEl, 'h2', `移除 ${account.label} 的凭据`);
        el(confirmation.contentEl, 'p', '这会清除本次会话和此库中该账号的凭据，并可能影响同步设备。百度授权与网盘文件会保留。');
        const controls = el(confirmation.contentEl, 'div', undefined, {class: 'cr-toolbar'});
        button(controls, '取消', () => confirmation.close());
        const remove = button(controls, '确认移除', async () => {
          remove.disabled = true;
          try {
            await this.plugin.credentials.remove(account.accountId);
            this.plugin.service.cache.clear();
            confirmation.close();
            await reload();
          } finally { remove.disabled = false; }
        });
        remove.classList.add('mod-warning');
      };
      confirmation.open();
    });
    const feedback = settingsFeedback(row);
  }

  async saveSettings(change) {
    if (this.saving) fail('busy', '设置正在保存，请稍后重试。');
    this.saving = true;
    try {
      const next = {...this.plugin.settings, ...change};
      await this.plugin.saveData(next);
      Object.assign(this.plugin.settings, change);
    } finally { this.saving = false; }
  }

  renderReferences(root) {
    const {section} = settingsSection(root, '引用与打开方式', '在笔记中输入 /网盘 或 /cloud 选取资源，也可以直接复制引用。');
    const panel = el(section, 'div', undefined, {class: 'cr-settings-panel'});
    new Setting(panel).setName('选取网盘资源').setDesc('复制所选文件或目录的 Markdown 引用。')
      .addButton(b => b.setButtonText('浏览并复制引用').onClick(async () => {
        try {
          const selected = await this.plugin.pick();
          if (selected) await this.plugin.copy(markdownOf(selected));
        } catch (error) { new Notice(publicError(error)); }
      }));
    new Setting(panel).setName('在阅读视图显示最新名称').setDesc('保留手动写的标题和笔记原文。')
      .addToggle(t => t.setValue(this.plugin.settings.dynamicNames).onChange(async value => {
        try { await this.saveSettings({dynamicNames: value}); }
        catch (error) { t.setValue(this.plugin.settings.dynamicNames); new Notice(publicError(error)); }
      }));

    const rules = el(panel, 'div', undefined, {class: 'cr-settings-rule-list'});
    const ruleHead = el(rules, 'div', undefined, {class: 'cr-settings-rule-head'});
    const nativeClient = supportsBaiduClient();
    el(ruleHead, 'h4', '扩展名规则');
    el(ruleHead, 'p', nativeClient
      ? '默认使用百度网盘客户端打开引用。请在客户端登录引用所属账号。客户端可预览常见文件，其他格式会定位到所在目录。'
      : '文件默认在百度网盘网页定位所在目录。文件夹在 Obsidian 内打开。');
    const rows = el(rules, 'div');
    const form = el(rules, 'form', undefined, {class: 'cr-settings-rule-form'});
    const extension = input(form, '扩展名');
    extension.placeholder = '例如 pdf';
    const selectLabel = el(form, 'label', undefined, {class: 'cr-field'});
    el(selectLabel, 'span', '打开方式');
    const choices = el(selectLabel, 'select');
    const controls = el(form, 'div', undefined, {class: 'cr-settings-actions'});
    const submit = el(controls, 'button', '添加规则', {class: 'mod-cta', type: 'submit'});
    const cancel = button(controls, '取消编辑', () => edit());
    const feedback = settingsFeedback(rules);
    let editing;

    const openers = () => new Map([
      ...(nativeClient ? [[BAIDU_CLIENT, '百度网盘客户端']] : []),
      ['web', '百度网盘网页定位'],
      ...Array.from(this.plugin.service.openers.values(), item => [item.id, item.label || item.id])
    ]);
    const edit = (key, current = nativeClient ? BAIDU_CLIENT : 'web') => {
      editing = key;
      extension.value = key || '';
      extension.readOnly = Boolean(key);
      submit.textContent = key ? '保存规则' : '添加规则';
      cancel.hidden = !key;
      choices.replaceChildren();
      const registered = openers();
      for (const [id, label] of registered) el(choices, 'option', label, {value: id});
      if (!registered.has(current)) el(choices, 'option', '原打开器未注册', {value: current, disabled: ''});
      choices.value = current;
      showFeedback(feedback, '');
    };
    const render = () => {
      rows.replaceChildren();
      const entries = Object.entries(this.plugin.settings.openers).sort(([a], [b]) => a.localeCompare(b));
      if (!entries.length) el(rows, 'p', '还没有扩展名规则。', {class: 'cr-settings-empty'});
      const registered = openers();
      for (const [key, value] of entries) {
        const row = el(rows, 'div', undefined, {class: 'cr-settings-rule'});
        el(row, 'code', '.' + key, {class: 'cr-settings-extension'});
        el(row, 'span', registered.get(value) || `未注册（${value}）`, {class: 'cr-settings-rule-target'});
        const actions = el(row, 'div', undefined, {class: 'cr-settings-actions'});
        button(actions, '编辑', () => { edit(key, value); choices.focus(); });
        button(actions, '删除', async () => {
          try {
            const updated = Object.assign(Object.create(null), this.plugin.settings.openers);
            delete updated[key];
            await this.saveSettings({openers: updated});
            if (editing === key) edit();
            render();
            showFeedback(feedback, '已删除规则。', 'ready');
          } catch (error) { showFeedback(feedback, publicError(error), 'error'); }
        });
      }
    };
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (submit.disabled) return;
      submit.disabled = true;
      try {
        const key = extension.value.trim().replace(/^\./, '').toLowerCase();
        if (!/^[a-z0-9]{1,12}$/.test(key)) fail('invalid', '请输入 1 至 12 位英文字母或数字作为扩展名。');
        if (!openers().has(choices.value)) fail('opener', '请选择可用的打开方式。');
        const updated = Object.assign(Object.create(null), this.plugin.settings.openers);
        if (!editing && Object.hasOwn(updated, key)) fail('invalid', '此扩展名已有规则，请在列表中编辑。');
        if (!editing && Object.keys(updated).length >= 64) fail('limit', '最多保存 64 个扩展名规则。');
        updated[key] = choices.value;
        await this.saveSettings({openers: updated});
        edit();
        render();
        showFeedback(feedback, '已保存规则。', 'ready');
      } catch (error) { showFeedback(feedback, publicError(error), 'error'); }
      finally { submit.disabled = false; }
    });
    edit();
    render();
  }

  renderDiagnostics(root) {
    const {section, head} = settingsSection(root, '诊断', '计数为当前会话快照。');
    const actions = el(head, 'div', undefined, {class: 'cr-settings-actions'});
    button(actions, '刷新计数', () => render());
    button(actions, '复制诊断', () => this.plugin.copy(JSON.stringify(this.plugin.diagnostics(), null, 2)));
    const metrics = el(section, 'dl', undefined, {class: 'cr-settings-metrics'});
    const render = () => {
      const {network, metadata, visibleNames} = this.plugin.diagnostics();
      metrics.replaceChildren();
      for (const [label, value] of [
        ['网盘请求', network.requests], ['正在请求', network.active], ['等待请求', network.queued],
        ['元数据缓存', metadata.entries], ['名称待更新', visibleNames.queued]
      ]) {
        const metric = el(metrics, 'div', undefined, {class: 'cr-settings-metric'});
        el(metric, 'dt', label);
        el(metric, 'dd', String(value));
      }
    };
    render();
  }

  hide() { this.view?.abort(); }
}
module.exports = {AuthModal, Picker, SettingsTab, TrackedModal, rootOf, el, button, classify};
