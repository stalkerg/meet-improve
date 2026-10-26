const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Tracker, phrases, normalize, changedChars } = require('../captions.js');
const reply = (s, prefix = 'RU') => s.window.segments.map(x => ({ id: x.id, text: `${prefix}(${x.text})` }));
const fast = options => new Tracker({ newChars: 1, minDispatchMs: 0, ...options });
const drain = (t, now = 0) => {
  let count = 0;
  while (t.outdated && count++ < 100) {
    const s = t.take(now++); assert.ok(s); t.accept(s, reply(s));
  }
  assert.equal(t.outdated, false);
};

test('long speech uses whole clauses, preserving all text and decimal commas', () => {
  const text = ('we review the deployment details '.repeat(24) + ', ').repeat(25) + 'the final point';
  const chunks = phrases(text, 600);
  assert.ok(chunks.length > 20);
  assert.equal(normalize(chunks.join(' ')), normalize(text));
  assert.equal(phrases('word '.repeat(2000), 600).length, 1);
  assert.equal(phrases('1,25 '.repeat(2000), 600).length, 1);
  for (const punctuation of ['、', '，', '；', '：', '; ', ': ']) {
    const clause = 'あ'.repeat(601) + punctuation;
    assert.equal(phrases(clause + clause + '続き', 600).length, 3);
  }
});

test('growing clause speech reuses anchors and retranslates a bounded contextual tail', () => {
  const t = fast({ overlap: 5 });
  const clause = 'We review the deployment details '.repeat(24) + ', ';
  const text = clause.repeat(30);
  t.update('1', 'A', text, 0); drain(t);
  const before = t.document;
  t.update('1', 'A', text + clause, 1000);
  assert.strictEqual(t.document[0], before[0]);
  const s = t.take(1000);
  assert.equal(s.start, 25);
  assert.equal(s.window.segments.length, 6);
  assert.ok(s.window.segments.reduce((n,x) => n+x.text.length, 0) < text.length / 3);
  t.accept(s, reply(s)); assert.equal(t.outdated, false);
});

test('soft request budget drains history without dropping overlap or a large whole phrase', () => {
  const t = fast({ targetWindowChars: 100, overlap: 5 });
  const text = 'A reasonably long sentence. '.repeat(40);
  t.update('1', 'A', text, 0);
  const first = t.take(0);
  assert.ok(first.window.segments.reduce((n,x) => n+x.text.length, 0) <= 100);
  t.accept(first, reply(first));
  const second = t.take(1);
  assert.equal(second.start, 0);
  assert.ok(second.window.segments.length > first.window.segments.length); // Never overlap-only.
  t.accept(second, reply(second)); drain(t, 2);
  const whole = fast({ targetWindowChars: 100 });
  whole.update('1', 'A', 'あ'.repeat(10000), 0);
  assert.equal(whole.take(0).window.segments[0].text.length, 10000);
});

test('previous translations are bounded, source-matching and exclude corrected suffixes', () => {
  const t = fast();
  t.update('1', 'A', 'Stable. Old. Later unchanged.', 0); drain(t);
  t.update('1', 'A', 'Stable. Corrected. Later unchanged.', 1000);
  const s = t.take(1000);
  assert.deepEqual(s.previous, [{ id: '1:0', text: 'RU(Stable.)' }]);
  assert.ok(s.previous.every(x => [...s.context, ...s.window.segments].some(y => y.id === x.id)));
  const many = fast(); many.update('1', 'A', 'A sentence. '.repeat(100), 0); drain(many);
  many.update('2', 'B', 'New.', 1000);
  assert.equal(many.take(1000).previous.length, 20);
});

test('long previous translations never exceed the continuity budget', () => {
  const t = fast(); t.update('1', 'A', 'One. Two. Three.', 0);
  const s = t.take(0);
  t.accept(s, s.window.segments.map(x => ({ id: x.id, text: 'x'.repeat(4000) })));
  t.update('2', 'B', 'New.', 1);
  const next = t.take(1);
  assert.equal(next.previous.length, 1);
  assert.equal(next.previous[0].text.length, 4000);
});

test('progressive anchors are provisional, ordered and rolled back without committing', () => {
  const t = fast(); t.update('1', 'A', 'First. Second.', 0);
  const s = t.take(0);
  assert.equal(t.preview(s, reply(s).slice(0, 1)), true);
  assert.equal(t.translated.length, 0);
  assert.equal(t.view().translation, 'A: RU(First.)');
  t.clearPreview(); assert.equal(t.view().translation, '');
  for (const bad of [[], [reply(s)[1]], [{ id: '1:0', text: '' }], [...reply(s), reply(s)[0]]]) {
    assert.throws(() => t.preview(s, bad), /progressive/);
  }
  t.preview(s, reply(s)); t.accept(s, reply(s, 'FINAL'));
  assert.equal(t.view().translation, 'A: FINAL(First.) FINAL(Second.)');
});

test('source corrections hide provisional suffixes immediately and reject stale anchors', () => {
  const t = fast(); t.update('1', 'A', 'Stable. Delete it.', 0);
  const s = t.take(0); t.preview(s, reply(s));
  t.update('1', 'A', 'Stable. Do not delete it.', 1);
  assert.equal(t.view().translation, 'A: RU(Stable.)');
  t.update('1', 'A', 'Changed first. Do not delete it.', 2);
  assert.equal(t.view().translation, '');
  assert.equal(t.preview(s, reply(s)), false);
  assert.equal(t.accept(s, reply(s)), false);
  assert.equal(t.view().translation, '');
});

test('preview preserves still-valid existing overlap until replacement is complete', () => {
  const t = fast(); t.update('1', 'A', 'One. Two.', 0); drain(t);
  t.update('2', 'B', 'Three.', 1);
  const s = t.take(1);
  assert.equal(t.preview(s, reply(s, 'NEW').slice(0, 1)), false); // Only overlap so far.
  assert.equal(t.view().translation, 'A: NEW(One.) RU(Two.)');
  t.preview(s, reply(s, 'NEW'));
  assert.match(t.view().translation, /B: NEW\(Three\.\)/);
  t.clearPreview();
  assert.equal(t.view().translation, 'A: RU(One.) RU(Two.)');
});

test('presentation invalidates only the changed suffix and idle reads do not revisit old text', () => {
  const t = fast(); t.update('1', 'A', 'Stable. '.repeat(1000), 0); drain(t);
  t.presentation();
  t.update('1', 'A', 'Stable. '.repeat(1000) + 'New.', 1);
  const view = t.presentation();
  assert.equal(view.sourceFrom, 1000); assert.equal(view.translationFrom, 1000);
  assert.equal(t.presentation().sourceFrom, Infinity);
  const state = t.states.get('1');
  const sent = state.sent;
  Object.defineProperty(state, 'sent', { get() { throw Error('Rescanned old history'); }, configurable: true });
  for (let i = 0; i < 100; i++) { assert.equal(t.pendingChars, 4); t.schedule(i); }
  Object.defineProperty(state, 'sent', { value: sent, writable: true });
});

test('incremental pending count and exact-match cache agree with full reference under mixed edits', () => {
  const t = fast({ targetWindowChars: 80, overlap: 5 }); let seed = 1234;
  const random = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  for (let i = 0; i < 500; i++) {
    const key = random(12), speaker = random(2) ? 'A' : 'B';
    const text = Array.from({ length: random(5) }, () => ['Alpha.', 'Beta.', 'No.', 'Yes.'][random(4)]).join(' ');
    t.update(key, speaker, text, i);
    const old = new Map(t.sentDocument.map(x => [x.id, x])); let pending = 0;
    for (const item of t.document) {
      const previous = old.get(item.id);
      pending += previous?.speaker === item.speaker ? changedChars(previous.text, item.text) : item.text.length;
      old.delete(item.id);
    }
    pending += [...old.values()].reduce((n,x) => n+x.text.length, 0);
    assert.equal(t.pendingChars, pending);
    assert.equal(t.outdated, t.document.length !== t.translated.length || t.document.some((x,j) =>
      x.id !== t.translated[j]?.id || x.text !== t.translated[j]?.text || x.speaker !== t.translated[j]?.speaker));
    if (random(3) === 0) { const s = t.take(i); if (s) t.accept(s, reply(s)); }
  }
});
