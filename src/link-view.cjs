'use strict';
const {MarkdownRenderChild, Notice} = require('obsidian');
const {parseLink, keyOf, displayName, publicError} = require('./reference.cjs');
const {waitFor} = require('./runtime.cjs');
const SELECTOR = 'a[href^="obsidian://cloud-reference?"]';

/** Own each rendered anchor once, without changing its Markdown source. */
class LinkChild extends MarkdownRenderChild {
  constructor(element, plugin) {
    super(element); this.plugin = plugin; this.life = new AbortController(); this.bindings = [];
    plugin.renderChildren.add(this);
  }
  onload() {
    if (this.plugin.closed || this.life.signal.aborted) return;
    const owners = this.plugin.linkOwners;
    const valid = binding => !this.life.signal.aborted && !this.plugin.closed &&
      binding.anchor.isConnected && owners.get(binding.anchor) === this &&
      binding.anchor.getAttribute('href') === binding.href;
    const refresh = (binding, priority = false) => {
      if (!valid(binding) || !this.plugin.settings.dynamicNames || binding.pending) return;
      binding.pending = true;
      const {anchor, ref} = binding, load = signal => this.plugin.resolve(ref, {signal});
      let work;
      try { work = priority ? load(this.life.signal) : this.plugin.names.get(keyOf(ref), load, this.life.signal); }
      catch (error) { work = Promise.reject(error); }
      waitFor(Promise.resolve(work), this.life.signal).then(current => {
        if (!valid(binding) || !this.plugin.settings.dynamicNames) return;
        // Do not overwrite another renderer's edits while our lookup was pending.
        if (!anchor.childElementCount && anchor.textContent === binding.renderedLabel) {
          anchor.textContent = displayName(binding.sourceLabel, ref, current.name);
          binding.renderedLabel = anchor.textContent;
        }
        if (anchor.getAttribute('title') === binding.renderedTitle) {
          anchor.title = current.path; binding.renderedTitle = anchor.getAttribute('title');
        }
      }).catch(error => {
        if (error?.code === 'busy' || !valid(binding) || !this.plugin.settings.dynamicNames) return;
        if (anchor.getAttribute('title') === binding.renderedTitle) {
          anchor.title = `${ref.path} · ${publicError(error)}`; binding.renderedTitle = anchor.getAttribute('title');
        }
      }).finally(() => { binding.pending = false; });
    };
    const byAnchor = new WeakMap(), View = this.containerEl.ownerDocument.defaultView;
    if (this.plugin.settings.dynamicNames && View?.IntersectionObserver) {
      this.observer = new View.IntersectionObserver(entries => {
        for (const entry of entries) if (entry.isIntersecting) {
          this.observer.unobserve(entry.target);
          const binding = byAnchor.get(entry.target);
          if (binding && binding.sourceLabel === binding.ref.name && !binding.anchor.childElementCount) refresh(binding);
        }
      }, {rootMargin: '0px', threshold: 0});
    }
    for (const anchor of this.containerEl.querySelectorAll(SELECTOR)) {
      if (owners.has(anchor)) continue;
      const href = anchor.getAttribute('href'); let ref;
      try { ref = parseLink(href); } catch { continue; }
      const binding = {anchor, ref, href, sourceLabel: anchor.textContent, renderedLabel: anchor.textContent,
        sourceTitle: anchor.getAttribute('title'), renderedTitle: anchor.getAttribute('title'),
        hadClass: Boolean(anchor.classList.contains?.('cr-link')), pending: false, listeners: []};
      owners.set(anchor, this); byAnchor.set(anchor, binding); this.bindings.push(binding); anchor.classList.add('cr-link');
      const click = event => {
        if (!valid(binding)) return;
        event.preventDefault(); event.stopPropagation();
        Promise.resolve().then(() => valid(binding) && this.plugin.open(ref)).catch(error => {
          if (valid(binding)) new Notice(publicError(error));
        });
      };
      const menu = event => { if (valid(binding)) { event.preventDefault(); event.stopPropagation(); this.plugin.menu(ref, event); } };
      const hover = () => refresh(binding, true);
      for (const [type, fn] of [['click', click], ['contextmenu', menu], ['mouseenter', hover]]) {
        anchor.addEventListener(type, fn); binding.listeners.push(() => anchor.removeEventListener(type, fn));
      }
      if (binding.sourceLabel === ref.name && !anchor.childElementCount) this.observer?.observe(anchor);
    }
    if (!this.bindings.length) this.observer?.disconnect();
  }
  onunload() {
    this.plugin.renderChildren.delete(this); this.life.abort(); this.observer?.disconnect();
    for (const binding of this.bindings) {
      const {anchor} = binding;
      for (const remove of binding.listeners) remove();
      if (this.plugin.linkOwners.get(anchor) !== this) continue;
      this.plugin.linkOwners.delete(anchor);
      if (!binding.hadClass) anchor.classList.remove('cr-link');
      if (anchor.getAttribute('href') !== binding.href) continue;
      if (!anchor.childElementCount && anchor.textContent === binding.renderedLabel) anchor.textContent = binding.sourceLabel;
      if (anchor.getAttribute('title') === binding.renderedTitle) {
        if (binding.sourceTitle === null) anchor.removeAttribute('title'); else anchor.setAttribute('title', binding.sourceTitle);
      }
    }
    this.bindings = [];
  }
}
module.exports = {LinkChild};
