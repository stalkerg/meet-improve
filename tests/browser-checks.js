/* Run from demo.html. Synthetic captions + manual mock transport; no provider calls. */
window.runBrowserChecks = async function() {
  const checks = [];
  const check = (value, label) => { if (!value) throw Error(label); checks.push(label); };
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const $ = id => panel.getElementById(id);
  if (connected) $('start').click();
  $('clear').click(); window.sent = []; window.mockManual = true;
  const saved = { now: Object.getOwnPropertyDescriptor(performance, 'now'),
    setInterval: window.setInterval, clearInterval: window.clearInterval };
  let now = 0, nextId = 1;
  const timers = new Map();
  const timingEvidence = {};
  Object.defineProperty(performance, 'now', { configurable: true, value: () => now });
  window.setInterval = fn => { const id = nextId++; timers.set(id, fn); return id; };
  window.clearInterval = id => timers.delete(id);
  const advance = async ms => { await wait(0); now += ms; for (const fn of [...timers.values()]) fn(); await wait(0); };
  const start = async () => { $('start').click(); await wait(35); check(connected && $('targetLanguage').disabled, 'session connects and locks settings'); };
  const current = () => sent.at(-1);
  const answer = (message, prefix = 'RU') => ({ requestId: message.requestId, windowId: message.window.id,
    segments: message.window.segments.map(x => ({ id: x.id, text: `${prefix}(${x.text})` })) });
  const result = (message, prefix) => deliver({ type: 'result', ...answer(message, prefix) });
  const translation = () => panel.querySelector('.translation')?.textContent || '';
  try {
    await start();
    add('First stable. Delete the backup.'); await advance(0); await advance(3999);
    check(sent.length === 0, 'first dispatch waits four seconds');
    await advance(1); const first = current();
    timingEvidence.dispatchMs = now;
    check(sent.length === 1, 'first contextual window dispatched once');
    await advance(1000);
    deliver({ type: 'progress', ...answer(first) });
    timingEvidence.firstUsefulMs = now;
    check(translation().includes('Delete the backup'), 'complete progressive anchors appear before final response');
    check($('status').textContent.includes('provisional'), 'progress is visibly provisional');
    check(panel.querySelector('.translation').hasAttribute('data-provisional'), 'provisional DOM is marked');
    check(sent.length === 1, 'progress never dispatches a concurrent request');
    document.querySelector('[role=region]').lastElementChild.querySelector('.ygicle').textContent =
      'First stable. Do not delete the backup.';
    await advance(1000);
    check(!translation().includes('Delete the backup') && translation().includes('First stable'),
      'ASR correction immediately hides provisional stale suffix');
    await advance(2000); result(first); timingEvidence.completedMs = now;
    check(sent.length === 2, 'queued latest window dispatches immediately after final result');
    const second = current();
    check(second.window.segments.at(-1).text.includes('Do not delete'), 'queued window uses latest corrected source');
    check(second.previous.length === 1 && second.previous[0].text.includes('First stable'),
      'accepted translation continuity is sent explicitly');
    await advance(2000); result(second);
    check(translation().includes('Do not delete'), 'final corrected translation replaces tail');
    check(!panel.querySelector('.translation').hasAttribute('data-provisional'), 'final response clears provisional mark');
    check($('metrics').textContent.includes('request p50/p95') && $('metrics').textContent.includes('Caption change'),
      'timing diagnostics include request and caption-to-display latency');
    check($('metrics').textContent.includes('First useful text p50/p95 1.0 s / 2.0 s'),
      'timings distinguish first useful text from final response');
    const root = document.querySelector('[role=region]'), query = root.querySelectorAll;
    let scans = 0; root.querySelectorAll = function(...args) { scans++; return query.apply(this, args); };
    const noise = document.createElement('span'); noise.textContent = 'Unrelated meeting UI'; document.body.append(noise);
    await advance(400); delete root.querySelectorAll; noise.remove();
    check(scans === 0, 'unrelated page mutations do not trigger caption rescans');
    check(panel.querySelector('.source').childElementCount === 0, 'collapsed original is not rendered eagerly');
    panel.querySelector('article details').open = true; await wait(10);
    check(panel.querySelector('.source').textContent.includes('Do not delete'), 'opening Original renders latest source lazily');
    panel.querySelector('article details').open = false;
    add('A stable sentence. '.repeat(96)); await advance(1000);
    const third = current(); result(third);
    check(panel.querySelectorAll('.translation .text-block').length >= 3, 'history uses bounded render blocks');
    const firstBlock = panel.querySelector('.translation .text-block'), node = firstBlock.firstChild;
    const selection = panel.getSelection?.() || getSelection();
    const range = document.createRange(); range.setStart(node, 0); range.setEnd(node, 10);
    selection.removeAllRanges(); selection.addRange(range);
    const selected = selection.toString();
    add('Newest sentence.'); await advance(0); await advance(4000);
    const fourth = current();
    deliver({ type: 'progress', ...answer(fourth, 'PREVIEW') });
    check(panel.querySelector('.translation .text-block') === firstBlock && firstBlock.firstChild === node,
      'tail updates preserve archived DOM and text nodes');
    check(selection.toString() === selected && selected.length === 10, 'selection in archived text survives updates');
    check(translation().includes('PREVIEW'), 'replacement preview is visible');
    deliver({ type: 'error', message: 'Synthetic provider failure' });
    check(!connected && !translation().includes('PREVIEW'), 'failure rolls back preview and stops without retry');
    check(translation().includes('RU(First stable.)'), 'rollback preserves previously accepted history');
    const before = sent.length; await advance(120000);
    check(sent.length === before, 'stopped session does not drain queued work');
    selection.removeAllRanges();
    await start();
    const oldRoot = document.querySelector('[role=region]'); oldRoot.replaceWith(oldRoot.cloneNode(true));
    await advance(2100);
    check(sent.length === before, 'root replacement does not re-import skipped history');
    add('After root replacement.'); await advance(0); await advance(4000);
    check(sent.length === before + 1 && current().window.segments.length === 1,
      'scoped observer reconnects to replacement caption root');
    await advance(95001);
    check(!connected && $('status').textContent.includes('timed out'), 'timeout stops without an automatic retry');
    await start(); add('Malformed progress test.'); await advance(0); await advance(4000);
    deliver({ type: 'progress', ...answer(current()), windowId: 'wrong-window' });
    check(!connected && $('status').classList.contains('error'), 'wrong progressive window stops the session');
    await start(); add('Out of order test. Another sentence.'); await advance(0); await advance(4000);
    const bad = answer(current()); bad.segments.reverse(); deliver({ type: 'progress', ...bad });
    check(!connected, 'out-of-order progressive anchors are rejected');
    $('clear').click();
    check($('entries').childElementCount === 0 && $('start').textContent === 'Start', 'Reset clears history and leaves session stopped');
    const rect = panel.querySelector('section').getBoundingClientRect();
    check(rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight,
      'panel stays inside viewport');
    return { passed: checks.length, checks, timingEvidence, mockRequests: sent.length, providerRequests: 0 };
  } finally {
    if (connected) $('start').click();
    window.setInterval = saved.setInterval; window.clearInterval = saved.clearInterval;
    if (saved.now) Object.defineProperty(performance, 'now', saved.now); else delete performance.now;
    window.mockManual = false;
  }
};

window.runRealtimeCheck = async function() {
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const $ = id => panel.getElementById(id);
  if (connected) $('start').click();
  $('clear').click(); window.sent = []; window.sentAt = [];
  window.mockManual = false; window.mockProgress = true; window.mockDelay = 6000;
  let updates = null;
  try {
    $('start').click(); await wait(40);
    const began = performance.now();
    add('Stable first sentence. Draft value 0.');
    const body = document.querySelector('[role=region]').lastElementChild.querySelector('.ygicle');
    let revision = 0, firstVisible = null;
    updates = setInterval(() => { body.textContent = `Stable first sentence. Draft value ${++revision}.`; }, 300);
    while (sent.length < 2 && performance.now() - began < 13000) {
      const visible = panel.querySelector('.translation')?.textContent || '';
      if (visible.includes('Stable first sentence')) firstVisible ??= performance.now();
      await wait(25);
    }
    if (sent.length !== 2 || firstVisible === null) throw Error('Realtime translation did not progress');
    const gap = sentAt[1] - sentAt[0];
    if (gap < 5900 || gap > 7200) throw Error(`Queued dispatch was delayed: ${gap} ms`);
    if (firstVisible >= sentAt[1]) throw Error('No early visible translation');
    if (sent[1].window.segments.at(-1).text === sent[0].window.segments.at(-1).text) throw Error('Stale queued snapshot');
    if (panel.querySelector('.translation').textContent.includes('Draft value')) throw Error('Corrected stale tail was displayed');
    return { passed: true, tickerMs: 400, mockedModelMs: 6000, revisions: revision,
      firstVisibleAfterDispatchMs: Math.round(firstVisible - sentAt[0]),
      nextDispatchAfterPreviousMs: Math.round(gap), providerRequests: 0 };
  } finally {
    clearInterval(updates);
    if (connected) $('start').click();
    $('clear').click(); window.mockProgress = false; delete window.mockDelay;
  }
};
