/* Sentence anchors are only for replacing a translated tail, never separate requests. */
(() => {
  const normalize = value => value.replace(/\s+/gu, ' ').trim();
  const TARGET_LANGUAGES = Object.freeze({ ru: 'Russian', en: 'English', ja: 'Japanese',
    de: 'German', fr: 'French', es: 'Spanish', pt: 'Portuguese', it: 'Italian',
    zh: 'Chinese', ko: 'Korean', uk: 'Ukrainian', ar: 'Arabic' });
  const DEFAULTS = Object.freeze({ intervalMs: 4000, newChars: 500, overlap: 10, targetLanguage: 'ru',
    minDispatchMs: 1000, maxWindowChars: 48000, maxSegments: 512, maxTranscriptChars: 1000000 });
  // Use the runtime's Unicode sentence rules; the source is not restricted to Japanese.
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'sentence' });
  const sentences = text => [...segmenter.segment(text)].map(item => item.segment.trim()).filter(Boolean);
  const same = (a, b) => a?.id === b?.id && a?.speaker === b?.speaker && a?.text === b?.text;
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
      this.counter = 0;
    }
    seed(key, speaker, raw) {
      this.states.set(key, { speaker, baseline: normalize(raw), text: '', segments: [] });
    }
    update(key, speaker, raw, now) {
      let state = this.states.get(key);
      if (!state) { state = { speaker, baseline: '', text: '', segments: [] }; this.states.set(key, state); }
      const normalized = normalize(raw);
      const text = normalized.slice(Math.min(state.baseline.length, normalized.length)).trim();
      if (text === state.text && speaker === state.speaker) return false;
      const segments = sentences(text).map((text, index) => ({ id: `${key}:${index}`, speaker, text }));
      const chars = this.transcriptChars - state.segments.reduce((sum, item) => sum + item.text.length, 0) +
        segments.reduce((sum, item) => sum + item.text.length, 0);
      if (chars > this.options.maxTranscriptChars) {
        throw Error('History limit reached. Stop and start a new session.');
      }
      state.text = text; state.speaker = speaker; state.segments = segments;
      this.transcriptChars = chars;
      this._document = null;
      this.dirtySince ??= now;
      return true;
    }
    get document() {
      // Rebuild once after a scan's updates, only when the document is actually read.
      return this._document ??= [...this.states.values()].flatMap(state => state.segments);
    }
    get pendingChars() {
      const old = new Map(this.sentDocument.map(item => [item.id, item]));
      let amount = 0;
      for (const item of this.document) {
        const previous = old.get(item.id);
        amount += previous?.speaker === item.speaker ? changedChars(previous.text, item.text) : item.text.length;
        old.delete(item.id);
      }
      return amount + [...old.values()].reduce((sum, item) => sum + item.text.length, 0);
    }
    get outdated() {
      return this.document.length !== this.translated.length ||
        this.document.some((item, index) => !same(item, this.translated[index]));
    }
    view() {
      return { source: paragraphs(this.document), translation: paragraphs(this.translated, 'translation'),
        outdated: this.outdated };
    }
    take(now) {
      const options = this.options;
      if (this.dirtySince === null) return null;
      // First changed/new source sentence relative to the last displayed translation.
      let first = 0;
      while (first < this.document.length && same(this.document[first], this.translated[first])) first++;
      if (first === this.document.length && first === this.translated.length) {
        // ASR can correct A -> B -> A. Don't request a translation already on screen.
        this.sentDocument = this.document; this.dirtySince = null; return null;
      }
      if (now - this.lastDispatch < options.minDispatchMs) return null;
      const amount = this.pendingChars;
      const timed = now - this.dirtySince >= options.intervalMs;
      if (!timed && amount < options.newChars) return null;
      const start = Math.max(0, first - options.overlap);
      if (!this.document.length) {
        this.translated = []; this.sentDocument = []; this.dirtySince = null; return null;
      }
      let end = start, chars = 0;
      while (end < this.document.length && end - start < options.maxSegments) {
        const length = this.document[end].text.length;
        if (chars + length > options.maxWindowChars) break;
        chars += length; end++;
      }
      // Never truncate a long/incomplete sentence, nor silently drop the required overlap.
      if (end === start || (end <= first && first < this.document.length)) {
        throw Error('A sentence or overlap is too long. Translation stopped without truncating text.');
      }
      const context = this.document.slice(Math.max(0, start - 10), start);
      while (context.reduce((sum, item) => sum + item.text.length, 0) > 6000) context.shift();
      const snapshot = { start, document: this.document.slice(0, end),
        window: { id: `window-${++this.counter}`, segments: this.document.slice(start, end) },
        context, reason: amount >= options.newChars ? 'volume' : 'time' };
      this.sentDocument = snapshot.document;
      this.lastDispatch = now;
      // A large imported history can need several whole-sentence windows; don't lose its remainder.
      this.dirtySince = end < this.document.length ? now : null;
      return snapshot;
    }
    accept(snapshot, results) {
      const old = snapshot.document, fresh = this.document;
      // Only pure additions may yield a provisional result while speech continues.
      // Any correction/deletion in the request's source invalidates its returned text.
      if (old.length > fresh.length || !old.every((item, index) => {
        const current = fresh[index];
        return same(item, current) || (index === old.length - 1 && item.id === current?.id &&
          item.speaker === current.speaker && current.text.startsWith(item.text));
      })) return false;
      if (results.length !== snapshot.window.segments.length) throw Error('Incorrect number of translation segments.');
      const byId = new Map(results.map(item => [item.id, item.text]));
      if (byId.size !== results.length || snapshot.window.segments.some(item =>
        typeof byId.get(item.id) !== 'string' || !byId.get(item.id).trim())) throw Error('Invalid translation segment IDs.');
      this.translated = this.translated.slice(0, snapshot.start).concat(snapshot.window.segments.map(item =>
        ({ ...item, translation: byId.get(item.id) })));
      return true;
    }
  }
  const api = { normalize, sentences, changedChars, paragraphs, Tracker, DEFAULTS, TARGET_LANGUAGES };
  if (typeof module !== 'undefined') module.exports = api;
  else globalThis.MeetCaptions = api;
})();
