"""Build replaceable application files from source, without including fixtures."""
from pathlib import Path
import argparse
import hashlib
import html
import json
import os
import re
import tempfile
from urllib.parse import quote

ROOT = Path(__file__).resolve().parent
VIEWER_ENTRY = 'src/focus.js'
RECEIVER_ENTRY = 'chat/draft-receiver.js'
RELEASE_FILES = ('bookmarklet.txt', 'capture-receiver.js', 'focus-entry.js', 'index.html')
IMPORT = re.compile(r'''^[ \t]*import\s+(?:(?P<bindings>[\s\S]*?)\s+from\s+)?(?P<quote>['"])(?P<path>[^'"]+)(?P=quote)\s*;[ \t]*(?:\n|$)''', re.M)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def bundle(entry, inputs, texts):
    ordered, visiting, visited = [], set(), set()

    def visit(name):
        if name in visiting:
            raise ValueError('Circular local import: ' + name)
        if name in visited:
            return
        visiting.add(name)
        path = ROOT / name
        data = path.read_bytes()
        source = data.decode('utf-8').replace('\r\n', '\n')
        inputs[name], texts[name] = data, source
        for match in IMPORT.finditer(source):
            reference, bindings = match['path'], match['bindings']
            if not reference.startswith(('./', '../')):
                raise ValueError('Only local relative imports may be bundled: ' + reference)
            if bindings and (not bindings.strip().startswith('{') or re.search(r'\bas\b', bindings)):
                raise ValueError('Unsupported import binding in ' + name)
            target = (path.parent / reference).resolve()
            try:
                dependency = target.relative_to(ROOT).as_posix()
            except ValueError:
                raise ValueError('Import leaves the application source: ' + reference) from None
            if target.suffix != '.js':
                raise ValueError('Imported source must be JavaScript: ' + reference)
            visit(dependency)
        source = IMPORT.sub('', source)
        if re.search(r'^[ \t]*import\b', source, re.M):
            raise ValueError('Unrecognized import statement in ' + name)
        source = re.sub(r'^[ \t]*export\s+(?=(?:async\s+)?function\b|(?:class|const|let|var)\b)', '', source, flags=re.M)
        if re.search(r'^[ \t]*export\b', source, re.M):
            raise ValueError('Unsupported export statement in ' + name)
        ordered.append(source)
        visiting.remove(name)
        visited.add(name)

    visit(entry)
    return '\n'.join(ordered)


def generate():
    # Read every input before touching an output. Invalid source must not leave a
    # partly regenerated application next to a previous manifest.
    input_names = ['package.json', 'build.py', 'src/start.html']
    inputs = {name: (ROOT / name).read_bytes() for name in input_names}
    text = {name: data.decode('utf-8').replace('\r\n', '\n') for name, data in inputs.items()}
    body = bundle(VIEWER_ENTRY, inputs, text)
    receiver = bundle(RECEIVER_ENTRY, inputs, text)
    if body.count('__ZJF_VIEWER_BUILD_ID__') != 1:
        raise ValueError('The viewer build identity placeholder is missing or duplicated.')
    viewer_build = digest(body.encode())
    body = body.replace('__ZJF_VIEWER_BUILD_ID__', viewer_build)
    version = json.loads(text['package.json'])['version']
    if not re.fullmatch(r'\d+\.\d+\.\d+', version):
        raise ValueError('The package version must use major.minor.patch.')
    focus_version = re.search(r"const VERSION\s*=\s*'([^']+)'", text['src/focus.js'])
    if not focus_version or focus_version.group(1) != version:
        raise ValueError('The bookmark source and package versions do not match.')
    if '智云聚焦 · ' + version not in text['src/start.html']:
        raise ValueError('The entry page and package versions do not match.')
    receiver = "(()=>{if(location.origin!=='https://chatgpt.com'||window.top!==window)return;\n" + receiver + '\ninstallDraftReceiver();})();'
    payload = '(()=>{\n' + body + '\nactivateFocus();\n})()'
    bookmark = 'javascript:' + quote(payload, safe="()'!~*.-_")
    document = text['src/start.html'].replace('__BOOKMARK__', html.escape(bookmark, quote=True))
    document = document.replace('__CODE_SHA__', digest(payload.encode()))
    artifacts = {
        'bookmarklet.txt': bookmark.encode(),
        'capture-receiver.js': receiver.encode(),
        'focus-entry.js': ('(()=>{\n' + body + '\nwindow.activateZhiyunFocus=activateFocus;\n})();').encode(),
        'index.html': document.encode(),
    }
    manifest = {
        'version': version,
        'viewer_build_id': viewer_build,
        'bundle_sha256': digest(payload.encode()),
        'receiver_sha256': digest(artifacts['capture-receiver.js']),
        'bookmark_bytes': len(artifacts['bookmarklet.txt']),
        'network_in_viewer': True,
        'network_scope': 'Uses approved course media and loopback 8771/8772. Region capture saves the original frame context and copies the selected image. A separate user question action attaches the chosen material to the embedded ChatGPT draft. User submits messages.',
        'files': {name: digest(artifacts[name]) for name in RELEASE_FILES},
        'sources': {name: digest(data) for name, data in inputs.items()},
    }
    artifacts['build.json'] = (json.dumps(manifest, ensure_ascii=False, indent=2) + '\n').encode()
    return artifacts, manifest, bookmark


def commit_files(files):
    """Stage all outputs, replace files atomically, and undo a failed commit."""
    staged = []
    applied = []
    try:
        for destination, data in files.items():
            destination.parent.mkdir(parents=True, exist_ok=True)
            old = destination.read_bytes() if destination.exists() else None
            with tempfile.NamedTemporaryFile(dir=destination.parent, prefix='.zjf-build-', delete=False) as stream:
                temporary = Path(stream.name)
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            staged.append((destination, temporary, old))
        for destination, temporary, old in staged:
            os.replace(temporary, destination)
            applied.append((destination, old))
    except BaseException:
        for destination, old in reversed(applied):
            if old is None:
                destination.unlink(missing_ok=True)
            else:
                with tempfile.NamedTemporaryFile(dir=destination.parent, prefix='.zjf-rollback-', delete=False) as stream:
                    rollback = Path(stream.name)
                    stream.write(old)
                    stream.flush()
                    os.fsync(stream.fileno())
                os.replace(rollback, destination)
        raise
    finally:
        for _, temporary, _ in staged:
            temporary.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output-dir', type=Path, help='Generate into this directory without modifying the normal entry page.')
    parser.add_argument('--entry-path', type=Path, help='Also write the requested standalone entry page.')
    parser.add_argument('--check', action='store_true', help='Verify existing release outputs against current source; do not write.')
    args = parser.parse_args()
    output = (args.output_dir or ROOT / 'dist').resolve()
    entry = args.entry_path or (ROOT.parent / '打开智云聚焦.html' if args.output_dir is None else None)
    artifacts, manifest, bookmark = generate()
    if args.check:
        stale = [name for name, data in artifacts.items() if not (output / name).is_file() or (output / name).read_bytes() != data]
        if entry is not None and (not entry.is_file() or entry.read_bytes() != artifacts['index.html']):
            stale.append(str(entry))
        if stale:
            raise SystemExit('Source and build outputs differ: ' + ', '.join(stale))
    else:
        files = {output / name: data for name, data in artifacts.items()}
        if entry is not None:
            files[entry.resolve()] = artifacts['index.html']
        commit_files(files)
    print(json.dumps(manifest, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
