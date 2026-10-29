#!/usr/bin/env python3
"""Reuse the already-authorized NapCat cached login on subsequent starts."""
import argparse
import json
import os
from pathlib import Path
import pwd
import re
import subprocess

p=argparse.ArgumentParser()
p.add_argument('--uin', help='Choose an existing cached account when there is more than one')
p.add_argument('--restart', action='store_true')
p.add_argument('--disable', action='store_true', help='Return to QR login after a cached identity expires')
args=p.parse_args()
if os.geteuid()!=0:
    raise SystemExit('Run with sudo to update the isolated NapCat account config.')
folder=Path('/srv/deepseekfish/napcat/state/config')
accounts=[re.fullmatch(r'napcat_(\d+)\.json',f.name)[1] for f in folder.glob('napcat_*.json') if re.fullmatch(r'napcat_(\d+)\.json',f.name)]
account='' if args.disable else args.uin or (accounts[0] if len(accounts)==1 else None)
if not args.disable and account not in accounts:
    raise SystemExit('Select an existing cached account with --uin; complete initial QR login first.')
config=folder/'webui.json'
u=pwd.getpwnam('napcat')
for parent in [folder,*folder.parents]:
    if parent.is_symlink():
        raise SystemExit('Linked config directory rejected.')
directory=os.open(folder,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
temp='webui.json.quick-login.tmp'
try:
    fd=os.open('webui.json',os.O_RDONLY|os.O_NOFOLLOW,dir_fd=directory)
    with os.fdopen(fd) as inp:
        if os.fstat(inp.fileno()).st_nlink!=1:
            raise SystemExit('Linked config file rejected.')
        data=json.load(inp)
    data['autoLoginAccount']=account
    fd=os.open(temp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=directory)
    with os.fdopen(fd,'w') as out:
        os.fchown(out.fileno(),u.pw_uid,u.pw_gid)
        json.dump(data,out,ensure_ascii=False,indent=2);out.write('\n')
    os.replace(temp,'webui.json',src_dir_fd=directory,dst_dir_fd=directory)
finally:
    os.close(directory)
if args.restart:
    subprocess.run(['systemctl','restart','deepseekfish-napcat.service'],check=True)
print('QR login selected.' if args.disable else 'Cached QQ quick login saved; no password, token or device identity was changed.')
