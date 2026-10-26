/* Synthetic local CPU/payload probe, not a provider or end-to-end speed benchmark. */
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { Tracker, paragraphs } = require(process.argv[2] ? path.resolve(process.argv[2]) : '../captions.js');
const fast = options => new Tracker({ newChars: 1, minDispatchMs: 0, ...options });
const reply = s => s.window.segments.map(x => ({ id: x.id, text: `Translated(${x.text})` }));
function drain(t) {
  let count = 0;
  while (t.outdated && count++ < 1000) {
    const s = t.take(count); if (!s) throw Error('No progress'); t.accept(s, reply(s));
  }
  if (t.outdated) throw Error('Did not drain');
}
function measure(fn, repetitions = 60) {
  for (let i = 0; i < 10; i++) fn(i);
  const times = [];
  for (let i = 0; i < repetitions; i++) {
    const start = performance.now(); fn(i + 10); times.push(performance.now() - start);
  }
  times.sort((a,b) => a-b);
  return { p50Ms: +times[Math.ceil(times.length*.5)-1].toFixed(4),
    p95Ms: +times[Math.ceil(times.length*.95)-1].toFixed(4) };
}
const t = fast({ targetWindowChars: 48000 });
const sentence = 'The deployment is Tuesday; preserve the backup and do not delete it.';
for (let i = 0; i < 5000; i++) t.update(String(i), i % 2 ? 'A' : 'B', sentence, 0);
drain(t);
if (t.presentation) t.presentation();
t.update('4999', 'A', sentence + ' New speech.', 1);
const scheduling = measure(() => { t.pendingChars; t.outdated; t.schedule(100); });
const preparation = measure(i => {
  t.update('4999', 'A', sentence + ` Revision ${i}.`, i + 100);
  if (!t.presentation) { t.view(); return; }
  const view = t.presentation();
  for (const [items, from, field] of [[view.source, view.sourceFrom, 'text'],
    [view.translation, view.translationFrom, 'translation']]) {
    for (let at = Math.floor(from/32)*32; at < items.length; at += 32) paragraphs(items.slice(at, at+32), field);
  }
});
const speech = fast();
const clause = 'we review the deployment details '.repeat(24) + ', ';
speech.update('1', 'A', clause.repeat(30), 0); drain(speech);
speech.update('1', 'A', clause.repeat(31), 1000);
const tail = speech.take(1000);
console.log(JSON.stringify({ node: process.version, historyAnchors: 5000, scheduling, localRenderPreparation: preparation,
  growingClauseSpeech: { totalSourceChars: speech.transcriptChars,
    windowSourceChars: tail.window.segments.reduce((n,x) => n+x.text.length, 0), anchors: tail.window.segments.length,
    jsonPayloadChars: JSON.stringify({ context: tail.context, window: tail.window, ...(tail.previous ? {previous:tail.previous} : {}) }).length },
  excludes: 'DOM layout/paint, model latency, aggregation wait, real meetings' }, null, 2));
