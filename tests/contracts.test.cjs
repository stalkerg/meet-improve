const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { TARGET_LANGUAGES } = require('../captions.js');
const root = path.resolve(__dirname, '..');

test('package and extension versions match', () => {
  const manifest = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(manifest.version, pkg.version);
});

test('UI and native host expose the same target languages with English names', () => {
  const output = execFileSync('python3', ['-B', '-c',
    'import json; from native.host import TARGET_LANGUAGES; print(json.dumps(TARGET_LANGUAGES))'],
    { cwd: root, encoding: 'utf8' });
  assert.deepEqual(TARGET_LANGUAGES, JSON.parse(output));
});

test('extension-owned UI and error copy has no leftover Russian text', () => {
  for (const file of ['content.js', 'captions.js', 'panel.js', 'background.js', 'native/host.py', 'manifest.json']) {
    assert.doesNotMatch(readFileSync(path.join(root, file), 'utf8'), /\p{Script=Cyrillic}/u, file);
  }
  const content = readFileSync(path.join(root, 'content.js'), 'utf8');
  assert.match(content, /host\.lang = 'en'/);
  assert.match(content, /host\.dir = 'ltr'/);
});

test('panel helper is loaded before the content script in extension and browser fixture', () => {
  const scripts = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8')).content_scripts[0].js;
  assert.deepEqual(scripts, ['captions.js', 'panel.js', 'content.js']);
  const demo = readFileSync(path.join(root, 'tests/demo.html'), 'utf8');
  assert.match(demo, /src="\.\.\/panel\.js"[\s\S]*src="\.\.\/content\.js"/);
});

test('extension permissions remain scoped to Meet and native messaging', () => {
  const manifest = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.permissions, ['nativeMessaging']);
  assert.deepEqual(manifest.content_scripts[0].matches, ['https://meet.google.com/*']);
  assert.equal(manifest.content_scripts[0].all_frames, undefined);
  assert.equal(manifest.externally_connectable, undefined);
  assert.equal(manifest.host_permissions, undefined);
});

test('native protocol and client version stay aligned across extension, host and fixture', () => {
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const host = readFileSync(path.join(root, 'native/host.py'), 'utf8');
  const background = readFileSync(path.join(root, 'background.js'), 'utf8');
  const content = readFileSync(path.join(root, 'content.js'), 'utf8');
  const fixture = readFileSync(path.join(root, 'tests/demo.html'), 'utf8');
  assert.ok(host.includes(`'version': '${pkg.version}'`));
  assert.match(host, /first\.get\('protocol'\) != 4/);
  assert.match(host, /'protocol': 4/);
  assert.match(background, /protocol: 4/);
  assert.match(content, /message\.protocol !== 4/);
  assert.match(fixture, /protocol:4/);
});
