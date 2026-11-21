#!/usr/bin/env python3
"""Read an admitted ZIP as DATA; derive a bounded, non-executable toolchain plan.
No source files are run, imported, installed, or written into Contract-Automation.
Only exact, registry-backed npm dependency manifests may be prepared."""
import hashlib
import json
import os
import re
import stat
import sys
import zipfile
from pathlib import Path, PurePosixPath

SOURCE_MAX = 250 * 1024 * 1024
READ_LIMIT = 4 * 1024 * 1024
SRC = re.compile(r'\.(?:sol|vy)$', re.I)
EXACT = re.compile(r'^\d+\.\d+\.\d+$')
VERSION = re.compile(r'(?<!\d)(\d+\.\d+\.\d+)(?!\d)')
NAME = re.compile(r'^(@[a-z0-9._-]+/)?[a-z0-9._-]+$')
REGISTRY = 'https://registry.npmjs.org/'

def digest(data):
    return hashlib.sha256(data).hexdigest()

def relpath(value):
    value = value.rstrip('/')
    if not value or value.startswith('/') or '\\' in value or re.match(r'^[A-Za-z]:', value):
        raise ValueError('UNSAFE_ARCHIVE_PATH')
    parts = value.split('/')
    if any(part in ('', '.', '..') for part in parts):
        raise ValueError('UNSAFE_ARCHIVE_COMPONENT')
    return value

def exact_dep(spec):
    if not isinstance(spec, str):
        return False
    if EXACT.fullmatch(spec):
        return True
    if spec.startswith('npm:'):
        match = re.fullmatch(r'npm:(@[a-z0-9._-]+/[a-z0-9._-]+|[a-z0-9._-]+)@(\d+\.\d+\.\d+)', spec)
        return bool(match)
    return False

def source_root(name):
    parts = name.split('/')
    for i, value in enumerate(parts):
        if value in ('contracts', 'src') and i + 1 < len(parts):
            return '/'.join(parts[:i]) or '.'
    return '/'.join(parts[:-1]) or '.'

def main(source_zip, output_dir):
    output = Path(output_dir)
    output.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(source_zip) as zipf:
        entries = {}
        total = 0
        for item in zipf.infolist():
            key = relpath(item.filename)
            if key in entries:
                raise ValueError('DUPLICATE_ARCHIVE_PATH')
            mode = (item.external_attr >> 16) & 0xFFFF
            if stat.S_IFMT(mode) == stat.S_IFLNK:
                raise ValueError('ARCHIVE_SYMLINK_NOT_ALLOWED')
            if item.is_dir():
                continue
            total += item.file_size
            if total > SOURCE_MAX or len(entries) > 10000:
                raise ValueError('ARCHIVE_SOURCE_CAP_EXCEEDED')
            entries[key] = item

        important = {}
        for name, item in entries.items():
            base = name.rsplit('/', 1)[-1]
            if SRC.search(name) or base in ('foundry.toml', 'package.json', 'package-lock.json',
                                            'npm-shrinkwrap.json', 'scan-source-manifest.json') or \
               re.fullmatch(r'hardhat\.config\.(?:js|cjs|mjs|ts)', base):
                if item.file_size <= READ_LIMIT:
                    important[name] = zipf.read(item)

    sources = sorted(p for p in important if SRC.search(p))
    if not sources:
        raise ValueError('NO_SOLIDITY_OR_VYPER_SOURCE_IN_ARCHIVE')
    candidates = set(source_root(p) for p in sources)
    for name in important:
        if name.endswith(('/foundry.toml', '/package.json', '/hardhat.config.js',
                          '/hardhat.config.ts', '/hardhat.config.cjs', '/hardhat.config.mjs')) or \
           name in ('foundry.toml', 'package.json', 'hardhat.config.js', 'hardhat.config.ts'):
            candidates.add('/'.join(name.split('/')[:-1]) or '.')
    roots = []
    for root in sorted(candidates):
        prefix = '' if root == '.' else root + '/'
        child = [p for p in sources if p.startswith(prefix)]
        if not child:
            continue
        roots.append({'relativePath': root, 'languages': sorted(set('VYPER' if p.endswith('.vy') else 'SOLIDITY' for p in child)),
                      'sourceCount': len(child), 'configuration': sorted(p for p in important if p.startswith(prefix) and
                      p[len(prefix):] in ('foundry.toml', 'package.json', 'package-lock.json', 'hardhat.config.js',
                                         'hardhat.config.ts', 'scan-source-manifest.json'))})
    pragmas = []
    solc_versions = set()
    vyper_versions = set()
    unsupported = []
    for name in sources:
        txt = important[name].decode('utf-8', 'replace')
        if name.endswith('.sol'):
            for match in re.finditer(r'\bpragma\s+solidity\s+([^;]+);', txt):
                constraint = match.group(1).strip()
                hit = VERSION.search(constraint)
                if hit:
                    solc_versions.add(hit.group(1))
                else:
                    unsupported.append({'path': name, 'reason': 'UNRESOLVED_SOLIDITY_PRAGMA', 'constraint': constraint[:160]})
                pragmas.append({'path': name, 'language': 'SOLIDITY', 'constraint': constraint[:160],
                                'minimumCandidate': hit.group(1) if hit else None})
        else:
            match = re.search(r'^\s*(?:#\s*pragma\s+version|#\s*@version)\s+(\d+\.\d+\.\d+)\s*$', txt, re.M)
            if match:
                vyper_versions.add(match.group(1))
            else:
                unsupported.append({'path': name, 'reason': 'VYPER_VERSION_NOT_EXACT'})
            pragmas.append({'path': name, 'language': 'VYPER',
                            'constraint': match.group(1) if match else None})
    for name, data in important.items():
        if name.endswith('foundry.toml'):
            txt = data.decode('utf-8', 'replace')
            for hit in re.finditer(r'^\s*(?:solc|solc_version)\s*=\s*["\x27](\d+\.\d+\.\d+)["\x27]', txt, re.M):
                solc_versions.add(hit.group(1))
    if len(solc_versions) > 20:
        unsupported.append({'reason': 'TOO_MANY_COMPILER_VERSIONS', 'count': len(solc_versions)})
        solc_versions = set(sorted(solc_versions)[:20])
    if len(vyper_versions) > 8:
        unsupported.append({'reason': 'TOO_MANY_VYPER_VERSIONS', 'count': len(vyper_versions)})
        vyper_versions = set(sorted(vyper_versions)[:8])
    packages = []
    package_candidates = sorted(important.items(), key=lambda row: (
        any(part in ('vendor', 'lib', 'node_modules') for part in row[0].split('/')),
        row[0]))
    for name, contents in package_candidates:
        if not name.endswith('package.json'):
            continue
        root = name[:-len('package.json')].rstrip('/')
        try:
            obj = json.loads(contents)
        except (ValueError, UnicodeDecodeError):
            unsupported.append({'path': name, 'reason': 'PACKAGE_MANIFEST_INVALID'})
            continue
        deps = {**(obj.get('dependencies') or {}), **(obj.get('devDependencies') or {})}
        if not isinstance(deps, dict) or not deps:
            continue
        if len(packages) >= 16:
            unsupported.append({'path': name, 'reason': 'PREPARATION_PACKAGE_ROOT_CAP_16'})
            continue
        if len(deps) > 160 or any(not NAME.fullmatch(k) or not exact_dep(v) for k, v in deps.items()):
            # A lockfile may still pin non-exact top-level version ranges.
            allowed_without_lock = False
        else:
            allowed_without_lock = True
        lockpath = next((prefix for prefix in
                         (root + '/package-lock.json' if root else 'package-lock.json',
                          root + '/npm-shrinkwrap.json' if root else 'npm-shrinkwrap.json')
                         if prefix in important), None)
        safe_lock = False
        if lockpath:
            try:
                lock = json.loads(important[lockpath])
                resolved = [v.get('resolved') for v in (lock.get('packages') or {}).values()
                            if isinstance(v, dict) and v.get('resolved')]
                safe_lock = all(isinstance(u, str) and u.startswith(REGISTRY) for u in resolved)
            except (ValueError, TypeError):
                pass
        if not safe_lock and not allowed_without_lock:
            unsupported.append({'path': name, 'reason': 'DEPENDENCIES_NOT_EXACT_OR_LOCK_NOT_REGISTRY_BOUND'})
            continue
        folder = 'packages/' + str(len(packages))
        target = output / folder
        target.mkdir(parents=True, exist_ok=True)
        (target / 'package.json').write_bytes(contents)
        if safe_lock:
            (target / 'package-lock.json').write_bytes(important[lockpath])
        packages.append({'root': root or '.', 'preparedPath': folder, 'manifestSha256': digest(contents),
                         'lockSha256': digest(important[lockpath]) if safe_lock else None,
                         'lockOriginalName': os.path.basename(lockpath) if safe_lock else None,
                         'mode': 'REGISTRY_LOCK' if safe_lock else 'EXACT_DECLARED_DEPENDENCIES',
                         'dependencyCount': len(deps)})

    manifest = {'schemaVersion': 'curveyield-standalone-toolchain-plan-v1',
                'sourceZipSha256': digest(Path(source_zip).read_bytes()),
                'roots': roots, 'pragmaRecords': pragmas,
                'solidityCompilerCandidates': sorted(solc_versions),
                'vyperCompilerVersions': sorted(vyper_versions),
                'packages': packages, 'unsupported': unsupported,
                'note': 'Compiler candidate versions are derived from source constraints, not proof of resolved compiler units.'}
    (output / 'toolchain-plan.json').write_text(json.dumps(manifest, indent=2, sort_keys=True) + '\n')
    print(json.dumps({'sourceRoots': len(roots), 'compilerCandidates': len(solc_versions),
                      'vyperCompilers': len(vyper_versions), 'packageRoots': len(packages),
                      'unsupported': len(unsupported)}))

if __name__ == '__main__':
    if len(sys.argv) != 3:
        sys.exit('usage: source-toolchain-plan-v1.py source.zip output_dir')
    main(sys.argv[1], sys.argv[2])
