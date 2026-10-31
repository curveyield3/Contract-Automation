#!/usr/bin/env python3
from pathlib import Path
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED
import hashlib
import json
import stat

root = Path("Audit Skill - Current Authority")
packages = sorted(
    p for p in root.iterdir()
    if p.is_dir() and (p / "SKILL.md").is_file()
)
if len(packages) != 1:
    raise SystemExit("authority folder must contain exactly one unpacked package with root SKILL.md")

package = packages[0]
manifest_path = package / "MANIFEST.json"
if not manifest_path.is_file():
    raise SystemExit("current authority package is missing MANIFEST.json")

manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
release = manifest.get("release")
if not isinstance(release, str) or not release.startswith("Audit_Litemode_v"):
    raise SystemExit("MANIFEST.json release must be Audit_Litemode_v*")

expected_package = root / release
if package != expected_package:
    if expected_package.exists():
        raise SystemExit(f"target authority package already exists: {expected_package}")
    package.rename(expected_package)
    package = expected_package
    manifest_path = package / "MANIFEST.json"

files = []
for path in sorted(p for p in package.rglob("*") if p.is_file() and p.name != "MANIFEST.json"):
    data = path.read_bytes()
    files.append({
        "path": path.relative_to(package).as_posix(),
        "bytes": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
    })
manifest["files"] = files
manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

target = root / f"{package.name}.zip"
tmp = target.with_suffix(".zip.tmp")

for stale in sorted(root.glob("*.zip")):
    if stale != target:
        stale.unlink()

with ZipFile(tmp, "w", compression=ZIP_DEFLATED, compresslevel=9) as zf:
    for path in sorted(p for p in package.rglob("*") if p.is_file()):
        rel = Path(package.name) / path.relative_to(package)
        info = ZipInfo(rel.as_posix(), date_time=(1980, 1, 1, 0, 0, 0))
        info.compress_type = ZIP_DEFLATED
        info.create_system = 3
        info.external_attr = (stat.S_IFREG | 0o644) << 16
        zf.writestr(info, path.read_bytes())

tmp.replace(target)
print(target.as_posix())
