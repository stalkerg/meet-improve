#!/usr/bin/env python3
"""Private Brave native host. No HTTP listener, API keys or transcript files."""
import hashlib
import base64
import json
import os
from pathlib import Path
import queue
import re
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import threading
import time
import tomllib

ROOT = Path(__file__).resolve().parent.parent
MODEL = 'gpt-6-luna'
EFFORT = 'low'
MAX_MESSAGE = 512 * 1024
MAX_WINDOW_CHARS = 48000
MAX_THREAD_TURNS = 10
MAX_THREAD_TOKENS = 16000
TARGET_LANGUAGES = {'ru': 'Russian', 'en': 'English', 'ja': 'Japanese', 'de': 'German',
    'fr': 'French', 'es': 'Spanish', 'pt': 'Portuguese', 'it': 'Italian',
    'zh': 'Chinese', 'ko': 'Korean', 'uk': 'Ukrainian', 'ar': 'Arabic'}
INSTRUCTIONS = (ROOT / 'native/translator-prompt.txt').read_text()
SCHEMA = {'type': 'object', 'properties': {
    'windowId': {'type': 'string'},
    'segments': {'type': 'array', 'items': {'type': 'object', 'properties': {
        'id': {'type': 'string'}, 'text': {'type': 'string'}},
        'required': ['id', 'text'], 'additionalProperties': False}}},
    'required': ['windowId', 'segments'], 'additionalProperties': False}


def extension_id():
    key = json.loads((ROOT / 'manifest.json').read_text())['key']
    digest = hashlib.sha256(base64.b64decode(key)).hexdigest()[:32]
    return ''.join(chr(ord('a') + int(x, 16)) for x in digest)


def read_exact(stream, count):
    result = b''
    while len(result) < count:
        part = stream.read(count - len(result))
        if not part:
            if not result:
                return None
            raise ValueError('Truncated native message')
        result += part
    return result


def read_message(stream):
    header = read_exact(stream, 4)
    if header is None:
        return None
    length = struct.unpack('=I', header)[0]
    if not 0 < length <= MAX_MESSAGE:
        raise ValueError('Invalid native message length')
    payload = read_exact(stream, length)
    if payload is None:
        raise ValueError('Missing native message body')
    return json.loads(payload)


def write_message(message, stream=None):
    stream = stream or sys.stdout.buffer
    data = json.dumps(message, ensure_ascii=False).encode()
    if len(data) > MAX_MESSAGE:
        raise ValueError('Response too large')
    stream.write(struct.pack('=I', len(data)) + data)
    stream.flush()


def validate_segments(items, limit=512, max_chars=MAX_WINDOW_CHARS):
    if not isinstance(items, list) or len(items) > limit:
        raise ValueError('Invalid item count')
    result, ids = [], set()
    for item in items:
        if not isinstance(item, dict):
            raise ValueError('Invalid item')
        ident, text, speaker = item.get('id'), item.get('text'), item.get('speaker', '')
        if not isinstance(ident, str) or not 0 < len(ident) <= 100 or ident in ids:
            raise ValueError('Invalid or duplicate item ID')
        if not isinstance(text, str) or not text.strip() or len(text) > max_chars:
            raise ValueError('Invalid subtitle text')
        if not isinstance(speaker, str) or len(speaker) > 200:
            raise ValueError('Invalid speaker')
        ids.add(ident)
        result.append({'id': ident, 'text': text, 'speaker': speaker})
    if sum(len(item['text']) for item in result) > max_chars:
        raise ValueError('Window exceeds text limit; refusing to truncate speech')
    return result


def validate_window(window):
    if not isinstance(window, dict):
        raise ValueError('Missing dialogue window; reload the extension')
    ident = window.get('id')
    if not isinstance(ident, str) or not re.fullmatch(r'window-[0-9]+', ident):
        raise ValueError('Invalid window ID')
    segments = validate_segments(window.get('segments'))
    if not segments:
        raise ValueError('Empty dialogue window')
    return {'id': ident, 'segments': segments}


def translation_instructions(target_language):
    if not isinstance(target_language, str) or target_language not in TARGET_LANGUAGES:
        raise ValueError('Unsupported target language; reload the extension')
    # Only allowlisted language names reach instructions; never interpolate meeting text here.
    return INSTRUCTIONS + f'\nTARGET LANGUAGE: {TARGET_LANGUAGES[target_language]} ({target_language}).\n'


class Codex:
    def __init__(self):
        self.proc = None
        self.work = None
        self.counter = 0
        self.events = queue.Queue()
        self.cancelled = threading.Event()
        self._clear_thread()

    def _clear_thread(self):
        self.thread = None
        self.thread_language = None
        self.thread_turns = 0
        self.thread_tokens = None

    def start(self):
        codex = shutil.which('codex')
        if not codex:
            raise RuntimeError('Codex was not found in PATH. Install the CLI.')
        self.work = tempfile.TemporaryDirectory(prefix='meet-improve-')
        cwd = Path(self.work.name)
        instructions = cwd / 'translator.txt'
        instructions.write_text(INSTRUCTIONS)
        # Keep the user's standard ChatGPT credential store; do not copy/read tokens.
        # Override user configuration for this process only, never edit their config.
        home = Path(os.environ.get('CODEX_HOME', str(Path.home() / '.codex')))
        config_path = home / 'config.toml'
        config = tomllib.loads(config_path.read_text()) if config_path.exists() else {}
        settings = {
            'model': MODEL, 'model_provider': 'openai', 'model_reasoning_effort': EFFORT,
            'forced_login_method': 'chatgpt', 'approval_policy': 'never',
            'approvals_reviewer': 'user', 'sandbox_mode': 'read-only',
            'web_search': 'disabled', 'project_doc_max_bytes': 0,
            'model_instructions_file': str(instructions),
            'developer_instructions': INSTRUCTIONS, 'notify': [],
            'history.persistence': 'none', 'service_tier': 'default',
        }
        for name in ['shell_tool', 'unified_exec', 'apps', 'plugins', 'remote_plugin',
                     'multi_agent', 'multi_agent_v2', 'hooks', 'memories', 'goals',
                     'browser_use', 'browser_use_external', 'computer_use',
                     'image_generation', 'in_app_browser', 'realtime_conversation']:
            settings[f'features.{name}'] = False
        # Disable every configured MCP server before app-server starts.
        for name in config.get('mcp_servers', {}):
            if not re.fullmatch(r"[A-Za-z0-9_-]+", name):
                raise RuntimeError("Unsupported MCP name in config; cannot safely isolate translator")
            settings[f'mcp_servers.{name}.enabled'] = False
        args = [codex, 'app-server']
        for key, value in settings.items():
            args += ['-c', f'{key}={json.dumps(value, ensure_ascii=False)}']
        env = dict(os.environ)
        for key in ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL']:
            env.pop(key, None)
        if self.cancelled.is_set():
            raise RuntimeError('Translation cancelled.')
        self.proc = subprocess.Popen(args, cwd=cwd, env=env, stdin=subprocess.PIPE,
                                     stdout=subprocess.PIPE, stderr=None if sys.argv[1:] == ['--smoke-test'] else subprocess.DEVNULL,
                                     text=True, encoding='utf-8', start_new_session=True)
        def reader():
            try:
                for line in self.proc.stdout:
                    self.events.put(json.loads(line))
            except Exception:
                pass
            finally:
                self.events.put(None)
        threading.Thread(target=reader, daemon=True).start()
        self.rpc('initialize', {'clientInfo': {'name': 'meet_improve', 'version': '0.5.1'},
                               'capabilities': {'experimentalApi': True}})
        self.send({'method': 'initialized', 'params': {}})
        account = self.rpc('account/read', {'refreshToken': False}).get('account')
        if not account or account.get('type') != 'chatgpt':
            raise RuntimeError('Codex must be signed in with ChatGPT. API-key mode is disabled; contact the owner.')
        cursor, found = None, None
        while True:
            page = self.rpc('model/list', {'includeHidden': True, 'cursor': cursor})
            found = next((m for m in page['data'] if m['model'] == MODEL), found)
            cursor = page.get('nextCursor')
            if not cursor:
                break
        if not found or not any(e['reasoningEffort'] == EFFORT for e in found['supportedReasoningEfforts']):
            raise RuntimeError('gpt-6-luna / low is unavailable. No fallback model will be selected.')
        return {'model': MODEL, 'effort': EFFORT, 'auth': 'chatgpt', 'protocol': 3}

    def send(self, message):
        self.proc.stdin.write(json.dumps(message, ensure_ascii=False) + '\n')
        self.proc.stdin.flush()

    def next_event(self, deadline):
        while True:
            if self.cancelled.is_set():
                raise RuntimeError('Translation cancelled.')
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise RuntimeError('Codex did not respond within 90 seconds; translation stopped.')
            try:
                event = self.events.get(timeout=min(0.5, remaining))
                break
            except queue.Empty:
                continue
        if event is None:
            raise RuntimeError('Codex exited. Check the CLI and ChatGPT sign-in.')
        if 'method' in event and 'id' in event:
            # Never grant tool/permission/auth requests from the translator.
            self.send({'id': event['id'], 'error': {'code': -32601, 'message': 'Translator has no tools'}})
            raise RuntimeError('Codex requested a tool or permission; translation stopped.')
        if event.get('method') == 'error':
            raise RuntimeError('Codex error: ' + str(event.get('params', {}).get('message', 'request failed')))
        return event

    def rpc(self, method, params):
        self.counter += 1
        ident = self.counter
        self.send({'id': ident, 'method': method, 'params': params})
        deadline = time.monotonic() + 90
        while True:
            event = self.next_event(deadline)
            if event.get('id') == ident:
                if 'error' in event:
                    raise RuntimeError(str(event['error'].get('message', 'Codex RPC failed')))
                return event['result']

    def _translation_thread(self, target_language):
        # Rotate before the next request, without rewriting or compacting old messages.
        # Missing usage falls back to a fresh thread rather than unbounded history.
        if self.thread and (self.thread_language != target_language or
                            self.thread_turns >= MAX_THREAD_TURNS or
                            self.thread_tokens is None or self.thread_tokens >= MAX_THREAD_TOKENS):
            self.rpc('thread/unsubscribe', {'threadId': self.thread})
            self._clear_thread()
        if self.thread:
            return self.thread
        instructions = translation_instructions(target_language)
        started = self.rpc('thread/start', {
            'model': MODEL, 'modelProvider': 'openai', 'ephemeral': True,
            'cwd': self.work.name, 'sandbox': 'read-only', 'approvalPolicy': 'never',
            'baseInstructions': instructions, 'developerInstructions': instructions,
            'environments': [], 'allowProviderModelFallback': False,
            'config': {'model_reasoning_effort': EFFORT},
        })
        if started['model'] != MODEL or started.get('reasoningEffort') != EFFORT:
            raise RuntimeError('Codex changed the model or reasoning effort; translation stopped.')
        self.thread = started['thread']['id']
        self.thread_language = target_language
        return self.thread

    def translate(self, window, context, target_language):
        # Validate before any RPC. One window remains one contextual translation.
        translation_instructions(target_language)
        window = validate_window(window)
        context = validate_segments(context, limit=10, max_chars=6000)
        try:
            if self.cancelled.is_set():
                raise RuntimeError('Translation cancelled.')
            thread = self._translation_thread(target_language)
            self.thread_tokens = None
            result = self._translate_window(thread, window, context)
            self.thread_turns += 1
            return result
        except Exception:
            # Never reuse a failed/partial turn or retry authentication/model requests.
            self.cancelled.set()
            self._clear_thread()
            raise

    def _translate_window(self, thread, window, context):
        started = self.rpc('turn/start', {'threadId': thread, 'model': MODEL, 'effort': EFFORT,
            'input': [{'type': 'text', 'text': json.dumps({'context': context, 'window': window}, ensure_ascii=False)}],
            'outputSchema': SCHEMA})
        turn_id = started['turn']['id']
        deadline = time.monotonic() + 90
        outputs = []
        while True:
            event = self.next_event(deadline)
            params = event.get('params', {})
            if params.get('threadId') != thread:
                continue
            # Reused threads can still have notifications queued from earlier turns.
            event_turn = params.get('turnId') or params.get('turn', {}).get('id')
            if event_turn != turn_id:
                continue
            if event.get('method') == 'thread/tokenUsage/updated':
                tokens = params.get('tokenUsage', {}).get('last', {}).get('totalTokens')
                if type(tokens) is int and tokens > 0:
                    self.thread_tokens = tokens
            if event.get('method') == 'item/completed':
                item = params['item']
                if item['type'] == 'agentMessage':
                    outputs.append(item['text'])
                elif item['type'] not in ('userMessage', 'reasoning'):
                    raise RuntimeError('Unexpected Codex action; translation stopped.')
            if event.get('method') == 'turn/completed':
                turn = params['turn']
                if turn['status'] != 'completed':
                    raise RuntimeError('Codex: ' + str((turn.get('error') or {}).get('message', turn['status'])))
                break
        result = json.loads(outputs[-1] if outputs else '{}')
        if not isinstance(result, dict) or result.get('windowId') != window['id']:
            raise RuntimeError('Translation window ID does not match')
        segments = result.get('segments')
        if not isinstance(segments, list) or len(segments) != len(window['segments']):
            raise RuntimeError('Incorrect number of translation anchors')
        translated = {}
        for item in segments:
            if not isinstance(item, dict) or not isinstance(item.get('id'), str):
                raise RuntimeError('Invalid translation anchor')
            if item['id'] in translated or not isinstance(item.get('text'), str) or not item['text'].strip():
                raise RuntimeError('Duplicate anchor or empty translation')
            translated[item['id']] = item['text']
        if set(translated) != {item['id'] for item in window['segments']}:
            raise RuntimeError('Translation anchors do not match')
        if sum(map(len, translated.values())) > 96000:
            raise RuntimeError('Translation is too large')
        result['segments'] = [{'id': item['id'], 'text': translated[item['id']]} for item in window['segments']]
        return result

    def close(self):
        self._clear_thread()
        if self.proc and self.proc.poll() is None:
            try:
                os.killpg(self.proc.pid, signal.SIGTERM)
                self.proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                os.killpg(self.proc.pid, signal.SIGKILL)
                self.proc.wait()
            except ProcessLookupError:
                pass
        if self.work:
            self.work.cleanup()


def run_native():
    expected = f'chrome-extension://{extension_id()}/'
    if len(sys.argv) < 2 or sys.argv[1] != expected:
        raise SystemExit('Launch via the Meet Improve extension only.')
    inbox = queue.Queue(maxsize=2)
    engine = Codex()
    def reader():
        try:
            while True:
                message = read_message(sys.stdin.buffer)
                if message is None:
                    break
                inbox.put_nowait(message)
        except Exception:
            pass
        finally:
            # Disconnect/Stop must cancel even while a translation is waiting.
            engine.cancelled.set()
            if engine.proc and engine.proc.poll() is None:
                try:
                    os.killpg(engine.proc.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
            try:
                inbox.put_nowait(None)
            except queue.Full:
                os._exit(1)
    threading.Thread(target=reader, daemon=True).start()
    try:
        first = inbox.get()
        if not isinstance(first, dict) or first.get('type') != 'hello':
            return
        if first.get('protocol') != 3:
            raise ValueError('Version mismatch. Reload Meet Improve and restart translation.')
        write_message({'type': 'ready', **engine.start()})
        while True:
            message = inbox.get()
            if message is None:
                return
            if not isinstance(message, dict) or message.get('type') != 'translate':
                raise ValueError('Unknown native request')
            if not isinstance(message.get('requestId'), int) or isinstance(message['requestId'], bool):
                raise ValueError('Invalid request ID')
            started = time.monotonic()
            result = engine.translate(message.get('window'), message.get('context', []), message.get('targetLanguage'))
            write_message({'type': 'result', 'requestId': message['requestId'], **result,
                           'elapsedMs': round((time.monotonic()-started)*1000)})
    except Exception as exc:
        # No automatic reconnects, authentication retries or API fallback.
        try:
            write_message({'type': 'error', 'message': str(exc)[:1000]})
        except (BrokenPipeError, OSError):
            pass
    finally:
        engine.close()


if __name__ == '__main__':
    if sys.argv[1:] == ['--smoke-test']:
        engine = Codex()
        try:
            print(json.dumps(engine.start()))
            begin = time.monotonic()
            result = engine.translate({'id': 'window-1', 'segments': [
                {'id': '1', 'speaker': 'A', 'text': '新機能の説明用に資料を作っています。明日の会議で画面を共有します。'},
                {'id': '2', 'speaker': 'B', 'text': 'その飼料に、設定手順と画面の例も入れてください。'},
                {'id': '3', 'speaker': 'A', 'text': 'はい。操作マニュアルの内容も確認してから、資料を更新します。'},
            ]}, [], 'ru')
            print(json.dumps({'result': result, 'seconds': round(time.monotonic()-begin, 2)}, ensure_ascii=False))
        finally:
            engine.close()
    else:
        run_native()
