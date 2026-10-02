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

test('UI and native host expose the same target-language allowlist', () => {
  const output = execFileSync('python3', ['-B', '-c',
    'import json; from native.host import TARGET_LANGUAGES; print(json.dumps(sorted(TARGET_LANGUAGES)))'],
    { cwd: root, encoding: 'utf8' });
  assert.deepEqual(Object.keys(TARGET_LANGUAGES).sort(), JSON.parse(output));
});

test('extension permissions remain scoped to Meet and native messaging', () => {
  const manifest = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.permissions, ['nativeMessaging']);
  assert.deepEqual(manifest.content_scripts[0].matches, ['https://meet.google.com/*']);
  assert.equal(manifest.content_scripts[0].all_frames, undefined);
  assert.equal(manifest.externally_connectable, undefined);
  assert.equal(manifest.host_permissions, undefined);
});
