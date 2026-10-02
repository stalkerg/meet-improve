# Meet Improve

A Brave extension that enables text selection in Google Meet and provides a growing,
context-aware caption translation through **Codex / ChatGPT, `gpt-6-luna`, reasoning `low`**.
It uses your existing Codex sign-in with ChatGPT, not a separately billed API key.

The translator detects the source language automatically, including mixed-language speech.
Choose only the **target language**. The default is **Russian**.

## Updating to 0.5.0

1. Click **Stop** (`Стоп`) in the old panel.
2. Reload Meet Improve at `brave://extensions/`.
3. Refresh the Meet tab, choose the target language and click **Start** (`Старт`).

The extension ID remains `kekiclkdaklolmdekdpdiflkhnnnhmpn`.
You do not need to reinstall the native host unless the project directory has moved.
Version 0.5.0 keeps native protocol 3; reload the extension and refresh Meet together.

## How translation works

A request is sent when **either** condition is met:

- **4 seconds** have elapsed since the first unsent change;
- **500 new or changed characters** have accumulated.

Both thresholds are configurable before starting. They are joined by **OR**, not AND.
Only one request runs at a time, with at least one second between dispatches.
Changes arriving during generation are coalesced rather than queued as obsolete versions.

Each request translates new speech together with the **last 10 sentences**; you can
select a five-sentence overlap instead. An unfinished phrase is included whole, not
split into arbitrary character-sized chunks.

The model receives the window as **one contextual dialogue**, not separate translation
requests for each utterance. Sentence IDs are output anchors: the translated tail is
replaced in place, new text is appended, and the older prefix stays intact.
Corrections to earlier source text expand the replacement window as needed.

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

A result for speech that is still being extended may be shown as provisional. Results
for source text that has been corrected are discarded. A temporary ASR correction
that returns to the already translated text does not trigger an unnecessary request.
Sentence segmentation is cached per utterance instead of reprocessing the whole history.

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

The panel labels currently remain in Russian; the target selector changes the
**translation language**, not the interface language.

| Panel label | Meaning |
| --- | --- |
| `Старт` / `Стоп` | Start / stop translation |
| `Переводить на` | Target language; default Russian |
| `Новый текст, знаков` | New/changed character threshold: 100–4000; default 500 |
| `Ожидание, сек.` | Time threshold: 3–30 seconds; default 4 |
| `Переводить хвост` | Retranslate the last 5 or 10 sentences; default 10 |
| `Перевести уже имеющиеся субтитры` | Include captions already visible at Start |
| `Сбросить` | Stop and clear the panel history |
| `Оригинал` | Expand the original source text |
| `−` / `+` | Collapse / expand the panel without stopping translation |

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
- Sentence anchors use `Intl.Segmenter` with the runtime's default locale, not speech-end
  detection. ASR punctuation and mixed-language text can produce imperfect boundaries.
- A window is limited to **48,000 source characters and 512 anchors**. Larger histories
  are drained through overlapping windows at whole-sentence boundaries. If one sentence
  or the required overlap cannot fit, translation stops rather than truncating speech.
- The total source-history limit is **1,000,000 characters**. Additional context before
  a window is limited to ten whole sentences and 6,000 characters.
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
```

To make a **real** request, consuming Codex usage, with a synthetic dialogue only:

```sh
python3 -B native/host.py --smoke-test
```

For a browser fixture with a mock translator and **no OpenAI requests**:

```sh
python3 -m http.server 8765 --bind 127.0.0.1
# Open http://127.0.0.1:8765/tests/demo.html
```

Tests cover independent time/volume triggers, aggregation, overlapping tail replacement,
long unfinished phrases, corrections/deletions, stale results, no-op ASR changes,
sentence caching, history limits, native validation, target-language validation,
thread reuse/rotation, stale-turn filtering, failure handling and prompt boundaries.
The browser fixture is also used to check panel behavior and selection.

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
- [Codex authentication](https://learn.chatgpt.com/docs/auth)
- [Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
