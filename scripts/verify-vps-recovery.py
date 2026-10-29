#!/usr/bin/env python3
"""One credential-free production API check and controlled crash/recovery."""
import json
import os
import pathlib
import subprocess
import time
import urllib.error
import urllib.request

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
assert status['mock'] is False and status['credentialPresent'] is False
assert status['settings']['codexQueue'] is False and status['settings']['search'] is False
assert request('/api/status', authenticated=False)[0] == 401
assert request('/api/status', extra={'Origin': 'https://example.invalid'})[0] == 403
assert request('/api/status', extra={'Host': 'example.invalid'})[0] == 403
_, session = request('/api/sessions', {})
code, result = request('/api/chat', {'sessionId': session['id'], 'text': 'deployment readiness', 'mode': 'chat'})
assert code == 400 and result['error'] == 'DEEPSEEK_KEY_MISSING'
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
assert status['mock'] is False and status['credentialPresent'] is False
restarts_after = int(subprocess.check_output(['systemctl', 'show', 'deepseekfish-web.service', '-p', 'NRestarts', '--value']))
assert restarts_after == restarts_before + 1
print('PASS: real WebUI, auth/Host/Origin checks, missing key fails closed without API call, automatic crash restart, session/token persistence')
