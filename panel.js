/* Local panel helpers. No persisted position, transcript or telemetry. */
(() => {
  function updateText(element, value) {
    const node = element.firstChild;
    if (!node || node.nodeType !== 3 || element.childNodes.length !== 1) {
      element.textContent = value; return;
    }
    const old = node.data;
    if (old === value) return;
    let prefix = 0, suffix = 0;
    while (prefix < Math.min(old.length, value.length) && old[prefix] === value[prefix]) prefix++;
    while (suffix < Math.min(old.length, value.length) - prefix && old.at(-1-suffix) === value.at(-1-suffix)) suffix++;
    node.replaceData(prefix, old.length-prefix-suffix, value.slice(prefix, value.length-suffix));
  }
  class TextBlocks {
    constructor(element, format, field = 'text', size = 32) {
      this.element = element; this.format = format; this.field = field; this.size = size;
      this.blocks = []; this.items = []; this.dirty = 0;
    }
    update(items, from) {
      this.items = items; this.dirty = Math.min(this.dirty, from);
    }
    render() {
      const count = Math.ceil(this.items.length / this.size);
      for (let i = Math.floor(this.dirty / this.size); i < count; i++) {
        if (!this.blocks[i]) {
          const block = this.element.ownerDocument.createElement('p');
          block.className = 'text-block'; this.element.append(block); this.blocks.push(block);
        }
        updateText(this.blocks[i], this.format(this.items.slice(i*this.size, (i+1)*this.size), this.field));
      }
      while (this.blocks.length > count) this.blocks.pop().remove();
      this.dirty = Infinity;
    }
  }
  class Timings {
    constructor() { this.samples = []; this.discarded = 0; }
    add(sample) {
      if (sample.discarded) this.discarded++;
      this.samples.push(sample);
      if (this.samples.length > 128) this.samples.shift();
    }
    summary() {
      const quantile = (field, p) => {
        const values = this.samples.map(x => x[field]).filter(Number.isFinite).sort((a,b) => a-b);
        return values.length ? `${(values[Math.ceil(values.length*p)-1]/1000).toFixed(1)} s` : 'n/a';
      };
      return `Last ${this.samples.length} requests · request p50/p95 ${quantile('requestMs', .5)} / ${quantile('requestMs', .95)}\n` +
        `First useful text p50/p95 ${quantile('firstMs', .5)} / ${quantile('firstMs', .95)}\n` +
        `Caption change → first useful text p50/p95 ${quantile('lagMs', .5)} / ${quantile('lagMs', .95)}\n` +
        `Fully discarded final responses: ${this.discarded} (session total). Timing stays local; no transcript is recorded.`;
    }
  }
  function makeDraggable(host, handle) {
    const view = host.ownerDocument.defaultView;
    const margin = 8;
    let drag = null;

    function place(left, top) {
      const rect = host.getBoundingClientRect();
      host.style.left = `${Math.max(margin, Math.min(left, view.innerWidth - rect.width - margin))}px`;
      host.style.top = `${Math.max(margin, Math.min(top, view.innerHeight - rect.height - margin))}px`;
      host.style.right = 'auto';
    }
    function keepVisible() {
      const rect = host.getBoundingClientRect();
      if (rect.left < margin || rect.top < margin ||
          rect.right > view.innerWidth - margin || rect.bottom > view.innerHeight - margin) {
        place(rect.left, rect.top);
      }
    }
    function end(event) {
      if (!drag || (event?.pointerId !== undefined && event.pointerId !== drag.id)) return;
      const id = drag.id;
      drag = null;
      handle.removeAttribute('data-dragging');
      if (handle.hasPointerCapture(id)) handle.releasePointerCapture(id);
    }
    handle.addEventListener('pointerdown', event => {
      if (drag || event.button !== 0 || !event.isPrimary || event.target.closest('button')) return;
      const rect = host.getBoundingClientRect();
      handle.setPointerCapture(event.pointerId);
      drag = { id: event.pointerId, x: event.clientX - rect.left, y: event.clientY - rect.top };
      handle.setAttribute('data-dragging', '');
      event.preventDefault();
    });
    handle.addEventListener('pointermove', event => {
      if (!drag || event.pointerId !== drag.id) return;
      place(event.clientX - drag.x, event.clientY - drag.y);
    });
    for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) handle.addEventListener(name, end);
    view.addEventListener('blur', () => end());
    view.addEventListener('pagehide', () => end());
    view.addEventListener('resize', keepVisible);
    // Re-clamp when settings, the original text, or growing captions change panel size.
    new view.ResizeObserver(keepVisible).observe(host);
  }
  const api = { makeDraggable, TextBlocks, Timings };
  if (typeof module !== 'undefined') module.exports = api;
  else globalThis.MeetPanel = api;
})();
