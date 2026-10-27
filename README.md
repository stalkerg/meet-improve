# Meet Improve

A Brave extension that enables text selection in Google Meet and provides a growing,
context-aware caption translation through **Codex / ChatGPT, `gpt-6-luna`, reasoning `low`**.
It uses your existing Codex sign-in with ChatGPT, not a separately billed API key.

The translator detects the source language automatically, including mixed-language speech.
Choose only the **target language**. The default is **Russian**.

## Updating to 0.6.1

1. Click **Stop** in the old panel.
2. Reload Meet Improve at `brave://extensions/`.
3. Refresh the Meet tab, choose the target language and click **Start**.

The extension ID remains `kekiclkdaklolmdekdpdiflkhnnnhmpn`.
You do not need to reinstall the native host unless the project directory has moved.
Version 0.6.1 keeps **native protocol 4** from 0.6.0 for progressive results and explicit translation
continuity. Reload the extension and refresh Meet together; an old content script or
background worker will stop with a version-mismatch error rather than mix protocols.

Version 0.6.1 fixes an underconstrained output schema: each turn now specifies the exact
expected number of translated anchors and its window ID, rather than allowing an arbitrary
array length. Production anchor IDs are also allowlisted in the schema. Context and
previous translations do not reduce the required output count: the overlapping tail must
still be returned in full. This applies independently to every turn of a reused thread.
Final duplicate/identity/count validation and fail-closed behavior are unchanged; missing
text is never silently filled, dropped or retried. Count errors now include expected and
received counts without caption text. The native host does not need reinstalling.

Version 0.6.0 introduced early provisional display of complete translated anchors, smaller
contextual batches, incremental history rendering and local timing diagnostics. It also
includes the previously local timer, ASR-prefix and draggable-panel improvements.
The model, reasoning effort, service tier and four-second/500-character triggers are unchanged.

## How translation works

A translation becomes ready when there is unsent text and **either** condition is met:

- **4 seconds** have elapsed since the last request was **sent** (for the first request,
  count from the first caption change);
- **500 new or changed characters** have accumulated.

Both thresholds are configurable before starting. They are joined by **OR**, not AND.
Only one request runs at a time, with at least one second between dispatches. The timer
keeps running while the model works. At most **one pending update** waits locally; new
speech and ASR corrections update its text instead of adding obsolete snapshots to a queue.
The complete contextual window is built just before dispatch, after processing the previous
response. If an update is already queued, it is sent immediately when the current request
finishes; only that actual dispatch restarts the interval. An early volume trigger also
restarts the interval. A queued update is cancelled if its source changes are fully reverted
or the current translation already covers them.

For example: send at 4 s, new speech at 7 s, queue at 8 s, receive the first response at
10 s and immediately send the latest text. The next time deadline is then 14 s.
Silence alone never causes requests. After a long pause, new text is eligible immediately
if the interval has already elapsed. New characters and completed responses do not restart
the timer. The four seconds are a dispatch threshold, not an end-to-end latency guarantee;
model generation and an in-flight request can still add delay.

Each request translates new speech together with the **last 10 sentence/clause anchors**;
you can select a five-anchor overlap instead. For a sentence longer than 600 characters,
clause punctuation (commas, semicolons and colons) can provide additional anchors. Latin
punctuation must be followed by whitespace; CJK clause punctuation is also supported.
These are not separate translation calls: the model still translates the whole window
as one dialogue. Unpunctuated phrases remain whole, never cut at a character quota.

Batches have a **soft 6,000-source-character target** to avoid making a large backlog one
long generation. When the required overlap is already large, the soft budget grows to
allow up to another 2,000 characters of new speech. At least one changed whole anchor is
included, even if it alone exceeds the soft budget. No text or configured overlap is
discarded: remaining speech drains through subsequent contextual windows. The hard
48,000-character/512-anchor safety limits still apply.

The model receives the window as **one contextual dialogue**, not separate translation
requests for each utterance. Sentence IDs are output anchors: the translated tail is
replaced in place, new text is appended, and the older prefix stays intact.
Corrections to earlier source text expand the replacement window as needed. Archived
display blocks are not permanently frozen: earlier ASR corrections still invalidate
their affected translated suffix.

Each request also carries up to **20 previously accepted translations / 6,000 target
characters**, keyed to unchanged source anchors in its window and preceding context.
These references survive model-thread rotation. The prompt uses them for terminology,
names and register, and discourages gratuitous stylistic rewrites. References at or
after the first corrected source anchor are excluded. The latest source and clarified
meaning always override earlier translations. This is bounded continuity, not a verified
glossary or a guarantee of terminology consistency over an entire meeting.

The host reuses one **ephemeral Codex thread for up to 10 translations** to improve
prompt-cache reuse. Each translation is a new turn containing the complete current
window and its preceding context, not just a text delta. The latest source text takes
precedence over older caption versions and translations in the thread.

Before the next request, the host starts a fresh thread if 10 translations have completed,
the last reported input-plus-output context has reached **16,000 tokens**, or the target
language changes. Missing token-usage information also causes rotation. The token threshold
is a rotation trigger, not a hard per-request limit: a single large window may exceed it
and is never truncated to fit. Rotation does not restart the Codex process or reset the
translation displayed in the panel. Errors stop the session without retries.

The model remains `gpt-6-luna` with reasoning `low` and **Standard** service tier.
Thread reuse does not enable the higher-usage Fast tier.

The native host decodes streamed JSON incrementally and forwards **only complete, ordered,
nonempty translated anchors for the current window and turn**, never raw tokens or JSON
fragments. They are displayed as **provisional** without completing the request or changing
the accepted translation state. Source corrections immediately hide stale previews.
The final response must still pass full validation; Stop, timeout or failure removes the
preview while preserving previously accepted, still-current history. A differently ordered
JSON root can fall back to final-only display. Early display is not guaranteed, particularly
when the model must generate a large overlap before reaching new speech.

A result for speech that is still being extended may be shown as provisional. If Meet
corrects the source during generation, the matching prefix of the response is retained
instead of discarding the entire translation. Everything from the first changed anchor
onward is withheld and retranslated in the next contextual window. Already displayed
translations of corrected text are also hidden until updated. Matching source anchors
do not guarantee unchanged meaning: new context can still revise the retained prefix.
If the very first requested anchor changes, there may be no usable result to show yet;
this does not eliminate model latency or guarantee an update every four seconds.
A temporary ASR correction that returns to the already translated text does not trigger
an unnecessary request.
Segmentation is cached per utterance. Pending character counts are maintained incrementally;
idle scheduling does not repeatedly compare every historical character. The panel updates
only affected 32-anchor blocks, keeps older text nodes intact for selection, and lets the
browser skip layout of offscreen blocks. Original text is rendered only when expanded.
The caption observer watches the caption container rather than every mutation of Meet's
entire page; periodic discovery reconnects it after a container replacement (up to ~2 s).

The prompt in `native/translator-prompt.txt` accounts for speech recognition errors:
homophones, incorrect words or characters, missing words, punctuation, fragments and
technical terms. It asks the model to use context without inventing facts, names,
numbers or endings for incomplete speech. Unclear spans stay uncertain or are marked
as unintelligible in the selected target language.

## Installation (Linux)

Requirements: **Python 3.11+**, **Brave**, and **Codex CLI signed in with ChatGPT**.
The integration was initially tested with `codex-cli 0.159.2`.

1. Run `codex login status` and confirm that it reports a ChatGPT sign-in.
   If authentication fails, stop and resolve it yourself. The extension does not run
   login, switch accounts, retry authentication or choose a fallback model.
2. From the project directory, register the native host:
   ```sh
   python3 -B native/install.py
   ```
   The installer finds existing `BraveSoftware/Brave-Origin` and/or
   `BraveSoftware/Brave-Browser` user-data roots. To specify another root:
   ```sh
   python3 -B native/install.py --browser-dir /path/to/brave-user-data
   ```
   Use the user-data root, **not** its `Default` profile subdirectory.
3. Open `brave://extensions/`, enable **Developer mode**, choose **Load unpacked**,
   and select this project's directory (the one containing `manifest.json`).
4. Refresh Meet and enable its captions. Configure the caption language **in Meet**
   to match the speech; this extension does not change Meet's recognition settings.
5. Choose the translation target in the extension panel, then click **Start**.

There is no build step and no npm dependency installation. If you move the project,
run the host installer again.

### Starting the host

Do **not** launch `native/host.py` manually for normal use. Brave starts the registered
native host when you click **Start**, and the host launches a dedicated
`codex app-server` subprocess. **Stop** disconnects it and terminates that subprocess.
There is no systemd service, HTTP listener or background daemon to start separately.

## Panel controls

The interface, language names and extension-owned status/error messages are in **English**.
The target selector changes the **translation language**, not the interface language;
Russian remains the default translation target. Browser- or Codex-provided errors may
follow the language settings of those applications.

| Panel label | Meaning |
| --- | --- |
| `Start` / `Stop` | Start / stop translation |
| `To` | Target language; default Russian |
| `Settings` | Expand timing, overlap and existing-caption options |
| `New text (chars)` | New/changed character threshold: 100–4000; default 500 |
| `Wait (seconds)` | Time threshold: 3–30 seconds; default 4 |
| `Retranslate last` | Retranslate the last 5 or 10 sentence/clause anchors; default 10 |
| `Include existing captions` | Include captions already visible at Start |
| `Reset` | Stop and clear the panel history |
| `Original` | Expand the original source text |
| `−` / `+` | Collapse / expand the panel without stopping translation |
| Panel title bar | Drag to move the panel; the collapse button remains clickable |

The panel stays within the viewport, including after expanding it or resizing the
browser. Its position lasts for the current page only; reloading restores the default
top-right position. Dragging does not interrupt translation or affect text selection
in the captions.

The compact status shows the wait countdown or elapsed request time. `queued` means one
fresh update is ready and waiting for the current request to finish. `partial` means
only a provisional portion is available; `source changed` means the last response had
no usable portion for the current source. `last` measures the last request round trip,
not the total delay since speech. Detailed explanations live here rather than filling
the caption panel.

`provisional` marks streamed preview text before final validation. **Settings** also shows
p50/p95 timings over the latest 128 completed requests: request round trip, first useful
text, and observed caption change → first useful text (including aggregation and queue wait).
Rewording only the already-translated overlap does not count as first useful text. A source
anchor must still match, or be an allowed unfinished extension, when first displayed.
The caption-change clock starts at the first locally observed unsent change; it does not
measure audio-to-ASR latency or precisely timestamp every sentence in an imported backlog.
Fully discarded final responses are counted separately over the session. These numeric
measurements stay in memory, are reset by Start/Reset, and do not record transcripts.

Available targets: **Russian, English, Japanese, German, French, Spanish, Portuguese,
Italian, Chinese, Korean, Ukrainian and Arabic**. There is no source-language selector:
the model detects it from the text. Target language names are allowlisted by the native
host; caption text cannot supply replacement system instructions.

Settings are session-only and are not saved across page reloads. Stop before changing
the language; the next Start begins a new history so different target languages do not
get mixed together. Existing captions are skipped unless the history checkbox is enabled.

An error or timeout stops translation without an automatic reconnect. A request already
sent to the provider cannot be taken back by clicking Stop.

## Architecture and privacy

```text
content.js + captions.js → background.js → Native Messaging host.py
                         → codex app-server (stdio) → OpenAI
```

The extension runs only in the top frame of `https://meet.google.com/*` and requests
only the `nativeMessaging` permission. It reads caption text and speaker labels from
Meet's caption container. The selectors (`.nMcdL`, `.NWpY1d`, `.ygicle`) may change
when Meet updates its interface.

**After Start, caption text and speaker names are sent to OpenAI for translation.**
This can include personal or confidential company information spoken in the meeting.
There is no anonymization or sensitive-content filter. The extension does not capture
audio, avatars, cookies, other tabs or meeting URLs for the translation payload.
A local host does **not** mean a local model; follow your organization's rules before
sending meeting content. Translation uses your Codex plan's usage limits.

The extension/host code has no additional analytics or third-party upload endpoint.
It does not save transcripts in files or browser storage. The panel history lives in
memory, and translated text is rendered as text, never as HTML. Closed Shadow DOM
isolates styles; it should not be treated as a confidentiality or authorization boundary.

The host uses Codex's existing credential store rather than reading or copying tokens
itself. It runs in a temporary directory, disables configured MCP servers and agent
features/tools, sets a read-only sandbox, rejects tool/permission requests, and reuses
ephemeral threads with bounded rotation as described above. Recent source windows and
translations remain in the current thread's context until rotation or Stop. Rotation
is not a guarantee of immediate cache or server-state deletion. No API-key or model
fallback is used.

### Limits of the privacy review

These safeguards are **not a guarantee of zero data retention or complete process isolation**:

- The child Codex process inherits the environment except for `OPENAI_API_KEY`,
  `CODEX_API_KEY` and `OPENAI_BASE_URL`, which are removed. Other environment values
  are not automatically sent as caption text, but they remain available to the process.
- Codex still reads its normal configuration. This project does not override every
  telemetry, proxy, provider or managed/system setting. A configured telemetry exporter
  can send events, and prompt logging can be enabled in Codex's configuration. See
  [Codex observability and telemetry](https://learn.chatgpt.com/docs/config-file/config-advanced#observability-and-telemetry).
- Ephemeral threads and disabled local history do not guarantee absence of provider-side
  retention. Codex/OpenAI data handling also depends on their settings and policies.
- This is a source-code and local-artifact review, not a packet capture or an audit of
  the installed Codex binary, external configuration or the provider's infrastructure.

### Publishing or sharing the project

The source tree uses generic setup instructions and synthetic test captions. It does not
need your real meeting transcript, credentials, account identifiers or company-specific
configuration. The `key` in `manifest.json` is a **public extension identity key**, not
an API credential or private signing key. Keep it to preserve the extension ID.

Exclude `__pycache__/`, `*.pyc`, local credentials/configuration, logs and real meeting
samples from any shared archive. Python bytecode may embed absolute local source paths;
`.gitignore` excludes it, but manually zipping the whole directory does not honor Git's
ignore rules. The test commands below use `-B` to avoid generating new bytecode caches.

The installed launcher under `~/.local/share/meet-improve/` and Brave's native-host
manifest contain machine-specific paths by design. They are local installation artifacts,
not portable source files, and should not be published.

## Limitations

- Source language detection is performed by the model, not the extension. Translation
  quality varies by language; not every offered target has been evaluated on real meetings.
- Sentence anchors use `Intl.Segmenter` with the runtime's default locale and optional clause
  punctuation, not speech-end detection. ASR punctuation and mixed-language text can produce
  imperfect boundaries. Clause anchors retain the configured overlap but are not necessarily
  complete sentences.
- A window is limited to **48,000 source characters and 512 anchors**. Larger histories
  are drained through overlapping windows at whole-sentence/clause boundaries. If one phrase
  or the required overlap cannot fit, translation stops rather than truncating speech.
- The total source-history limit is **1,000,000 characters**. Additional source context before
  a window is limited to ten whole anchors and 6,000 characters. An entirely unpunctuated
  utterance can still grow large and slow translation; the extension refuses to truncate it.
  History is retained in memory, not virtualized away; document-reference rebuilding and
  changed-utterance segmentation can still scale with retained history/utterance length.
- DOM replacement can cause repeat translation. Corrections before the skipped startup
  history boundary can make the new-text boundary inaccurate.
- Trigger wait time is added to model response latency. Retranslating the tail uses more
  of the plan's limit than translating only the new words.

## Tests

```sh
npm test
# Without npm:
node --test tests/*.test.cjs
python3 -B -m unittest discover -s tests -p 'test_*.py'
# Synthetic CPU and payload benchmark (no provider requests):
npm run benchmark
# Compare against a saved earlier captions.js:
node tests/benchmark.cjs /path/to/earlier/captions.js
```

To make a **real** request, consuming Codex usage, with a synthetic dialogue only:

```sh
python3 -B native/host.py --smoke-test
```

For a browser fixture with a mock translator and **no OpenAI requests**:

```sh
python3 -m http.server 8765 --bind 127.0.0.1
# Open http://127.0.0.1:8765/tests/demo.html
# Click "Run browser checks" (deterministic clock / manual mock transport).
# Optional DevTools: await runRealtimeCheck() (real ticker, 6 s mock model, ~11 s).
```

Tests cover independent time/volume triggers, aggregation, overlapping tail replacement,
long unfinished phrases, corrections/deletions, partial results, stale-text hiding,
dispatch-based deadlines, coalescing of queued updates, silence, repeated ASR revisions, no-op ASR changes,
sentence caching, history limits, native validation, target-language validation,
thread reuse/rotation, stale-turn filtering, failure handling and prompt boundaries.
Schema regression tests cover exact generation-time counts (1–512), growing/shrinking
windows in reused threads, template isolation, enum-size limits, and continued rejection
of missing, duplicate and foreign anchors without retries or transcript disclosure.
The 0.6.1 schema was also accepted by Codex CLI 0.164.0 / Luna low / Standard in three
synthetic English → Russian requests on one reused thread (2 → 4 → 2 anchors); all final
IDs and streamed prefixes matched the corresponding windows. This is a small integration
check, not a reproduction or guarantee against every intermittent provider failure.
Additional tests cover soft request budgets, clause preservation, bounded continuity across
rotation, every byte split of escaped streamed JSON, preview rollback, incremental counters,
archived text-node preservation and local timing statistics. The browser fixture checks
progressive display, source corrections, selection, observer reconnection, queue deadlines,
failure/timeout behavior and layout, with no OpenAI requests.

On 2026-10-26, the included local probe compared a saved local 0.5.4 baseline with 0.6.0
(Node 26.11.1, 5,000 synthetic anchors, 60 warmed samples). Scheduling/count reads fell from
2.29 ms to below 0.001 ms median; preparation of an active-tail render update fell from
0.459 ms to 0.081 ms median. For a growing 31-clause utterance, the retranslated source window
fell from 24,613 to 8,723 characters. Including source context and translation references,
the JSON request was 24,704 vs 20,828 characters: extra continuity context has a real input cost.
These are local CPU/payload measurements, **not** DOM paint, model or real-meeting speedups.

The deterministic browser scenario passes 35 assertions (also at a 360 × 640 viewport).
A real 400-ms ticker with a synthetic 6-s model displayed its first useful anchor about
3.0 s after dispatch and dispatched the queued latest source about 6.0 s after the preceding
dispatch, without another aggregation wait. This verifies the mechanism, not actual Luna
latency. The streaming event shape was also checked against the installed Codex CLI 0.163.0
generated App Server schema. No new real-model quality evaluation was performed for 0.6.0.

A synthetic 40-request comparison on 2026-10-02 used the same evolving English → Russian
caption windows, Luna Fast / low, and alternating test order. Reusing a thread for ten
translations reduced median complete-response latency from 6.04 to 5.21 seconds (14%);
median time to first text fell from 2.34 to 1.47 seconds. Both variants handled tested
corrections to numbers, weekdays and negations. This small benchmark does not establish
the optimal rotation interval or guarantee the same gain on Standard or other languages.
It excludes process startup and caption aggregation time; production remains on Standard.

In 0.4.0, synthetic real-model checks passed for Spanish → Russian, Japanese → English,
and English → Japanese without specifying the source language (about 3.5–3.6 seconds
per request in that run). No real meeting transcript was used for these checks.

Real-meeting behavior still needs checking in Brave after each update. A successful
synthetic test is not a guarantee of translation accuracy or meeting latency.

## Uninstalling

Remove the extension and, if desired, only the files created by its installer:

- `~/.config/BraveSoftware/Brave-Origin/NativeMessagingHosts/com.meet_improve.codex.json`;
- the equivalent file under `Brave-Browser`, if installed there;
- `~/.local/share/meet-improve/native-host`.

Use your configured XDG config directory if it differs from `~/.config`.
Codex and its authentication are not removed.

## References

- [Codex App Server](https://learn.chatgpt.com/docs/app-server)
- [Structured Outputs schema constraints](https://developers.openai.com/api/docs/guides/structured-outputs)
- [Codex authentication](https://learn.chatgpt.com/docs/auth)
- [Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
