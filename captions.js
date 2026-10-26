/* Sentence anchors are only for replacing a translated tail, never separate requests. */
(() => {
  const normalize = value => value.replace(/\s+/gu, ' ').trim();
  const TARGET_LANGUAGES = Object.freeze({ ru: 'Russian', en: 'English', ja: 'Japanese',
    de: 'German', fr: 'French', es: 'Spanish', pt: 'Portuguese', it: 'Italian',
    zh: 'Chinese', ko: 'Korean', uk: 'Ukrainian', ar: 'Arabic' });
  const DEFAULTS = Object.freeze({ intervalMs: 4000, newChars: 500, overlap: 10, targetLanguage: 'ru',
    minDispatchMs: 1000, targetWindowChars: 6000, clauseChars: 600,
    maxWindowChars: 48000, maxSegments: 512, maxTranscriptChars: 1000000 });
  // Use the runtime's Unicode sentence rules; the source is not restricted to Japanese.
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'sentence' });
  const sentences = text => [...segmenter.segment(text)].map(item => item.segment.trim()).filter(Boolean);
  const same = (a, b) => a === b || a?.id === b?.id && a?.speaker === b?.speaker && a?.text === b?.text;
  function phrases(text, limit) {
    // Only clause punctuation followed by whitespace (or CJK punctuation). Never cut
    // words, decimal commas, URLs, or an unpunctuated phrase to meet a character quota.
    return sentences(text).flatMap(sentence => {
      if (sentence.length <= limit) return [sentence];
      const result = []; let start = 0;
      for (const match of sentence.matchAll(/[,;:](?=\s)|[、，；：]/gu)) {
        const end = match.index + match[0].length;
        if (end - start >= limit) { result.push(sentence.slice(start, end).trim()); start = end; }
      }
      if (sentence.slice(start).trim()) result.push(sentence.slice(start).trim());
      return result;
    });
  }
  function difference(before, after) {
    const old = new Map(before.map(item => [item.id, item])); let amount = 0;
    for (const item of after) {
      const previous = old.get(item.id);
      if (!same(previous, item)) amount += previous?.speaker === item.speaker ?
        changedChars(previous.text, item.text) : item.text.length;
      old.delete(item.id);
    }
    return amount + [...old.values()].reduce((sum, item) => sum + item.text.length, 0);
  }
  function usablePrefix(previous, current) {
    let end = 0;
    while (end < previous.length) {
      const old = previous[end], fresh = current[end];
      // The last unfinished phrase may have grown while its translation was running.
      const extended = end === previous.length - 1 && old.id === fresh?.id &&
        old.speaker === fresh.speaker && fresh.text.startsWith(old.text);
      if (!same(old, fresh) && !extended) break;
      end++;
    }
    return end;
  }
  function changedChars(before = '', after = '') {
    let start = 0, end = 0;
    while (start < Math.min(before.length, after.length) && before[start] === after[start]) start++;
    while (end < Math.min(before.length, after.length) - start && before.at(-1-end) === after.at(-1-end)) end++;
    return Math.max(before.length, after.length) - start - end;
  }
  function paragraphs(segments, field = 'text') {
    const result = [];
    for (const item of segments) {
      if (result.at(-1)?.speaker === item.speaker) result.at(-1).text += ' ' + item[field];
      else result.push({ speaker: item.speaker, text: item[field] });
    }
    return result.map(item => `${item.speaker}: ${item.text}`).join('\n\n');
  }

  class Tracker {
    constructor(options = {}) {
      this.options = { ...DEFAULTS, ...options };
      this.states = new Map();
      this._document = [];
      this.transcriptChars = 0;
      this.translated = [];
      this.sentDocument = [];
      this.dirtySince = null;
      this.lastDispatch = -Infinity;
      this.queuedReason = null;
      this.counter = 0;
      this._pendingChars = 0;
      this._matching = 0;
      this._sourceFrom = 0;
      this._translationFrom = 0;
      this._preview = null;
    }
    seed(key, speaker, raw) {
      key = String(key);
      this.states.set(key, { speaker, baseline: normalize(raw), text: '', segments: [],
        sent: [], pending: 0, offset: this.document.length });
    }
    update(key, speaker, raw, now) {
      key = String(key);
      let state = this.states.get(key);
      if (!state) { state = { speaker, baseline: '', text: '', segments: [], sent: [], pending: 0,
        offset: this._document?.length ?? 0 }; this.states.set(key, state); }
      const normalized = normalize(raw);
      const text = normalized.slice(Math.min(state.baseline.length, normalized.length)).trim();
      if (text === state.text && speaker === state.speaker) return false;
      const segments = phrases(text, this.options.clauseChars).map((text, index) => {
        const segment = { id: `${key}:${index}`, speaker, text };
        return same(segment, state.segments[index]) ? state.segments[index] : segment;
      });
      const chars = this.transcriptChars - state.segments.reduce((sum, item) => sum + item.text.length, 0) +
        segments.reduce((sum, item) => sum + item.text.length, 0);
      if (chars > this.options.maxTranscriptChars) {
        throw Error('History limit reached. Stop and start a new session.');
      }
      let changed = 0;
      while (changed < Math.min(state.segments.length, segments.length) &&
        state.segments[changed] === segments[changed]) changed++;
      const from = state.offset + changed;
      state.text = text; state.speaker = speaker; state.segments = segments;
      const pending = difference(state.sent, segments);
      this._pendingChars += pending - state.pending; state.pending = pending;
      this.transcriptChars = chars;
      this._matching = Math.min(this._matching, from);
      this._sourceFrom = Math.min(this._sourceFrom, from);
      this._translationFrom = Math.min(this._translationFrom, from);
      this._document = null;
      this.dirtySince ??= now;
      return true;
    }
    get document() {
      // Rebuild once after a scan's updates, only when the document is actually read.
      if (!this._document) {
        this._document = [];
        for (const state of this.states.values()) {
          state.offset = this._document.length;
          for (const segment of state.segments) this._document.push(segment);
        }
      }
      return this._document;
    }
    get pendingChars() {
      return this._pendingChars;
    }
    setSent(document) {
      this.sentDocument = document;
      const byKey = new Map();
      for (const item of document) {
        const key = item.id.slice(0, item.id.lastIndexOf(':'));
        if (!byKey.has(key)) byKey.set(key, []);
        byKey.get(key).push(item);
      }
      this._pendingChars = 0;
      for (const [key, state] of this.states) {
        state.sent = byKey.get(key) || [];
        state.pending = difference(state.sent, state.segments);
        this._pendingChars += state.pending;
      }
    }
    get matching() {
      const document = this.document;
      while (this._matching < Math.min(document.length, this.translated.length) &&
        same(document[this._matching], this.translated[this._matching])) this._matching++;
      return this._matching;
    }
    get outdated() {
      return this.document.length !== this.translated.length || this.matching !== this.document.length;
    }
    usable(snapshot, count = snapshot.window.segments.length) {
      return Math.min(usablePrefix(snapshot.document, this.document), snapshot.start + count);
    }
    preview(snapshot, results) {
      if (!results.length || results.length > snapshot.window.segments.length || results.some((item, i) =>
        item.id !== snapshot.window.segments[i].id || typeof item.text !== 'string' || !item.text.trim())) {
        throw Error('Invalid progressive translation anchors.');
      }
      this._preview = { snapshot, segments: results.map((item, i) =>
        ({ ...snapshot.window.segments[i], translation: item.text })) };
      this._translationFrom = Math.min(this._translationFrom, snapshot.start);
      return this.usable(snapshot, results.length) > snapshot.first;
    }
    clearPreview() {
      if (this._preview) this._translationFrom = Math.min(this._translationFrom, this._preview.snapshot.start);
      this._preview = null;
    }
    display() {
      let end = this.matching;
      const old = this.translated[end], fresh = this.document[end];
      if (end === this.translated.length - 1 && old?.id === fresh?.id && old.speaker === fresh.speaker &&
        fresh.text.startsWith(old.text)) end++;
      let visible = this.translated.slice(0, end);
      if (this._preview) {
        const { snapshot, segments } = this._preview;
        const upto = this.usable(snapshot, segments.length);
        if (upto > snapshot.start) visible = visible.slice(0, snapshot.start)
          .concat(segments.slice(0, upto - snapshot.start), visible.slice(upto));
      }
      return visible;
    }
    presentation() {
      const result = { source: this.document, translation: this.display(),
        sourceFrom: this._sourceFrom, translationFrom: this._translationFrom };
      this._sourceFrom = this._translationFrom = Infinity;
      return result;
    }
    view() {
      // Hide known-stale text immediately, including after Stop or while a request runs.
      const visible = this.display();
      return { source: paragraphs(this.document), translation: paragraphs(visible, 'translation'),
        outdated: this.outdated };
    }
    schedule(now) {
      // One pending slot, referencing the live document rather than a frozen snapshot.
      // Return milliseconds until ready (Infinity if idle); latch readiness until sent or cancelled.
      const amount = this.dirtySince === null || !this.outdated ? 0 : this.pendingChars;
      if (amount === 0) {
        this.queuedReason = null;
        return Infinity;
      }
      const options = this.options;
      const start = Number.isFinite(this.lastDispatch) ? this.lastDispatch : this.dirtySince;
      const wait = Math.max(0, this.lastDispatch + options.minDispatchMs - now,
        this.queuedReason || amount >= options.newChars ? 0 : start + options.intervalMs - now);
      if (wait === 0) this.queuedReason ??= amount >= options.newChars ? 'volume' : 'time';
      return wait;
    }
    take(now) {
      const options = this.options;
      if (this.dirtySince === null) return null;
      // First changed/new source sentence relative to the last displayed translation.
      const first = this.matching;
      if (first === this.document.length && first === this.translated.length) {
        // ASR can correct A -> B -> A. Don't request a translation already on screen.
        this.setSent(this.document); this.dirtySince = null; this.queuedReason = null; return null;
      }
      if (this.schedule(now) > 0) return null;
      const start = Math.max(0, first - options.overlap);
      if (!this.document.length) {
        this.translated = []; this.setSent([]); this.dirtySince = null; this.queuedReason = null; return null;
      }
      let end = start, chars = 0;
      const overlapChars = this.document.slice(start, first).reduce((sum, item) => sum + item.text.length, 0);
      const budget = Math.max(options.targetWindowChars, overlapChars + Math.min(2000, options.targetWindowChars));
      while (end < this.document.length && end - start < options.maxSegments) {
        const length = this.document[end].text.length;
        if (chars + length > options.maxWindowChars) break;
        // Soft latency budget: retain the full overlap and at least one changed anchor.
        // A whole indivisible phrase may exceed this; the hard safety limit still applies.
        if (end > first && chars + length > budget) break;
        chars += length; end++;
      }
      // Never truncate a long/incomplete sentence, nor silently drop the required overlap.
      if (end === start || (end <= first && first < this.document.length)) {
        throw Error('A sentence or overlap is too long. Translation stopped without truncating text.');
      }
      const context = this.document.slice(Math.max(0, start - 10), start);
      while (context.reduce((sum, item) => sum + item.text.length, 0) > 6000) context.shift();
      const previous = []; let previousChars = 0;
      for (let i = Math.min(end, this.translated.length, first) - 1; i >= Math.max(0, start - 10); i--) {
        const item = this.translated[i];
        if (!same(item, this.document[i])) continue;
        if (previousChars + item.translation.length > 6000) break;
        previous.unshift({ id: item.id, text: item.translation }); previousChars += item.translation.length;
        if (previous.length === 20) break;
      }
      // References outside the bounded source context are not meaningful to the model.
      const known = new Set([...context, ...this.document.slice(start, end)].map(item => item.id));
      const snapshot = { start, first, sourceSince: this.dirtySince, document: this.document.slice(0, end),
        window: { id: `window-${++this.counter}`, segments: this.document.slice(start, end) },
        context, previous: previous.filter(item => known.has(item.id)), reason: this.queuedReason };
      this.setSent(snapshot.document);
      this.lastDispatch = now;
      this.queuedReason = null;
      // A large imported history can need several whole-sentence windows; don't lose its remainder.
      this.dirtySince = end < this.document.length ? now : null;
      return snapshot;
    }
    accept(snapshot, results) {
      this.clearPreview();
      if (results.length !== snapshot.window.segments.length) throw Error('Incorrect number of translation segments.');
      const byId = new Map(results.map(item => [item.id, item.text]));
      if (byId.size !== results.length || snapshot.window.segments.some(item =>
        typeof byId.get(item.id) !== 'string' || !byId.get(item.id).trim())) throw Error('Invalid translation segment IDs.');
      // A tail correction must not discard the unaffected prefix of the whole dialogue.
      // Stop at the first mismatch: later anchors can shift when ASR changes punctuation.
      const end = usablePrefix(snapshot.document, this.document);
      if (end <= snapshot.start) return false;
      const usable = snapshot.window.segments.slice(0, end - snapshot.start);
      this.translated = this.translated.slice(0, snapshot.start).concat(usable.map(item =>
        ({ ...item, translation: byId.get(item.id) })));
      this._matching = Math.min(this._matching, snapshot.start);
      this._translationFrom = Math.min(this._translationFrom, snapshot.start);
      return true;
    }
  }
  const api = { normalize, sentences, phrases, changedChars, paragraphs, Tracker, DEFAULTS, TARGET_LANGUAGES };
  if (typeof module !== 'undefined') module.exports = api;
  else globalThis.MeetCaptions = api;
})();
