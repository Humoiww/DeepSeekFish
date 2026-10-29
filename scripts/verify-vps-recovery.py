#!/usr/bin/env python3
"""Readiness check; opt-in --crash-test verifies restart without model calls."""
import argparse
import json
import os
import pathlib
import subprocess
import time
import urllib.error
import urllib.request

parser = argparse.ArgumentParser()
parser.add_argument('--crash-test', action='store_true')
args = parser.parse_args()

if os.geteuid() != 0:
    raise SystemExit('Run as root to test recovery of the installed service')
token_path = pathlib.Path('/srv/deepseekfish/app/runtime/data/webui-admin-token')
token = token_path.read_text().strip()
base = 'http://127.0.0.1:17862'

def request(route, data=None, authenticated=True, extra=None):
    headers = {'Content-Type': 'application/json'}
    if authenticated:
        headers['Authorization'] = 'Bearer ' + token
    headers.update(extra or {})
    req = urllib.request.Request(base + route, headers=headers,
                                 data=None if data is None else json.dumps(data).encode())
    try:
        with urllib.request.urlopen(req, timeout=2) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        return error.code, json.load(error)

_, status = request('/api/status')
assert status['mock'] is False
assert status['settings']['codexQueue'] is False
assert request('/api/status', authenticated=False)[0] == 401
assert request('/api/status', extra={'Origin': 'https://example.invalid'})[0] == 403
assert request('/api/status', extra={'Host': 'example.invalid'})[0] == 403
if not args.crash_test:
    print('PASS: real WebUI and auth/Host/Origin checks; no model calls or restart. Use --crash-test for an explicit crash/recovery check.')
    raise SystemExit(0)
assert status.get('active') == 0, 'Wait for active work to finish before crash testing'
_, session = request('/api/sessions', {})
restarts_before = int(subprocess.check_output(['systemctl', 'show', 'deepseekfish-web.service', '-p', 'NRestarts', '--value']))
subprocess.run(['systemctl', 'kill', '--kill-whom=main', '--signal=SIGKILL', 'deepseekfish-web.service'], check=True)
for _ in range(60):
    time.sleep(.2)
    try:
        _, status = request('/api/status')
        _, restored = request('/api/session?id=' + session['id'])
        if restored.get('id') == session['id']:
            break
    except (OSError, urllib.error.URLError):
        continue
else:
    raise SystemExit('Automatic crash recovery failed')
assert token_path.read_text().strip() == token
assert status['mock'] is False
restarts_after = int(subprocess.check_output(['systemctl', 'show', 'deepseekfish-web.service', '-p', 'NRestarts', '--value']))
assert restarts_after == restarts_before + 1
print('PASS: real WebUI, auth/Host/Origin checks, automatic crash restart and session/token persistence; no model call')
