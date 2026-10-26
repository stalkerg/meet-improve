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

test('tail corrections retain the translated prefix instead of discarding the whole response', () => {
  const t = fast();
  t.update('1', 'A', 'The first sentence is stable. The price is fifteen.', 0);
  const first = t.take(0);
  t.update('1', 'A', 'The first sentence is stable. The price is fifty.', 2000);
  assert.equal(t.accept(first, reply(first)), true);
  assert.deepEqual(t.translated.map(x => x.text), ['The first sentence is stable.']);
  assert.equal(t.outdated, true);
  assert.doesNotMatch(t.view().translation, /fifteen|fifty/);
  const next = t.take(3000);
  assert.equal(next.window.segments.at(-1).text, 'The price is fifty.');
  t.accept(next, reply(next));
  assert.equal(t.outdated, false);
  assert.match(t.view().translation, /fifty/);
});

test('punctuation resegmentation stops at the mismatch without attaching shifted suffix IDs', () => {
  const t = fast();
  t.update('1', 'A', 'Stable. First clause and second clause. Final sentence.', 0);
  const first = t.take(0);
  t.update('1', 'A', 'Stable. First clause. And second clause. Final sentence.', 1000);
  assert.equal(t.accept(first, reply(first)), true);
  assert.deepEqual(t.translated.map(x => x.text), ['Stable.']);
  const next = t.take(2000); t.accept(next, reply(next));
  assert.equal(t.translated.length, 4);
  assert.equal(t.outdated, false);
});

test('existing corrected translations are hidden immediately while the replacement is pending', () => {
  const t = fast();
  t.update('1', 'A', 'Stable. Delete the backup. Last sentence.', 0);
  const first = t.take(0); t.accept(first, reply(first));
  t.update('1', 'A', 'Stable. Do not delete the backup. Last sentence.', 1000);
  assert.equal(t.view().translation, 'A: RU(Stable.)');
  assert.equal(t.view().outdated, true);
  // Merely rendering must not change the snapshot used to detect the correction.
  assert.equal(t.translated.length, 3);
  const next = t.take(2000); t.accept(next, reply(next));
  assert.match(t.view().translation, /Do not delete/);
});

test('a deleted in-flight tail keeps only the surviving prefix', () => {
  const t = fast(); t.update('1', 'A', 'Stable. Removed.', 0);
  const first = t.take(0); t.update('1', 'A', 'Stable.', 1000);
  assert.equal(t.accept(first, reply(first)), true);
  assert.equal(t.translated.length, 1);
  assert.equal(t.outdated, false);
  assert.equal(t.take(2000), null);
});

test('speaker corrections do not misattribute the retained translation', () => {
  const t = fast(); t.update('1', 'A', 'Stable.', 0); t.update('2', 'B', 'A reply.', 0);
  const first = t.take(0); t.update('2', 'C', 'A reply.', 1000);
  assert.equal(t.accept(first, reply(first)), true);
  assert.equal(t.view().translation, 'A: RU(Stable.)');
  const next = t.take(2000); t.accept(next, reply(next));
  assert.match(t.view().translation, /C: RU\(A reply\.\)/);
});

test('partial overlap replacement preserves the older prefix and resumes from the missing tail', () => {
  const t = fast({ overlap: 5 }); t.update('1', 'A', fixture(25), 0);
  const first = t.take(0); t.accept(first, reply(first, 'OLD'));
  t.update('1', 'A', fixture(25) + 'Draft.', 1000);
  const second = t.take(1000); assert.equal(second.start, 20);
  t.update('1', 'A', fixture(25) + 'Corrected.', 2000);
  assert.equal(t.accept(second, reply(second, 'NEW')), true);
  assert.ok(t.translated.slice(0, 20).every(x => x.translation.startsWith('OLD')));
  assert.ok(t.translated.slice(20).every(x => x.translation.startsWith('NEW')));
  assert.equal(t.translated.length, 25);
  const third = t.take(3000); assert.equal(third.start, 20);
  assert.equal(third.window.segments.at(-1).text, 'Corrected.');
});

test('a correction before the requested window rejects its result and expands the next window', () => {
  const t = fast({ overlap: 5 }); t.update('1', 'A', fixture(25), 0);
  const first = t.take(0); t.accept(first, reply(first));
  t.update('1', 'A', fixture(25) + 'New.', 1000); const second = t.take(1000);
  t.update('1', 'A', (fixture(25) + 'New.').replace('文章2です', '修正です'), 2000);
  assert.equal(t.accept(second, reply(second)), false);
  assert.equal(t.view().translation, 'A: RU(文章0です。) RU(文章1です。)');
  assert.equal(t.take(3000).start, 0);
});

test('partial acceptance still validates every result anchor', () => {
  const t = fast(); t.update('1', 'A', 'Stable. Old.', 0);
  const first = t.take(0); t.update('1', 'A', 'Stable. Corrected.', 1000);
  assert.throws(() => t.accept(first, reply(first).slice(0, 1)), /number/);
  const bad = reply(first); bad[1].id = bad[0].id;
  assert.throws(() => t.accept(first, bad), /IDs/);
  assert.equal(t.translated.length, 0);
});

test('continuous character updates do not debounce the four-second deadline', () => {
  const t = new Tracker();
  for (let now = 0; now < 4000; now += 200) {
    t.update('1', 'A', 'word '.repeat(now / 200 + 1), now);
    assert.equal(t.dirtySince, 0);
    assert.equal(t.take(now), null);
  }
  assert.ok(t.take(4000)); assert.equal(t.dirtySince, null);
});

test('in-flight additions keep their deadline and dispatch as soon as the request completes', () => {
  const t = new Tracker(); t.update('1', 'A', 'We are discussing', 0);
  const first = t.take(4000);
  t.update('1', 'A', 'We are discussing the plan', 4500);
  t.update('1', 'A', 'We are discussing the plan and next steps.', 11000);
  assert.equal(t.accept(first, reply(first)), true);
  assert.equal(t.dirtySince, 4500);
  assert.ok(t.take(12000)); // No extra four-second wait after completion.
});

test('late additions are due immediately once the dispatch interval has elapsed', () => {
  const t = new Tracker(); t.update('1', 'A', 'We are discussing', 0);
  const first = t.take(4000);
  t.update('1', 'A', 'We are discussing the plan.', 11500);
  t.accept(first, reply(first));
  assert.equal(t.schedule(11500), 0);
  assert.ok(t.take(12000));
});

test('the first deadline starts with speech, not with session startup', () => {
  const t = new Tracker();
  assert.equal(t.schedule(60000), Infinity);
  t.update('1', 'A', 'A short utterance.', 60000);
  assert.equal(t.schedule(60000), 4000);
  assert.equal(t.take(63999), null);
  assert.ok(t.take(64000));
});

test('subsequent deadlines start at dispatch, not at the next change or response', () => {
  const t = new Tracker(); t.update('1', 'A', 'First.', 0);
  const first = t.take(4000);
  t.update('2', 'B', 'Second.', 7000);
  assert.equal(t.schedule(7000), 1000);
  assert.equal(t.schedule(7999), 1);
  assert.equal(t.queuedReason, null);
  assert.equal(t.schedule(8000), 0);
  assert.equal(t.queuedReason, 'time');
  assert.equal(t.lastDispatch, 4000); // Becoming queued is not a dispatch.
  t.accept(first, reply(first));
  const second = t.take(10000); assert.ok(second);
  t.update('3', 'A', 'Third.', 10001);
  assert.equal(t.schedule(10001), 3999); // Next deadline is 14 s, not 12 s.
  assert.equal(t.take(13999), null);
  assert.ok(t.take(14000));
});

test('a fast response neither resets the deadline nor causes immediate duplicate work', () => {
  const t = new Tracker(); t.update('1', 'A', 'First.', 0);
  const first = t.take(4000); t.accept(first, reply(first));
  assert.equal(t.schedule(4500), Infinity);
  t.update('2', 'B', 'Second.', 6000);
  assert.equal(t.schedule(6000), 2000);
  assert.equal(t.take(7999), null);
  assert.ok(t.take(8000));
});

test('one queued update coalesces a long-running request into the freshest contextual window', () => {
  const t = new Tracker({ overlap: 5 }); t.update('1', 'A', fixture(25), 0);
  const first = t.take(4000);
  for (let now = 7000; now <= 19000; now += 1000) {
    t.update('2', 'B', `The latest revision is ${now}.`, now);
    assert.equal(t.schedule(now), Math.max(0, 8000 - now));
    assert.equal(t.counter, 1); // No request snapshots built while the first one runs.
    assert.equal(t.lastDispatch, 4000);
  }
  t.accept(first, reply(first));
  const next = t.take(20000);
  assert.equal(next.start, 20); // Compute overlap AFTER accepting the first result.
  assert.equal(next.window.segments.length, 6);
  assert.equal(next.window.segments.at(-1).text, 'The latest revision is 19000.');
  assert.equal(t.counter, 2);
  assert.equal(t.queuedReason, null);
  assert.equal(t.schedule(24000), Infinity); // No unchanged duplicate queued during request 2.
  t.accept(next, reply(next));
  assert.equal(t.take(30000), null);
  assert.equal(t.outdated, false);
});

test('an early volume trigger stays queued while smaller ASR corrections replace its text', () => {
  const t = new Tracker(); t.update('1', 'A', 'First.', 0);
  const first = t.take(4000);
  t.update('2', 'B', 'x'.repeat(501), 4100);
  assert.equal(t.schedule(4100), 900); // Still respect the one-second dispatch guard.
  assert.equal(t.schedule(5000), 0);
  assert.equal(t.queuedReason, 'volume');
  t.update('2', 'B', 'Corrected short utterance.', 5100);
  assert.equal(t.schedule(5100), 0);
  t.accept(first, reply(first));
  const next = t.take(5500);
  assert.equal(next.reason, 'volume');
  assert.equal(next.window.segments.at(-1).text, 'Corrected short utterance.');
  t.update('3', 'A', 'Third.', 5600);
  assert.equal(t.schedule(5600), 3900); // Early dispatch also restarts the interval.
});

test('reverting to the in-flight source cancels the pending slot without a duplicate', () => {
  const t = new Tracker(); t.update('1', 'A', 'Original.', 0);
  const first = t.take(4000);
  t.update('1', 'A', 'Temporary correction.', 7000);
  assert.equal(t.schedule(8000), 0);
  t.update('1', 'A', 'Original.', 9000);
  assert.equal(t.schedule(9000), Infinity);
  assert.equal(t.queuedReason, null);
  t.accept(first, reply(first));
  assert.equal(t.take(10000), null);
  assert.equal(t.counter, 1);
});

test('a queued correction that returns to the displayed translation needs no request', () => {
  const t = new Tracker(); t.update('1', 'A', 'Original.', 0);
  const first = t.take(4000); t.accept(first, reply(first));
  t.update('1', 'A', 'Correction.', 7000); const second = t.take(8000);
  t.update('1', 'A', 'Another correction.', 10000);
  assert.equal(t.schedule(12000), 0);
  t.update('1', 'A', 'Original.', 13000);
  assert.equal(t.schedule(13000), Infinity);
  assert.equal(t.queuedReason, null);
  assert.equal(t.accept(second, reply(second)), false);
  assert.equal(t.take(14000), null);
  assert.equal(t.lastDispatch, 8000);
});

test('silence never queues unchanged captions, before or after a response', () => {
  const t = new Tracker(); t.update('1', 'A', 'Short.', 0);
  const first = t.take(4000);
  for (const now of [8000, 12000, 30000]) {
    assert.equal(t.schedule(now), Infinity);
    assert.equal(t.take(now), null);
  }
  t.accept(first, reply(first));
  assert.equal(t.schedule(60000), Infinity);
  assert.equal(t.take(60000), null);
  t.update('2', 'B', 'After silence.', 60001);
  assert.ok(t.take(60001));
});

test('a queued full deletion clears the translation without sending an empty window', () => {
  const t = new Tracker(); t.update('1', 'A', 'Original.', 0);
  const first = t.take(4000); t.accept(first, reply(first));
  t.update('1', 'A', 'Correction.', 7000); const second = t.take(8000);
  t.update('1', 'A', '', 9000);
  assert.equal(t.schedule(12000), 0);
  assert.equal(t.accept(second, reply(second)), false);
  assert.equal(t.take(13000), null);
  assert.equal(t.queuedReason, null);
  assert.equal(t.schedule(13000), Infinity);
  assert.equal(t.outdated, false);
  assert.equal(t.counter, 2);
});

test('repeated in-flight revisions no longer starve the stable translated prefix', () => {
  const t = new Tracker();
  t.update('1', 'A', 'This first sentence is stable.', 0);
  t.update('2', 'B', 'We agreed the price is fifteen', 0);
  let snapshot = t.take(4000);
  const revisions = ['We agreed, the price is fifteen', 'We agreed, the price is fifty', 'We agreed the price is fifty'];
  for (let i = 0; i < revisions.length; i++) {
    t.update('2', 'B', revisions[i], 5000 + i * 8000);
    assert.equal(t.accept(snapshot, reply(snapshot)), true);
    assert.equal(t.view().translation, 'A: RU(This first sentence is stable.)');
    snapshot = t.take(12000 + i * 8000); assert.ok(snapshot);
  }
  t.accept(snapshot, reply(snapshot));
  assert.match(t.view().translation, /fifty/); assert.equal(t.outdated, false);
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
  assert.throws(()=>t.take(0), /without truncating/);
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
  // A cancelled correction must not restart the interval from the last actual dispatch.
  t.update('1', 'A', '確定した文章です。次です。', 10000);
  assert.ok(t.take(10000));
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
  assert.throws(() => t.update('3', 'A', '四。', 1), /History limit/);
  assert.equal(t.document.length, 3);
  t.update('1', 'A', '', 2); t.update('3', 'A', '四。', 2);
  assert.equal(t.document.length, 3);
  assert.throws(() => t.update('2', 'A', '三。長い追記。', 3), /History limit/);
  assert.equal(t.document.find(s => s.id === '2:0').text, '三。');
});
