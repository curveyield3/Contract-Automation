#!/usr/bin/env python3
"""Resolve Etherscan/KatanaScan contract links to a frozen, internally generated source ZIP.
No user-supplied ZIP, ABI, deployment profile, or compiler settings are required.
Unverified, ambiguous, cross-chain, unsafe and unreconstructible inputs fail closed.
"""
import hashlib
import io
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path

API = "https://api.etherscan.io/v2/api"
CHAINS = {"etherscan.io": (1, "ethereum"), "katanascan.com": (747474, "katana")}
ADDRESS = re.compile(r"^0x[0-9a-fA-F]{40}$")
HEX = re.compile(r"^0x[0-9a-fA-F]+$")
SHA = lambda b: hashlib.sha256(b).hexdigest()
IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"
BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aea5ad9ee34f0b3e5a375d5ff"

def fail(code, detail=""):
    raise ValueError(code + (": " + detail if detail else ""))

def canonical(value):
    url = urllib.parse.urlsplit(value.strip())
    host = (url.hostname or "").lower()
    if url.scheme != "https" or url.username or url.password or url.port or host not in CHAINS:
        fail("UNSUPPORTED_EXPLORER", host)
    parts = [p for p in url.path.split("/") if p]
    if len(parts) != 2 or parts[0] not in ("address", "token") or not ADDRESS.fullmatch(parts[1]) or int(parts[1], 16) == 0:
        fail("INVALID_CONTRACT_SCAN_URL")
    # Explorer UI fragments (e.g. #code) and optional tracking parameters do
    # not alter contract identity; they are stripped before calling the API.
    chain_id, chain = CHAINS[host]
    address = "0x" + parts[1][2:].lower()
    return {"url": "https://" + host + "/address/" + address, "chainId": chain_id,
            "chain": chain, "address": address}

def api(chain_id, module, action, **params):
    key = os.environ.get("ETHERSCAN_API_KEY", "")
    if not key or "\n" in key:
        fail("ETHERSCAN_API_KEY_MISSING")
    query = urllib.parse.urlencode({"chainid": chain_id, "module": module, "action": action,
                                    **params, "apikey": key})
    # No secret-bearing URL is ever written to diagnostics, artifacts or logs.
    for attempt in range(4):
        try:
            with urllib.request.urlopen(urllib.request.Request(
                API + "?" + query, headers={"User-Agent": "CurveYield-Live-Source-Intake/1.0"}),
                timeout=22) as response:
                data = response.read(16 * 1024 * 1024 + 1)
            if len(data) > 16 * 1024 * 1024:
                fail("EXPLORER_RESPONSE_TOO_LARGE")
            payload = json.loads(data)
            result = payload.get("result")
            if isinstance(result, str) and (result.lower().startswith("max rate limit") or "rate limit" in result.lower()):
                raise RuntimeError("API_RATE_LIMIT")
            if payload.get("status") == "0" or result is None or isinstance(result, str) and result.startswith("Error!"):
                fail("EXPLORER_API_UNAVAILABLE", str(payload.get("message", "No response"))[:100])
            time.sleep(0.22)
            return result
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, RuntimeError):
            if attempt == 3:
                fail("EXPLORER_API_UNAVAILABLE", module + "/" + action)
            time.sleep((attempt + 1) * 2)

def proxy(chain_id, action, **params):
    result = api(chain_id, "proxy", action, **params)
    if not isinstance(result, str) and action not in ("eth_getBlockByNumber",):
        fail("UNEXPECTED_CHAIN_RESPONSE", action)
    return result

def safe_name(name):
    if not isinstance(name, str) or len(name) > 260 or not name or "\\" in name or any(ord(ch)<32 for ch in name):
        fail("UNSAFE_EXPLORER_SOURCE_PATH")
    p = name.split("/")
    if name.startswith("/") or ":" in name or any(x in ("", ".", "..") for x in p):
        fail("UNSAFE_EXPLORER_SOURCE_PATH")
    return name

def source_input(info):
    raw = info.get("SourceCode")
    if not isinstance(raw, str) or not raw.strip():
        fail("UNVERIFIED_SOURCE", str(info.get("ContractName", ""))[:60])
    text = raw.strip()
    try:
        candidate = json.loads(text[1:-1] if text.startswith("{{") and text.endswith("}}") else text)
    except json.JSONDecodeError:
        candidate = None
    version = str(info.get("CompilerVersion") or "").lstrip("v")
    if not re.fullmatch(r"\d+\.\d+\.\d+\+commit\.[0-9a-fA-F]{8}(?:\..+)?", version):
        fail("UNSUPPORTED_EXACT_COMPILER_VERSION", version)
    if isinstance(candidate, dict) and isinstance(candidate.get("sources"), dict):
        settings = candidate.get("settings", {})
        if not isinstance(settings, dict):
            fail("INVALID_STANDARD_JSON_SETTINGS")
        inp = {"language": "Solidity", "sources": candidate["sources"], "settings": settings}
    elif isinstance(candidate, dict) and candidate and all(
         isinstance(v, dict) and isinstance(v.get("content"), str) for v in candidate.values()):
        inp = {"language": "Solidity", "sources": candidate, "settings": {}}
    elif not isinstance(candidate, dict):
        # Flattened source does not carry all original Standard-JSON settings. The
        # exact-bytecode verification later is mandatory; reconstruction is never attested by assumption.
        base = str(info.get("ContractFileName") or info.get("ContractName") or "Verified")
        n = safe_name(base if base.endswith(".sol") else base + ".sol")
        inp = {"language": "Solidity", "sources": {n: {"content": raw}}, "settings": {}}
    else:
        fail("UNSUPPORTED_EXPLORER_SOURCE_FORMAT")
    for key, value in inp["sources"].items():
        safe_name(key)
        if not isinstance(value, dict) or not isinstance(value.get("content"), str):
            fail("SOURCE_CONTENT_MISSING", key)
    if not inp["sources"] or len(inp["sources"]) > 1500:
        fail("EXPLORER_SOURCE_FILE_COUNT_UNSAFE")
    settings = inp["settings"]
    if not isinstance(candidate, dict) or not isinstance(candidate.get("sources"), dict):
        settings["optimizer"] = {"enabled": str(info.get("OptimizationUsed", "0")) == "1",
                                 "runs": int(info.get("Runs") or 200)}
        evm = str(info.get("EVMVersion") or "").lower()
        if evm not in ("", "default"):
            settings["evmVersion"] = evm
        libraries = str(info.get("Library") or "")
        if libraries and libraries not in ("0", "[]"):
            fail("FLATTENED_LIBRARY_LINKING_UNRESOLVED")
    name = str(info.get("ContractName") or "")
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name):
        fail("INVALID_VERIFIED_CONTRACT_NAME")
    candidates = [n for n, body in inp["sources"].items()
                  if re.search(r"\b(?:contract|library|interface)\s+" + re.escape(name) + r"\b", body["content"])]
    if len(candidates) != 1:
        fail("AMBIGUOUS_COMPILATION_TARGET", name)
    return inp, version, candidates[0] + ":" + name

def main():
    if len(sys.argv) != 3:
        fail("USAGE", "resolve-scan-source-v1.py <scan_urls_json> <workdir>")
    raw = sys.argv[1]
    try:
        links = json.loads(raw)
    except ValueError:
        links = [s.strip() for s in re.split(r"[\r\n,]+", raw) if s.strip()]
    if isinstance(links, str):
        links = [links]
    if not isinstance(links, list) or not 1 <= len(links) <= 64 or any(not isinstance(x, str) for x in links):
        fail("INVALID_SCAN_URL_BUNDLE", "Expected 1–64 contract scan-page URLs")
    requested = [canonical(x) for x in links]
    if len(set(x["address"] for x in requested)) != len(requested):
        fail("DUPLICATE_SCAN_ADDRESS")
    if len(set(x["chainId"] for x in requested)) != 1:
        fail("MIXED_CHAIN_BUNDLE_UNSUPPORTED")
    chain_id, chain = requested[0]["chainId"], requested[0]["chain"]
    latest = proxy(chain_id, "eth_blockNumber")
    if not HEX.fullmatch(latest):
        fail("INVALID_FROZEN_BLOCK")
    tag = hex(int(latest, 16))
    block = api(chain_id, "proxy", "eth_getBlockByNumber", tag=tag, boolean="false")
    if not isinstance(block, dict) or not re.fullmatch(r"0x[0-9a-fA-F]{64}", str(block.get("hash", ""))):
        fail("FROZEN_BLOCK_HASH_MISSING")
    frozen = {"number": int(tag, 16), "hash": block["hash"].lower()}
    if frozen["number"] <= 0:
        fail("INVALID_FROZEN_BLOCK")

    files = {}
    units = []
    units_by_id = {}
    target_records = []
    queue = [(x, "REQUESTED") for x in requested]
    visited = set()
    first_contract_name = None
    while queue:
        item, role = queue.pop(0)
        address = item["address"]
        if address in visited:
            continue
        if len(visited) >= 64:
            fail("SCAN_RESOLVED_TARGET_LIMIT_EXCEEDED")
        visited.add(address)
        source_rows = api(chain_id, "contract", "getsourcecode", address=address)
        if not isinstance(source_rows, list) or len(source_rows) != 1:
            fail("UNVERIFIED_SOURCE", address)
        info = source_rows[0]
        if first_contract_name is None:
            first_contract_name = str(info.get("ContractName") or "contract")
        compiler_input, compiler_version, qualified = source_input(info)
        code = proxy(chain_id, "eth_getCode", address=address, tag=tag)
        if not isinstance(code, str) or not re.fullmatch(r"0x(?:[0-9a-fA-F]{2})+", code):
            fail("DEPLOYED_RUNTIME_UNAVAILABLE", address)
        implementation = str(info.get("Implementation") or "").strip().lower()
        if str(info.get("Proxy") or "0") == "1":
            if not ADDRESS.fullmatch(implementation) or int(implementation, 16) == 0:
                fail("PROXY_IMPLEMENTATION_UNRESOLVED", address)
            slot = proxy(chain_id, "eth_getStorageAt", address=address, position=IMPLEMENTATION_SLOT, tag=tag)
            if not re.fullmatch(r"0x[0-9a-fA-F]{64}", str(slot)) or ("0x" + slot[-40:].lower()) != implementation:
                fail("PROXY_IMPLEMENTATION_NOT_CHAIN_VERIFIED", address)
            queue.append(({"address": implementation, "chainId": chain_id, "chain": chain,
                          "url": "https://" + ("etherscan.io" if chain_id == 1 else "katanascan.com") +
                                 "/address/" + implementation}, "IMPLEMENTATION"))
        unit_id = "scan-" + SHA((str(chain_id) + compiler_version +
                    json.dumps(compiler_input, sort_keys=True, separators=(",", ":"),
                               ensure_ascii=False)).encode("utf8"))[:16]
        for name, entry in compiler_input["sources"].items():
            # Multiple units may share an identical source name ONLY if its content is identical.
            data = entry["content"].encode("utf8")
            location = "live-scan-project/" + name
            if location in files and files[location] != data:
                fail("SOURCE_NAME_COLLISION", name)
            files[location] = data
        unit_path = "scan-compiler-units/" + unit_id + ".json"
        files["live-scan-project/" + unit_path] = (
            json.dumps({"compilerVersion": compiler_version, "input": compiler_input},
                       sort_keys=True, separators=(",", ":")) + "\n").encode()
        if unit_id not in units_by_id:
            record = {"unitId": unit_id, "file": unit_path, "compilerVersion": compiler_version,
                      "qualifiedName": qualified, "address": address, "targetBindings": [],
                      "originalInputSha256": SHA(json.dumps(compiler_input, sort_keys=True,
                                                           separators=(",", ":"), ensure_ascii=False).encode("utf8"))}
            units.append(record)
            units_by_id[unit_id] = record
        units_by_id[unit_id]["targetBindings"].append({"address": address, "qualifiedName": qualified})
        target_records.append({"address": address, "chainId": chain_id, "role": role,
                               "url": item["url"], "qualifiedName": qualified, "compilationUnitId": unit_id,
                               "runtimeSha256": SHA(bytes.fromhex(code[2:])),
                               "proxyImplementation": implementation if str(info.get("Proxy") or "0") == "1" else None,
                               "verifiedCompiler": compiler_version})
    names_by_unit = {}
    for row in target_records:
        existing = names_by_unit.get(row["qualifiedName"])
        if existing is not None and existing != row["compilationUnitId"]:
            fail("AMBIGUOUS_COMPILATION_TARGET", "Same qualified name from distinct compiler units")
        names_by_unit[row["qualifiedName"]] = row["compilationUnitId"]
    first = units[0]
    version = first["compilerVersion"].split("+")[0]
    # Detection only; exact build always uses the individually recorded compiler inputs.
    files["live-scan-project/foundry.toml"] = (
        '[profile.default]\nsolc_version = "' + version + '"\noptimizer = false\n'
        'src = "contracts"\nffi = false\n').encode()
    if not any(p.startswith("live-scan-project/contracts/") for p in files):
        # Existing project-root discovery requires contracts/. This is a source projection,
        # not an extra compilation input or a substitute for the original source filename.
        for p, data in list(files.items()):
            if p.endswith(".sol"):
                files["live-scan-project/contracts/" + p.rsplit("/", 1)[-1]] = data
                break
    # Every executed implementation is an audit surface, even when the user
    # supplied only the proxy address. Do not silently demote verified proxy
    # implementations to excluded/dependency-only source.
    primary_paths = sorted({t["qualifiedName"].split(":")[0] for t in target_records})
    files["live-scan-project/audit-scope.json"] = (json.dumps({
        "schemaVersion": "curveyield-audit-scope-v1", "inScopePaths": primary_paths},
        sort_keys=True, indent=2) + "\n").encode()
    files["live-scan-project/audit-deployment.json"] = (json.dumps({
        "schemaVersion": "curveyield-audit-deployment-v1", "chain": chain, "mode": "LIVE",
        "contracts": [{"address": t["address"], "qualifiedName": t["qualifiedName"]}
                      for t in target_records]}, indent=2) + "\n").encode()
    manifest = {
        "schemaVersion": "curveyield-scan-source-manifest-v1", "inputMode": "LIVE_SCAN",
        "chainId": chain_id, "chain": chain, "frozenBlock": frozen,
        "requestedTargets": [x["address"] for x in requested], "resolvedTargets": target_records,
        "compilerUnits": units,
        "historicalDeploymentReplay": False,
        "limits": ["Historical deployment/constructor execution is not replayed",
                   "External calls and dynamic dependencies require later audit investigation"]
    }
    digest = SHA(json.dumps(manifest, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf8"))
    manifest["manifestDigestSha256"] = digest
    files["live-scan-project/scan-source-manifest.json"] = (
        json.dumps(manifest, indent=2, sort_keys=True) + "\n").encode()
    label = re.sub("[^a-zA-Z0-9_-]+", "-", first_contract_name or "contract").strip("-")[:35]
    if not label:
        label = "live-contract"
    # First requested contract followed by chain; address retained only in the source manifest.
    display = (label + " " + chain.title())[:100]
    work = Path(sys.argv[2])
    work.mkdir(parents=True, exist_ok=True)
    name = display + ".zip"
    with zipfile.ZipFile(work / name, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for location in sorted(files):
            entry = zipfile.ZipInfo(location, date_time=(1980, 1, 1, 0, 0, 0))
            entry.compress_type = zipfile.ZIP_DEFLATED
            entry.external_attr = 0o100644 << 16
            archive.writestr(entry, files[location], compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
    # GitHub's contents API rejects files above 100 MiB. Refuse admission before
    # any campaign/revision is created rather than failing after partial writes.
    if (work / name).stat().st_size > 95 * 1024 * 1024:
        fail("SOURCE_ARCHIVE_EXCEEDS_GITHUB_CONTENTS_LIMIT")
    raw_archive = (work / name).read_bytes()
    for label_file, value in {
        "filename": name, "sha256": SHA(raw_archive), "size": str(len(raw_archive)),
        "provider": "etherscan-v2", "canonical-url": requested[0]["url"],
        "display-base": display, "slug": re.sub(r"[^a-z0-9._-]+", "-", display.lower()).strip("-"),
        "scan-manifest-sha256": SHA(files["live-scan-project/scan-source-manifest.json"]),
        "scan-target-set-sha256": digest,
        "scan-targets-json": json.dumps([x["url"] for x in requested], separators=(",", ":"))
    }.items():
        (work / label_file).write_text(value)
    print(json.dumps({"status": "PASS", "provider": "etherscan-v2",
                      "chainId": chain_id, "requested": len(requested),
                      "resolved": len(target_records), "generatedArchiveSha256": SHA(raw_archive),
                      "frozenBlockNumber": frozen["number"]}))

if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print("::error::LIVE_SCAN initialization blocked: " + str(exc).splitlines()[0][:500], file=sys.stderr)
        sys.exit(1)
