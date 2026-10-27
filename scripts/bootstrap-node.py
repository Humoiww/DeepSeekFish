#!/usr/bin/env python3
"""Install a verified official Linux Node runtime only inside this project."""
import hashlib
import os
from pathlib import Path, PurePosixPath
import platform
import posixpath
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request

VERSION = '24.22.1'
# From https://nodejs.org/dist/v24.22.1/SHASUMS256.txt.
CHECKSUMS = {
    'x64': '6c172a9ab6718f7b801fb5a7bd486af2ee5e32758086a04b84fcce2aa77095e6',
    'arm64': 'dbabf7a1cbf947e6059ffad2c27b80041db97dea1e553b62afdee7f13fca336e',
}
ROOT = Path(__file__).resolve().parent.parent


def no_links(p):
    current = ROOT
    for part in p.relative_to(ROOT).parts:
        current = current / part
        if current.is_symlink():
            raise RuntimeError('安装路径包含软链接，已拒绝：' + str(current))


def digest(p):
    h = hashlib.sha256()
    with p.open('rb') as f:
        for block in iter(lambda: f.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def main():
    os.umask(0o077)
    if sys.platform != 'linux':
        raise RuntimeError('自动准备 Node 当前仅支持 Linux；请手动安装 Node >=24.9。')
    arch = {'x86_64': 'x64', 'aarch64': 'arm64', 'arm64': 'arm64'}.get(platform.machine())
    if arch not in CHECKSUMS:
        raise RuntimeError('此 Linux 架构没有配置官方便携包：' + platform.machine())
    target = ROOT / 'runtime/tools/node'
    no_links(target)
    if target.exists():
        raise RuntimeError('runtime/tools/node 已存在但未通过版本检查；请保留备份后移开该目录，或用 FISH_NODE 指定有效 Node。')
    tools = ROOT / 'runtime/tools'
    cache = tools / 'downloads'
    no_links(cache)
    cache.mkdir(parents=True, exist_ok=True)
    prefix = f'node-v{VERSION}-linux-{arch}'
    archive = cache / (prefix + '.tar.xz')
    no_links(archive)
    if not archive.is_file() or digest(archive) != CHECKSUMS[arch]:
        url = f'https://nodejs.org/dist/v{VERSION}/{archive.name}'
        print(f'正在从 nodejs.org 下载 Node.js v{VERSION} ({arch})，仅安装到项目目录…', flush=True)
        fd, temporary = tempfile.mkstemp(prefix='.node-download-', dir=cache)
        try:
            total = 0
            started = time.monotonic()
            request = urllib.request.Request(url, headers={'User-Agent': 'DeepSeekFish local runtime bootstrap'})
            with os.fdopen(fd, 'wb') as output, urllib.request.urlopen(request, timeout=30) as response:
                if response.geturl() != url:
                    raise RuntimeError('下载地址发生重定向，已拒绝。')
                while True:
                    data = response.read(1024 * 1024)
                    if not data:
                        break
                    total += len(data)
                    if total > 150 * 1024 * 1024 or time.monotonic() - started > 180:
                        raise RuntimeError('Node 发行包下载超出大小或时间限制。')
                    output.write(data)
            if digest(Path(temporary)) != CHECKSUMS[arch]:
                raise RuntimeError('Node 发行包 SHA-256 不匹配，未安装。')
            os.replace(temporary, archive)
        finally:
            Path(temporary).unlink(missing_ok=True)
    print('SHA-256 校验通过，正在解压项目专用 Node/npm…', flush=True)
    with tempfile.TemporaryDirectory(prefix='.node-install-', dir=tools) as directory:
        stage = Path(directory)
        with tarfile.open(archive, 'r:xz') as bundle:
            members = bundle.getmembers()
            if len(members) > 30000 or sum(m.size for m in members) > 500 * 1024 * 1024:
                raise RuntimeError('发行包内容超出限制。')
            for member in members:
                name = PurePosixPath(member.name)
                if name.is_absolute() or '..' in name.parts or not name.parts or name.parts[0] != prefix:
                    raise RuntimeError('发行包路径不合法。')
                if not (member.isfile() or member.isdir() or member.issym() or member.islnk()):
                    raise RuntimeError('发行包包含不允许的文件类型。')
                if member.issym() or member.islnk():
                    destination = posixpath.normpath(posixpath.join(posixpath.dirname(member.name), member.linkname) if member.issym() else member.linkname)
                    if not destination.startswith(prefix + '/'):
                        raise RuntimeError('发行包链接超出安装目录。')
            # The archive is pinned and all members checked. GNU tar also rejects
            # unsafe parent traversals; staging remains inside runtime/tools.
        extract_env = dict(os.environ)
        extract_env.pop('TAR_OPTIONS', None)
        subprocess.run(['tar', '-xJf', str(archive), '-C', str(stage)], check=True, env=extract_env)
        extracted = stage / prefix
        version = subprocess.check_output([str(extracted / 'bin/node'), '--version'], text=True).strip()
        if version != 'v' + VERSION or not (extracted / 'lib/node_modules/npm/bin/npm-cli.js').is_file():
            raise RuntimeError('解压后的 Node/npm 校验失败。')
        no_links(target)
        if target.exists():
            raise RuntimeError('安装目录已存在，未覆盖。')
        extracted.rename(target)
    print(f'已准备 Node.js v{VERSION} 和 npm：runtime/tools/node/（未修改系统 Node 或 shell 配置）', flush=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('准备 Node 失败：' + str(error), file=sys.stderr)
        print('可手动解压官方 Node >=24.9 到 runtime/tools/node/，或用 FISH_NODE=/绝对路径/node 启动。', file=sys.stderr)
        sys.exit(1)
