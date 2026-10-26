(() => {
  if (document.getElementById('meet-improve-panel')) return;
  const { Tracker, normalize, paragraphs, DEFAULTS, TARGET_LANGUAGES } = globalThis.MeetCaptions;
  const { TextBlocks, Timings } = globalThis.MeetPanel;
  const host = document.createElement('div');
  host.id = 'meet-improve-panel';
  host.lang = 'en';
  host.dir = 'ltr';
  const shadow = host.attachShadow({ mode: 'closed' });
  // Static extension-owned markup only. Meeting text is always rendered with textContent.
  shadow.innerHTML = `
    <style>
      :host{all:initial;position:fixed;right:16px;top:16px;z-index:2147483646;color:#ececec;font:14px system-ui}
      *{box-sizing:border-box}button,input,select{font:inherit}button{cursor:pointer;background:#303030;color:inherit;border:1px solid #626262;border-radius:5px;padding:6px 10px}
      button:hover{background:#414141}button:focus-visible,input:focus-visible{outline:2px solid #c9adff;outline-offset:2px}
      button:disabled{opacity:.5;cursor:default}section{width:380px;max-width:calc(100vw - 32px);max-height:calc(100vh - 16px);display:flex;flex-direction:column;background:#202020;border:1px solid #626262;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px #0003}
      header{display:flex;flex-shrink:0;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #444;cursor:grab;user-select:none;touch-action:none}header[data-dragging]{cursor:grabbing}strong{flex:1;font-size:14px}
      #body{min-height:0;overflow:auto;overscroll-behavior:contain}
      .controls{padding:8px 12px;display:grid;gap:8px}.actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.actions label{margin-left:auto}
      label{display:flex;gap:7px;align-items:center;font-size:12px}input,select{min-width:0;max-width:145px;background:#303030;color:#eee;border:1px solid #626262;border-radius:4px;padding:4px}
      summary{cursor:pointer;font-size:12px}.settings{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;padding-top:8px}.settings label{display:grid;gap:4px}.settings .history{display:flex;grid-column:1/-1}.notice{font-size:12px;color:#ccc;margin:0}
      #status{margin:0;padding:0 12px 10px;font-size:12px;color:#d8d8d8;overflow-wrap:anywhere}#status.error{color:#ffb9b9}
      #entries{max-height:min(48vh,480px);overflow:auto;border-top:1px solid #444;overscroll-behavior:contain}
      #entries:empty{display:none}
      article{padding:10px 12px;border-bottom:1px solid #3a3a3a;user-select:text;overflow-wrap:anywhere}article:last-child{border:0}
      .source{font-size:13px;line-height:1.5;color:#bcbcbc}.translation{line-height:1.5}
      .text-block{margin:5px 0;white-space:pre-wrap;content-visibility:auto;contain-intrinsic-size:auto 120px}
      #metrics{grid-column:1/-1;margin:0;white-space:pre-wrap;font-size:12px;line-height:1.5;color:#ccc}
      .pending{color:#bcbcbc;font-size:12px}
      [hidden]{display:none!important}.compact{width:auto}.compact header{border:0}
    </style>
    <section aria-label="Meet caption translation">
      <header title="Drag to move"><strong>Meet · caption translation</strong><button id="collapse" aria-expanded="true" aria-label="Collapse panel">−</button></header>
      <div id="body">
        <div class="controls">
          <div class="actions"><button id="start" title="Translate with gpt-6-luna · low via Codex / ChatGPT">Start</button><button id="clear">Reset</button><label>To<select id="targetLanguage" aria-label="Translate to"></select></label></div>
          <details><summary>Settings</summary><div class="settings"><label>New text (chars)<input id="newChars" type="number" min="100" max="4000" step="100" value="${DEFAULTS.newChars}"></label><label>Wait (seconds)<input id="interval" type="number" min="3" max="30" step="1" value="${DEFAULTS.intervalMs / 1000}"></label><label>Retranslate last<select id="overlap"><option value="10">10 sentences / clauses</option><option value="5">5 sentences / clauses</option></select></label><label class="history"><input id="history" type="checkbox">Include existing captions</label><p id="metrics">Timing will appear here after the first request.</p></div></details>
          <p class="notice">Captions and speaker names → OpenAI</p>
        </div>
        <p id="status" role="status">Enable Meet captions, then Start.</p>
        <div id="entries"></div>
      </div>
    </section>`;
  document.documentElement.append(host);
  globalThis.MeetPanel.makeDraggable(host, shadow.querySelector('header'));
  const $ = (id) => shadow.getElementById(id);
  for (const [code, label] of Object.entries(TARGET_LANGUAGES)) {
    const option = document.createElement('option'); option.value = code; option.textContent = label;
    $('targetLanguage').append(option);
  }
  $('targetLanguage').value = DEFAULTS.targetLanguage;
  $('overlap').value = String(DEFAULTS.overlap);
  const settingIds = ['history', 'newChars', 'interval', 'overlap', 'targetLanguage'];
  const entries = $('entries');
  let targetLanguage = DEFAULTS.targetLanguage;
  let port = null, ready = false, timer = null, observer = null, dirty = true;
  let tracker, keys, nextKey, row = null, inflight = null, requestId = 0;
  let route = location.pathname, lastResult = null, connectedAt = 0, lastScan = 0;
  let previous = [], previousRoot = null;
  let timings = new Timings();
  function status(text, error = false) {
    if ($('status').textContent !== text) $('status').textContent = text;
    $('status').className = error ? 'error' : '';
  }
  function stop(message = 'Stopped', error = false) {
    ready = false;
    clearInterval(timer);
    observer?.disconnect();
    observer = null;
    const old = port;
    port = null;
    old?.disconnect();
    inflight = null;
    tracker?.clearPreview();
    if (tracker) render();
    $('start').textContent = 'Start';
    for (const id of settingIds) $(id).disabled = false;
    status(message, error);
  }
  function findRoot() {
    // The semantic label is localized; structure fallback is from the supplied Meet DOM.
    return document.querySelector('[role="region"][aria-label="Captions"]') ||
      [...document.querySelectorAll('[role="region"]')].find(el => el.querySelector('.nMcdL .ygicle')) ||
      document.querySelector('.vNKgIf');
  }
  function readRows(root) {
    return [...root.querySelectorAll('.nMcdL')].map(el => ({
      el, speaker: normalize(el.querySelector('.NWpY1d')?.textContent || 'Speaker'),
      text: el.querySelector('.ygicle')?.textContent || '',
    }));
  }
  function render() {
    const view = tracker.presentation();
    if (!view.source.length && !view.translation.length) { entries.replaceChildren(); row = null; return; }
    const atBottom = entries.scrollHeight - entries.scrollTop - entries.clientHeight < 60;
    if (!row) {
      const element = document.createElement('article');
      const details = document.createElement('details');
      const summary = document.createElement('summary'); summary.textContent = 'Original';
      const source = document.createElement('div'); source.className = 'source'; source.lang = 'und'; source.dir = 'auto';
      details.append(summary, source);
      const translation = document.createElement('div'); translation.className = 'translation'; translation.lang = targetLanguage;
      translation.dir = targetLanguage === 'ar' ? 'rtl' : 'auto';
      const pending = document.createElement('p'); pending.className = 'pending'; pending.textContent = 'Waiting for translation…';
      element.append(details, translation, pending);
      entries.append(element);
      row = { details, translation, pending, sourceBlocks: new TextBlocks(source, paragraphs),
        translationBlocks: new TextBlocks(translation, paragraphs, 'translation') };
      details.addEventListener('toggle', () => { if (details.open) row?.sourceBlocks.render(); });
    }
    row.sourceBlocks.update(view.source, view.sourceFrom);
    if (row.details.open) row.sourceBlocks.render();
    row.translationBlocks.update(view.translation, view.translationFrom);
    row.translationBlocks.render();
    row.pending.hidden = view.translation.length > 0;
    row.translation.toggleAttribute('data-provisional', !!inflight?.previewed);
    if (atBottom) entries.scrollTop = entries.scrollHeight;
  }
  function scan(seed = false) {
    const root = findRoot();
    if (!root) return false;
    if (root !== previousRoot && observer) {
      observer.disconnect();
      observer.observe(root, { childList: true, characterData: true, subtree: true });
    }
    const found = readRows(root);
    const replacement = previousRoot && previousRoot !== root;
    const reusable = new Map();
    for (const old of previous) {
      if (!old.el.isConnected) {
        const signature = JSON.stringify([old.speaker, normalize(old.text)]);
        if (!reusable.has(signature)) reusable.set(signature, []);
        reusable.get(signature).push(old.key);
      }
    }
    const used = new Set();
    const now = performance.now();
    let changed = false;
    for (const [index, item] of found.entries()) {
      const { el, speaker, text } = item;
      let key = keys.get(el);
      if (!key) {
        const candidates = reusable.get(JSON.stringify([speaker, normalize(text)])) || [];
        key = candidates.find(candidate => !used.has(candidate));
        if (!key && replacement && found.length === previous.length && previous[index]?.speaker === speaker && !used.has(previous[index].key)) key = previous[index].key;
        key ||= String(++nextKey);
        keys.set(el, key);
      }
      used.add(key); item.key = key;
      if (seed) tracker.seed(key, speaker, text);
      else changed = tracker.update(key, speaker, text, now) || changed;
    }
    if (changed) render();
    previous = found; previousRoot = root; lastScan = now;
    return true;
  }
  function tick() {
    try { tickUnsafe(); } catch (error) { stop(error.message, true); }
  }
  function tickUnsafe() {
    if (!port) return;
    if (location.pathname !== route) { stop('The meeting has changed. Click Start for the new meeting.'); return; }
    if (!ready) {
      if (performance.now() - connectedAt > 95000) stop('No response from the local translator. Check the installation.', true);
      return;
    }
    // Periodic scans also detect root replacement and caption visibility toggles.
    const found = dirty || performance.now() - lastScan > 2000 ? scan() : !!previousRoot?.isConnected;
    dirty = false;
    if (!inflight) {
      const snapshot = tracker.take(performance.now());
      if (!snapshot && !tracker.document.length) render();
      if (snapshot) {
        const id = ++requestId;
        inflight = { id, snapshot, since: performance.now(), firstShownAt: null, previewed: false };
        port.postMessage({ type: 'translate', requestId: id, targetLanguage, window: snapshot.window,
          context: snapshot.context, previous: snapshot.previous });
      }
    } else if (performance.now() - inflight.since > 95000) {
      stop('Translation timed out. Requests will not be retried automatically.', true); return;
    }
    const now = performance.now();
    // Keep scheduling while the model runs; take() snapshots the latest text only when idle.
    const waitMs = tracker.schedule(now);
    const activity = inflight ? `Translating · ${((now - inflight.since) / 1000).toFixed(1)} s${inflight.previewed ? ' · provisional' : ''}${waitMs === 0 ? ' · queued' : ''}` :
      tracker.outdated && Number.isFinite(waitMs) ? `Waiting · ${(waitMs / 1000).toFixed(1)} s` :
      tracker.document.length ? 'Up to date' : 'Waiting for speech';
    const detail = !lastResult ? '' : tracker.outdated ?
      (lastResult.kind === 'partial' ? ' · partial' : lastResult.kind === 'discarded' ? ' · source changed' : '') :
      ` · last ${lastResult.seconds} s`;
    status(!found ? 'Enable Meet captions' : `${activity}${detail}`);
  }
  function start() {
    const invalid = ['newChars', 'interval'].map($).find(input => !input.checkValidity());
    if (invalid) {
      invalid.closest('details').open = true;
      invalid.reportValidity(); return;
    }
    const newChars = Number($('newChars').value), intervalMs = Number($('interval').value) * 1000;
    const overlap = Number($('overlap').value);
    const selectedLanguage = $('targetLanguage').value;
    if (!Number.isFinite(newChars) || newChars < 100 || newChars > 4000 ||
        !Number.isFinite(intervalMs) || intervalMs < 3000 || intervalMs > 30000 || ![5, 10].includes(overlap) ||
        !Object.hasOwn(TARGET_LANGUAGES, selectedLanguage)) return;
    targetLanguage = selectedLanguage;
    tracker = new Tracker({ newChars, intervalMs, overlap }); keys = new WeakMap(); nextKey = 0; row = null;
    timings = new Timings(); $('metrics').textContent = 'Timing will appear here after the first request.';
    entries.replaceChildren(); inflight = null; lastResult = null;
    route = location.pathname; previous = []; previousRoot = null; dirty = true;
    try { if (!$('history').checked) scan(true); } catch (error) { stop(error.message, true); return; }
    $('start').textContent = 'Stop'; for (const id of settingIds) $(id).disabled = true;
    status('Connecting to local Codex…');
    connectedAt = performance.now();
    try {
      const connection = chrome.runtime.connect({ name: 'meet-translate' });
      port = connection;
      connection.onMessage.addListener(message => {
        if (port !== connection) return;
        if (message.type === 'ready') {
          if (message.protocol !== 4) { stop('Version mismatch. Reload the extension and restart the translator.', true); return; }
          ready = true; tick();
        }
        else if (message.type === 'error') stop(message.message, true);
        else if (message.type === 'progress' && inflight?.id === message.requestId) {
          try {
            scan();
            if (message.windowId !== inflight.snapshot.window.id || !Array.isArray(message.segments)) {
              throw Error('Invalid progressive response from the translator.');
            }
            if (tracker.preview(inflight.snapshot, message.segments)) inflight.firstShownAt ??= performance.now();
            inflight.previewed = true;
            render(); tick();
          } catch (error) { stop(error.message, true); }
        }
        else if (message.type === 'result' && inflight?.id === message.requestId) {
          try {
            scan(); // Incorporate new speech/corrections before accepting a snapshot result.
            const snapshot = inflight.snapshot;
            if (message.windowId !== snapshot.window.id || !Array.isArray(message.segments)) {
              throw Error('Invalid response from the translator.');
            }
            const useful = tracker.usable(snapshot, message.segments.length) > snapshot.first;
            const accepted = tracker.accept(snapshot, message.segments);
            const now = performance.now();
            if (accepted && useful) inflight.firstShownAt ??= now;
            timings.add({ requestMs: now - inflight.since,
              firstMs: inflight.firstShownAt === null ? null : inflight.firstShownAt - inflight.since,
              lagMs: inflight.firstShownAt === null ? null : inflight.firstShownAt - snapshot.sourceSince,
              discarded: !accepted });
            $('metrics').textContent = timings.summary();
            lastResult = { kind: !accepted ? 'discarded' : tracker.outdated ? 'partial' : 'complete',
              seconds: ((performance.now() - inflight.since) / 1000).toFixed(1) };
            inflight = null; render(); tick();
          } catch (error) { stop(error.message, true); return; }
        }
      });
      connection.onDisconnect.addListener(() => {
        const error = chrome.runtime.lastError;
        if (port === connection) stop(error?.message || 'The translator connection is closed.', true);
      });
      observer = new MutationObserver(() => { dirty = true; });
      if (previousRoot) observer.observe(previousRoot, { childList: true, characterData: true, subtree: true });
      timer = setInterval(tick, 400);
    } catch (error) { stop(error.message, true); }
  }
  $('start').addEventListener('click', () => port ? stop() : start());
  $('clear').addEventListener('click', () => {
    stop('History cleared');
    entries.replaceChildren(); row = null; tracker = null;
    timings = new Timings(); $('metrics').textContent = 'Timing will appear here after the first request.';
  });
  $('collapse').addEventListener('click', () => {
    const collapsed = !$('body').hidden;
    $('body').hidden = collapsed;
    shadow.querySelector('section').classList.toggle('compact', collapsed);
    $('collapse').textContent = collapsed ? '+' : '−';
    $('collapse').setAttribute('aria-expanded', String(!collapsed));
    $('collapse').setAttribute('aria-label', collapsed ? 'Expand panel' : 'Collapse panel');
  });
  window.addEventListener('pagehide', () => stop(), { once: true });
})();
