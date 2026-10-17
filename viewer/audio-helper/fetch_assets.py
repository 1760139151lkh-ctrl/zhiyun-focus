"""Download only the pinned model/source assets, verifying each SHA-256."""
from pathlib import Path
import hashlib
import json
import os
import tempfile
import urllib.request

from runtime import runtime_home

HERE = Path(__file__).resolve().parent


def file_hash(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def install_asset(home, asset):
    target = (home / asset['path']).resolve()
    if not target.is_relative_to(home.resolve()):
        raise ValueError('Asset path leaves the selected runtime directory')
    if target.exists():
        if target.is_file() and target.stat().st_size == asset['bytes'] and file_hash(target) == asset['sha256']:
            print('Verified:', asset['path'])
            return
        raise RuntimeError('Existing asset differs; preserved for review: ' + asset['path'])
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        request = urllib.request.Request(asset['url'], headers={'User-Agent': 'Zhiyun-Focus-asset-setup'})
        digest = hashlib.sha256()
        size = 0
        with urllib.request.urlopen(request, timeout=30) as response, tempfile.NamedTemporaryFile(
                dir=target.parent, prefix='.zjf-download-', delete=False) as output:
            temporary = Path(output.name)
            while chunk := response.read(1024 * 1024):
                size += len(chunk)
                if size > asset['bytes']:
                    raise RuntimeError('Asset exceeds the pinned size: ' + asset['path'])
                digest.update(chunk)
                output.write(chunk)
            output.flush()
            os.fsync(output.fileno())
        if size != asset['bytes'] or digest.hexdigest() != asset['sha256']:
            raise RuntimeError('Asset does not match its pinned digest: ' + asset['path'])
        if target.exists():
            if not target.is_file() or file_hash(target) != asset['sha256']:
                raise RuntimeError('Asset changed during download; existing file preserved')
        else:
            os.replace(temporary, target)
        print('Installed:', asset['path'])
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def main():
    lock = json.loads((HERE / 'assets.lock.json').read_text(encoding='utf-8'))
    home = runtime_home()
    print('Runtime assets:', home)
    for asset in lock['files']:
        install_asset(home, asset)
    print('Model and source verified. Python packages and FFmpeg are installed separately; see README.md.')


if __name__ == '__main__':
    main()
