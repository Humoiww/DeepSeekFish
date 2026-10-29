#!/usr/bin/env python3
"""Render the existing socket/gateway for this host; never change Tailscale."""
import ipaddress
import json
import os
from pathlib import Path
import subprocess

if os.geteuid() != 0:
    raise SystemExit('Run with sudo; only DeepSeekFish units are installed.')
source = Path(__file__).resolve().parent.parent
target = Path('/srv/deepseekfish/app')
if not (target / 'runtime/data/webui-admin-token').is_file():
    raise SystemExit('Start deepseekfish-web.service first to create its credential.')
status = json.loads(subprocess.check_output(['tailscale', 'status', '--json']))
if status.get('BackendState') != 'Running':
    raise SystemExit('Tailscale must already be running; its configuration is not changed.')
self = status['Self']
addresses = [s for s in self['TailscaleIPs'] if ipaddress.ip_address(s).version == 4]
if len(addresses) != 1 or ipaddress.ip_address(addresses[0]) not in ipaddress.ip_network('100.64.0.0/10'):
    raise SystemExit('Expected one Tailscale IPv4 address.')
owner = str(self['UserID'])
if not owner.isdecimal():
    raise SystemExit('Tailscale owner ID missing.')
units = ['deepseekfish-tailnet.service', 'deepseekfish-tailnet.socket']
if Path('/srv/deepseekfish/napcat/state/webui-token').is_file():
    units += ['deepseekfish-napcat-gateway.service', 'deepseekfish-napcat-gateway.socket']
for name in units:
    text = (source / 'deploy' / name).read_text()
    text = text.replace('@TAILNET_IP@', addresses[0]).replace('@TAILNET_OWNER@', owner)
    p = Path('/etc/systemd/system') / name
    p.write_text(text)
    p.chmod(0o644)
subprocess.run(['systemctl', 'daemon-reload'], check=True)
subprocess.run(['systemctl', 'enable', '--now', 'deepseekfish-tailnet.socket'], check=True)
subprocess.run(['systemctl', 'restart', 'deepseekfish-tailnet.service'], check=True)
print(f'Permanent private URL: http://{addresses[0]}:17863/')
if 'deepseekfish-napcat-gateway.socket' in units:
    subprocess.run(['systemctl', 'enable', '--now', 'deepseekfish-napcat-gateway.socket'], check=True)
    subprocess.run(['systemctl', 'restart', 'deepseekfish-napcat-gateway.service'], check=True)
    print(f'Permanent private QQ login URL: http://{addresses[0]}:17864/')
