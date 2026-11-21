#!/usr/bin/env bash
set -euo pipefail

safe_extract_audit_zip() {
  local zip_path="$1"
  local source_dir="$2"
  local outer_name="$3"

  SOURCE_DIR="$source_dir" SOURCE_ZIP_PATH="$zip_path" python3 - <<'PY'
import os, shutil, stat, zipfile
from pathlib import Path, PurePosixPath
source_dir=Path(os.environ['SOURCE_DIR']).resolve()
zip_path=Path(os.environ['SOURCE_ZIP_PATH']).resolve()
total=0
limit=2*1024*1024*1024
with zipfile.ZipFile(zip_path) as z:
    for info in z.infolist():
        raw=info.filename.replace('\\','/')
        p=PurePosixPath(raw)
        if not raw or p.is_absolute() or any(part in ('','..') for part in p.parts):
            raise SystemExit(f'unsafe archive entry: {info.filename}')
        if any(part == '.git' for part in p.parts):
            raise SystemExit(f'embedded .git path forbidden: {info.filename}')
        if ((info.external_attr >> 16) & 0o170000) == stat.S_IFLNK:
            raise SystemExit(f'symlink archive entry forbidden: {info.filename}')
        target=(source_dir / Path(*p.parts)).resolve()
        if source_dir not in target.parents and target != source_dir:
            raise SystemExit(f'archive entry escapes source directory: {info.filename}')
        if target == zip_path:
            raise SystemExit(f'archive entry would overwrite admitted ZIP: {info.filename}')
        total += info.file_size
        if total > limit: raise SystemExit('archive uncompressed size exceeds 2 GiB safety limit')
    for info in z.infolist():
        p=PurePosixPath(info.filename.replace('\\','/'))
        target=source_dir / Path(*p.parts)
        if info.is_dir():
            target.mkdir(parents=True,exist_ok=True); continue
        target.parent.mkdir(parents=True,exist_ok=True)
        with z.open(info) as src, open(target,'wb') as dst: shutil.copyfileobj(src,dst)
PY

  SOURCE_DIR="$source_dir" SOURCE_FILENAME="$outer_name" python3 - <<'PY'
import hashlib,os
from pathlib import Path
root=Path(os.environ['SOURCE_DIR']); outer=os.environ['SOURCE_FILENAME']; h=hashlib.sha256()
files=sorted((p for p in root.rglob('*') if p.is_file() and p.relative_to(root).as_posix()!=outer),key=lambda p:p.relative_to(root).as_posix())
for p in files:
    h.update(p.relative_to(root).as_posix().encode()); h.update(b'\0')
    h.update(hashlib.sha256(p.read_bytes()).hexdigest().encode()); h.update(b'\n')
print(h.hexdigest())
PY
}
