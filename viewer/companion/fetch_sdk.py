"""Restore the pinned WebView2 SDK without adding binary dependencies to Git."""
from pathlib import Path
import argparse
import hashlib
import json
import os
import tempfile
import urllib.request
import zipfile

HERE = Path(__file__).resolve().parent


def file_hash(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true', help='Validate installed SDK files without downloading or changing them.')
    args = parser.parse_args()
    lock = json.loads((HERE / 'webview2.lock.json').read_text(encoding='utf-8'))
    destination = HERE / 'webview2-sdk'
    missing = []
    for member in lock['files']:
        path = destination / member['name']
        if path.is_file() and file_hash(path) == member['sha256']:
            continue
        if path.exists():
            raise SystemExit('SDK file differs from the lock; preserved for review: ' + str(path))
        missing.append(member)
    if not missing:
        print('WebView2 SDK ' + lock['version'] + ' verified.')
        return
    if args.check:
        raise SystemExit('WebView2 SDK is missing. Run: python viewer/companion/fetch_sdk.py')
    with tempfile.TemporaryDirectory(prefix='.zjf-sdk-', dir=HERE) as stage:
        package = Path(stage) / 'sdk.nupkg'
        request = urllib.request.Request(lock['url'], headers={'User-Agent': 'Zhiyun-Focus-SDK-setup'})
        digest = hashlib.sha256()
        size = 0
        with urllib.request.urlopen(request, timeout=30) as response, package.open('wb') as output:
            while chunk := response.read(1024 * 1024):
                size += len(chunk)
                if size > lock['bytes']:
                    raise RuntimeError('SDK package exceeds the pinned size')
                digest.update(chunk)
                output.write(chunk)
        if size != lock['bytes'] or digest.hexdigest() != lock['sha256']:
            raise RuntimeError('SDK package does not match its pinned digest')
        with zipfile.ZipFile(package) as archive:
            for member in missing:
                data = archive.read(member['archive_path'])
                if hashlib.sha256(data).hexdigest() != member['sha256']:
                    raise RuntimeError('SDK member does not match: ' + member['name'])
                (Path(stage) / member['name']).write_bytes(data)
        destination.mkdir(exist_ok=True)
        for member in missing:
            target = destination / member['name']
            if target.exists():
                if not target.is_file() or file_hash(target) != member['sha256']:
                    raise RuntimeError('SDK destination changed; existing file preserved')
            else:
                os.replace(Path(stage) / member['name'], target)
    print('WebView2 SDK ' + lock['version'] + ' installed.')


if __name__ == '__main__':
    main()
