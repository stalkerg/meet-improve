const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Tracker, sentences, normalize, changedChars, DEFAULTS, TARGET_LANGUAGES } = require('../captions.js');
const reply = (snapshot, prefix = 'RU') => snapshot.window.segments.map(s => ({ id: s.id, text: `${prefix}(${s.text})` }));
const fixture = n => Array.from({ length: n }, (_, i) => `文章${i}です。`).join('');
const fast = options => new Tracker({ newChars: 1, minDispatchMs: 0, ...options });

test('sentence anchors do not cut long phrases or decimals', () => {
  assert.equal(normalize(' はい。 \n  次です。 '), 'はい。 次です。');
  assert.equal(sentences('あ'.repeat(5000)).length, 1);
  assert.equal(sentences('設定値は1.25です。次です。').length, 2);
});
test('target language defaults to Russian without restricting source language', () => {
  assert.equal(DEFAULTS.targetLanguage, 'ru');
  assert.ok(Object.hasOwn(TARGET_LANGUAGES, DEFAULTS.targetLanguage));
  for (const text of ['Hello. Next sentence.', 'Привет. Следующее предложение.', 'こんにちは。次です。', '你好。下一句。']) {
    assert.equal(sentences(text).length, 2);
    const t = fast(); t.update('1', 'A', text, 0);
    assert.equal(t.take(0).window.segments.length, 2);
  }
});
test('default time trigger fires at four seconds, but not earlier', () => {
  const t = new Tracker(); t.update('1', 'A', 'はい。', 0);
  assert.equal(t.take(3999), null);
  const s = t.take(4000); assert.equal(s.reason, 'time');
  t.accept(s, reply(s)); assert.equal(t.take(30000), null);
});
test('volume trigger does not wait for the time trigger', () => {
  const t = new Tracker(); t.update('1', 'A', 'あ'.repeat(501), 0);
  const s = t.take(50); assert.equal(s.reason, 'volume'); assert.equal(s.window.segments[0].text.length, 501);
});
test('several speakers accumulated into one contextual request', () => {
  const t = new Tracker();
  t.update('1', 'A', '質問です。', 0); t.update('2', 'B', '答えです。', 1000);
  assert.equal(t.take(2000), null);
  assert.deepEqual(t.take(4000).window.segments.map(s => s.speaker), ['A', 'B']);
});
test('baseline is excluded, ongoing baseline utterance adds only new text', () => {
  const t = fast(); t.seed('1', 'A', '以前の発言。');
  assert.equal(t.take(2000), null);
  t.update('1', 'A', '以前の発言。新しい発言。', 3000);
  assert.equal(t.take(3000).window.segments[0].text, '新しい発言。');
});
for (const overlap of [5, 10]) test(`overlap ${overlap} replaces tail and preserves prefix`, () => {
  const t = fast({ overlap }); t.update('1', 'A', fixture(25), 0);
  const first = t.take(0); t.accept(first, reply(first, 'OLD'));
  const before = t.translated.map(x => x.translation);
  t.update('1', 'A', fixture(25) + '追加です。', 2000);
  const second = t.take(2000);
  assert.equal(second.start, 25-overlap);
  assert.equal(second.window.segments.length, overlap+1);
  t.accept(second, reply(second, 'NEW'));
  assert.equal(t.translated.length, 26);
  assert.deepEqual(t.translated.slice(0, 25-overlap).map(x => x.translation), before.slice(0, 25-overlap));
  assert.ok(t.translated.slice(25-overlap).every(x => x.translation.startsWith('NEW')));
  assert.equal(t.outdated, false);
});
test('ongoing unfinished phrase is retranslated whole with previous sentences', () => {
  const t = fast(); t.update('1', 'A', fixture(12)+'途中', 0);
  const first = t.take(0); t.accept(first, reply(first));
  t.update('1', 'A', fixture(12)+'途中'+'あ'.repeat(2000), 2000);
  const second = t.take(2000);
  assert.equal(second.start, 2);
  assert.equal(second.window.segments.at(-1).text.length, 2002);
  assert.equal(second.window.segments.length, 11);
});
test('correction earlier than ordinary overlap expands replacement window', () => {
  const t = fast(); t.update('1', 'A', fixture(25), 0);
  const first = t.take(0); t.accept(first, reply(first));
  t.update('1', 'A', fixture(25).replace('文章2です', '修正です'), 2000);
  assert.equal(t.take(2000).start, 0);
});
test('in-flight obsolete correction rejected; latest changes coalesced', () => {
  const t = fast(); t.update('1', 'A', '古い文。', 0);
  const first = t.take(0);
  t.update('1', 'A', '途中の修正。', 2000); t.update('1', 'A', '正しい文。', 2100);
  assert.equal(t.accept(first, reply(first)), false);
  const latest = t.take(2200); assert.equal(latest.window.segments[0].text, '正しい文。');
  t.accept(latest, reply(latest)); assert.equal(t.outdated, false);
});
test('pure additions during generation allow provisional result, then catch up', () => {
  const t = fast(); t.update('1', 'A', '始まり', 0); const first = t.take(0);
  t.update('1', 'A', '始まりです。次です。', 2000);
  assert.equal(t.accept(first, reply(first)), true); assert.equal(t.outdated, true);
  const second = t.take(3000); t.accept(second, reply(second));
  assert.equal(t.translated.length, 2); assert.equal(t.outdated, false);
});
test('deleted tail is removed rather than appended or left behind', () => {
  const t = fast(); t.update('1', 'A', fixture(12), 0);
  const s = t.take(0); t.accept(s, reply(s));
  t.update('1', 'A', fixture(10), 2000);
  const next = t.take(2000); t.accept(next, reply(next)); assert.equal(t.translated.length, 10);
});
test('punctuation corrections re-anchor following sentences without duplicates', () => {
  const t = fast(); t.update('1', 'A', '一。二。三。', 0); const a = t.take(0); t.accept(a, reply(a));
  t.update('1', 'A', '一と二。三。', 2000); const b = t.take(2000); t.accept(b, reply(b));
  assert.equal(t.translated.length, 2); assert.equal(t.outdated, false);
});
test('repeated identical utterances remain distinct', () => {
  const t = fast(); t.update('1', 'A', 'はい。', 0); t.update('2', 'A', 'はい。', 0);
  assert.deepEqual(t.take(0).window.segments.map(s=>s.id), ['1:0', '2:0']);
});
test('late text in empty placeholder retains original chronology', () => {
  const t = fast(); t.update('1', 'A', '', 0); t.update('2', 'B', '二。', 0);
  t.update('1', 'A', '一。', 1000);
  assert.deepEqual(t.take(1000).window.segments.map(s=>s.id), ['1:0','2:0']);
});
test('large history drains in whole-sentence windows', () => {
  const t = fast({ maxWindowChars: 100, overlap: 5 });
  t.update('1', 'A', fixture(40), 0);
  let now=0, iterations=0;
  while (t.outdated && iterations++ < 20) { const s=t.take(now++); assert.ok(s); t.accept(s,reply(s)); }
  assert.equal(t.outdated, false); assert.equal(t.translated.length, 40);
});
test('a too-long sentence stops instead of cutting content', () => {
  const t = fast({ maxWindowChars: 100 }); t.update('1','A','あ'.repeat(101),0);
  assert.throws(()=>t.take(0), /без обрезки/);
});
test('changed character count counts additions/corrections, not entire transcript', () => {
  assert.equal(changedChars('abcd', 'abcdef'), 2);
  assert.equal(changedChars('abcdef', 'abXdef'), 1);
  const t=fast(); t.update('1','A',fixture(20),0);const s=t.take(0);t.accept(s,reply(s));
  t.update('1','A',fixture(20)+'次。',2000);assert.equal(t.pendingChars,2);
});
test('request rate is bounded even for large incoming changes', () => {
  const t = new Tracker({newChars:1});t.update('1','A','一。',0);const s=t.take(0);t.accept(s,reply(s));
  t.update('1','A','一。二。',10);assert.equal(t.take(20),null);assert.ok(t.take(1000));
});

test('reverted ASR correction does not retranslate an already current source', () => {
  const t = new Tracker(); t.update('1', 'A', '確定した文章です。', 0);
  const first = t.take(4000); t.accept(first, reply(first));
  const translated = t.translated;
  t.update('1', 'A', '一時的な修正です。', 5000);
  t.update('1', 'A', '確定した文章です。', 5200);
  assert.equal(t.pendingChars, 0); assert.equal(t.outdated, false);
  assert.equal(t.take(9000), null);
  assert.equal(t.dirtySince, null);
  assert.strictEqual(t.translated, translated);
  // A later real change gets a fresh timer, not the cancelled correction's deadline.
  t.update('1', 'A', '確定した文章です。次です。', 10000);
  assert.equal(t.take(13999), null); assert.ok(t.take(14000));
});

test('correction reverted during a request resets the sent-source baseline', () => {
  const t = fast(); t.update('1', 'A', '一。', 0);
  const first = t.take(0); t.accept(first, reply(first));
  t.update('1', 'A', '一時的な長い修正です。', 1000);
  const correction = t.take(1000);
  t.update('1', 'A', '一。', 1100);
  assert.equal(t.accept(correction, reply(correction)), false);
  assert.equal(t.take(1200), null);
  assert.equal(t.pendingChars, 0);
  t.update('1', 'A', '一。二。', 2000);
  assert.equal(t.pendingChars, 2); assert.ok(t.take(2000));
});

test('reverted in-flight edits do not cause another request after accepting the original', () => {
  const t = fast(); t.update('1', 'A', '一。', 0);
  const first = t.take(0);
  t.update('1', 'A', '二。', 1000); t.update('1', 'A', '一。', 1100);
  assert.equal(t.accept(first, reply(first)), true);
  assert.equal(t.take(10000), null); assert.equal(t.outdated, false);
});

test('history is segmented once per changed utterance and document is cached', () => {
  const original = Intl.Segmenter.prototype.segment;
  let calls = 0;
  Intl.Segmenter.prototype.segment = function(text) { calls++; return original.call(this, text); };
  try {
    const t = fast();
    for (let i = 0; i < 100; i++) t.update(String(i), 'A', '一。二。', 0);
    assert.equal(calls, 100);
    const before = t.document;
    assert.equal(before.length, 200); assert.strictEqual(t.document, before);
    assert.equal(t.update('99', 'A', '一。二。', 1), false);
    assert.strictEqual(t.document, before); assert.equal(calls, 100);
    t.update('99', 'A', '一。二。三。', 2);
    assert.equal(calls, 101);
    const after = t.document;
    assert.notStrictEqual(after, before); assert.strictEqual(t.document, after);
    assert.strictEqual(after[0], before[0]); assert.equal(after.length, 201);
    assert.equal(before.length, 200); // Existing snapshots must remain immutable.
  } finally { Intl.Segmenter.prototype.segment = original; }
});

test('cached segments track speaker changes without mutating request snapshots', () => {
  const t = fast(); t.update('1', 'A', '一。二。', 0);
  const first = t.take(0);
  t.update('1', 'B', '一。二。', 1000);
  assert.ok(first.window.segments.every(s => s.speaker === 'A'));
  assert.ok(t.document.every(s => s.speaker === 'B'));
  assert.equal(t.accept(first, reply(first)), false);
  const next = t.take(1000); t.accept(next, reply(next));
  assert.equal(t.outdated, false);
});

test('history character limit accounts for edits, deletions and skipped baseline', () => {
  const t = fast({ maxTranscriptChars: 6 });
  t.seed('0', 'A', '以前の長い文章です。');
  t.update('0', 'A', '以前の長い文章です。一。', 0);
  t.update('1', 'A', '二。', 0); t.update('2', 'A', '三。', 0);
  assert.throws(() => t.update('3', 'A', '四。', 1), /лимит истории/);
  assert.equal(t.document.length, 3);
  t.update('1', 'A', '', 2); t.update('3', 'A', '四。', 2);
  assert.equal(t.document.length, 3);
  assert.throws(() => t.update('2', 'A', '三。長い追記。', 3), /лимит истории/);
  assert.equal(t.document.find(s => s.id === '2:0').text, '三。');
});
