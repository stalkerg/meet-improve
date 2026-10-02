#!/usr/bin/env python3
"""Register this checkout as a native host (Linux, no root required)."""
import argparse
import json
import os
from pathlib import Path
import shlex
import shutil
import sys
from host import ROOT, extension_id

parser = argparse.ArgumentParser()
parser.add_argument('--browser-dir', type=Path, help='Brave user-data root, not Default profile')
args = parser.parse_args()
if not sys.platform.startswith('linux'):
    parser.error('This installer currently supports Linux only.')
codex = shutil.which('codex')
if not codex:
    parser.error('codex must be installed and available in PATH')
config = Path(os.environ.get('XDG_CONFIG_HOME', Path.home()/'.config'))
browsers = [args.browser_dir] if args.browser_dir else [p for p in
    (config/'BraveSoftware/Brave-Origin', config/'BraveSoftware/Brave-Browser') if p.is_dir()]
if not browsers:
    parser.error('Brave profile not found. Pass --browser-dir explicitly.')
state = Path.home()/'.local/share/meet-improve'
state.mkdir(parents=True, exist_ok=True, mode=0o700)
launcher = state/'native-host'
launcher.write_text('#!/bin/sh\n' +
    f'export PATH={shlex.quote(str(Path(codex).parent))}:"$PATH"\n' +
    f'export CODEX_HOME={shlex.quote(os.environ.get("CODEX_HOME", str(Path.home()/".codex")))}\n' +
    f'exec {shlex.quote(sys.executable)} {shlex.quote(str(ROOT/"native/host.py"))} "$@"\n')
launcher.chmod(0o700)
manifest = {'name': 'com.meet_improve.codex', 'description': 'Meet Improve local Codex translator',
    'path': str(launcher), 'type': 'stdio', 'allowed_origins': [f'chrome-extension://{extension_id()}/']}
for browser in browsers:
    directory = browser.expanduser()/'NativeMessagingHosts'
    directory.mkdir(parents=True, exist_ok=True)
    dest = directory/'com.meet_improve.codex.json'
    dest.write_text(json.dumps(manifest, indent=2)+'\n')
    print('Registered:', dest)
print('Extension ID:', extension_id())
print('Load unpacked:', ROOT)
