(() => {
  if (document.getElementById('meet-improve-panel')) return;
  const { Tracker, normalize, DEFAULTS, TARGET_LANGUAGES } = globalThis.MeetCaptions;
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
      button:disabled{opacity:.5;cursor:default}section{width:380px;max-width:calc(100vw - 32px);background:#202020;border:1px solid #626262;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px #0003}
      header{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #444}strong{flex:1;font-size:14px}
      .controls{padding:12px;display:grid;gap:10px}.actions{display:flex;gap:8px;align-items:center}.model{font-size:12px;color:#c2c2c2}
      label{display:flex;gap:7px;align-items:center;font-size:12px}.settings{display:flex;gap:12px;flex-wrap:wrap}.settings label{display:grid;gap:4px}.settings input,.settings select{max-width:145px;background:#303030;color:#eee;border:1px solid #626262;border-radius:4px;padding:4px}.notice{font-size:12px;line-height:1.45;color:#ccc;margin:0}
      #status{margin:0;padding:0 12px 10px;font-size:12px;color:#d8d8d8;overflow-wrap:anywhere}#status.error{color:#ffb9b9}
      #entries{max-height:min(48vh,480px);overflow:auto;border-top:1px solid #444;overscroll-behavior:contain}
      article{padding:10px 12px;border-bottom:1px solid #3a3a3a;user-select:text;overflow-wrap:anywhere}article:last-child{border:0}
      .source{font-size:13px;line-height:1.5;color:#bcbcbc;margin:5px 0;white-space:pre-wrap}.translation{line-height:1.5;margin:5px 0 0;white-space:pre-wrap}
      .note{color:#c9adff;font-size:12px;margin-top:8px}.pending{color:#bcbcbc;font-size:12px}.empty{padding:16px 12px;color:#bcbcbc;font-size:13px;margin:0}
      [hidden]{display:none!important}.compact{width:auto}.compact header{border:0}
    </style>
    <section aria-label="Meet caption translation">
      <header><strong>Meet · caption translation</strong><button id="collapse" aria-expanded="true" aria-label="Collapse panel">−</button></header>
      <div id="body">
        <div class="controls">
          <div class="actions"><button id="start">Start</button><button id="clear">Reset</button><span class="model">gpt-6-luna · low</span></div>
          <div class="settings"><label>Translate to<select id="targetLanguage"></select></label><label>New text (chars)<input id="newChars" type="number" min="100" max="4000" step="100" value="${DEFAULTS.newChars}"></label><label>Wait (seconds)<input id="interval" type="number" min="3" max="30" step="1" value="${DEFAULTS.intervalMs / 1000}"></label><label>Retranslate last<select id="overlap"><option value="10">10 sentences</option><option value="5">5 sentences</option></select></label></div>
          <p class="notice">Source language is detected automatically. Set the caption language separately in Meet.</p>
          <label><input id="history" type="checkbox">Translate existing captions</label>
          <p class="notice">Starting sends caption text and speaker names to OpenAI through your Codex / ChatGPT account. No API key is used.</p>
        </div>
        <p id="status" role="status">Enable captions in Meet, then click Start.</p>
        <div id="entries"><p class="empty">The original text and translation will appear here.</p></div>
      </div>
    </section>`;
  document.documentElement.append(host);
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
  let route = location.pathname, lastLatency = '', connectedAt = 0, lastScan = 0;
  let previous = [], previousRoot = null;
  function status(text, error = false) {
    $('status').textContent = text;
    $('status').className = error ? 'error' : '';
  }
  function stop(message = 'Stopped. New captions are not being sent.', error = false) {
    ready = false;
    clearInterval(timer);
    observer?.disconnect();
    observer = null;
    const old = port;
    port = null;
    old?.disconnect();
    inflight = null;
    if (row?.outdated) row.note.textContent = 'Stopped — the latest text has not been translated';
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
  function updateText(element, value) {
    // Keep the text node and unchanged prefix intact, including selection in older text.
    const node = element.firstChild;
    if (!node || node.nodeType !== Node.TEXT_NODE || element.childNodes.length !== 1) {
      element.textContent = value; return;
    }
    const old = node.data;
    if (old === value) return;
    let prefix = 0, suffix = 0;
    while (prefix < Math.min(old.length, value.length) && old[prefix] === value[prefix]) prefix++;
    while (suffix < Math.min(old.length, value.length) - prefix && old.at(-1-suffix) === value.at(-1-suffix)) suffix++;
    node.replaceData(prefix, old.length-prefix-suffix, value.slice(prefix, value.length-suffix));
  }
  function render() {
    const view = tracker.view();
    if (!view.source && !view.translation) { entries.replaceChildren(); row = null; return; }
    const atBottom = entries.scrollHeight - entries.scrollTop - entries.clientHeight < 60;
    if (!row) {
      entries.querySelector('.empty')?.remove();
      const element = document.createElement('article');
      const details = document.createElement('details');
      const summary = document.createElement('summary'); summary.textContent = 'Original';
      const source = document.createElement('p'); source.className = 'source'; source.lang = 'und'; source.dir = 'auto';
      details.append(summary, source);
      const translation = document.createElement('p'); translation.className = 'translation'; translation.lang = targetLanguage;
      translation.dir = targetLanguage === 'ar' ? 'rtl' : 'auto';
      const note = document.createElement('div'); note.className = 'note';
      element.append(details, translation, note);
      entries.append(element);
      row = { source, translation, note };
    }
    updateText(row.source, view.source);
    updateText(row.translation, view.translation || 'Collecting context for translation…');
    row.translation.className = view.translation ? 'translation' : 'translation pending';
    row.outdated = view.outdated;
    row.note.textContent = view.outdated ?
      (view.translation ? 'Provisional translation · new text and recent sentences will be updated together' : 'Waiting for the time or text threshold') :
      'Translation is up to date · new speech will be added here';
    if (atBottom) entries.scrollTop = entries.scrollHeight;
  }
  function scan(seed = false) {
    const root = findRoot();
    if (!root) return false;
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
    const found = dirty || performance.now() - lastScan > 2000 ? scan() : !!findRoot();
    dirty = false;
    if (!inflight) {
      const snapshot = tracker.take(performance.now());
      if (!snapshot && !tracker.document.length) render();
      if (snapshot) {
        const id = ++requestId;
        inflight = { id, snapshot, since: performance.now() };
        port.postMessage({ type: 'translate', requestId: id, targetLanguage, window: snapshot.window, context: snapshot.context });
      }
    } else if (performance.now() - inflight.since > 95000) {
      stop('Translation timed out. Requests will not be retried automatically.', true); return;
    }
    status(!found ? 'Waiting for captions: enable them in Meet.' :
      `${inflight ? 'Translating text and recent sentences' : 'Collecting context'} · changed: ${tracker.pendingChars} chars${lastLatency}`);
  }
  function start() {
    if (!$('newChars').reportValidity() || !$('interval').reportValidity()) return;
    const newChars = Number($('newChars').value), intervalMs = Number($('interval').value) * 1000;
    const overlap = Number($('overlap').value);
    const selectedLanguage = $('targetLanguage').value;
    if (!Number.isFinite(newChars) || newChars < 100 || newChars > 4000 ||
        !Number.isFinite(intervalMs) || intervalMs < 3000 || intervalMs > 30000 || ![5, 10].includes(overlap) ||
        !Object.hasOwn(TARGET_LANGUAGES, selectedLanguage)) return;
    targetLanguage = selectedLanguage;
    tracker = new Tracker({ newChars, intervalMs, overlap }); keys = new WeakMap(); nextKey = 0; row = null;
    entries.replaceChildren(); inflight = null; lastLatency = '';
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
          if (message.protocol !== 3) { stop('Version mismatch. Reload the extension and restart the translator.', true); return; }
          ready = true; tick();
        }
        else if (message.type === 'error') stop(message.message, true);
        else if (message.type === 'result' && inflight?.id === message.requestId) {
          try {
            scan(); // Incorporate new speech/corrections before accepting a snapshot result.
            const snapshot = inflight.snapshot;
            if (message.windowId !== snapshot.window.id || !Array.isArray(message.segments)) {
              throw Error('Invalid response from the translator.');
            }
            if (tracker.accept(snapshot, message.segments)) render();
          } catch (error) { stop(error.message, true); return; }
          lastLatency = ` · ${(message.elapsedMs / 1000).toFixed(1)} s`;
          inflight = null; tick();
        }
      });
      connection.onDisconnect.addListener(() => {
        const error = chrome.runtime.lastError;
        if (port === connection) stop(error?.message || 'The translator connection is closed.', true);
      });
      observer = new MutationObserver(() => { dirty = true; });
      observer.observe(document.body, { childList: true, characterData: true, subtree: true });
      timer = setInterval(tick, 400);
    } catch (error) { stop(error.message, true); }
  }
  $('start').addEventListener('click', () => port ? stop() : start());
  $('clear').addEventListener('click', () => {
    stop('History cleared. Click Start for a new session.');
    entries.replaceChildren(); row = null; tracker = null;
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
