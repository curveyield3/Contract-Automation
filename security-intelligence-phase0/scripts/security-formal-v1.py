#!/usr/bin/env python3
"""CurveYield local Certora formal-stage dispatcher v1.

Subcommands are introduced only as their ordered implementation units become
eligible. "prepare-toolchain" is I02.1: trusted, source-blind native tooling.
This does not run smart-contract tests, source hooks, deployment, or an audit.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
import stat
import tempfile
import zipfile
from pathlib import PurePosixPath
from urllib.parse import quote
from urllib.request import Request, urlopen

PROVER_REPO = "https://github.com/Certora/CertoraProver.git"
PROVER_COMMIT = "4ef546d00cd67d333914845dead2d72081e1f014"
AUTOPROVER_REPO = "https://github.com/Certora/AutoProver.git"
AUTOPROVER_COMMIT = "81d9626c249a70c0a0f0648a89de175443c0344c"
AUTOPROVER_GRAPHCORE_COMMIT = "c03be3aa9c1cbad4f89dddd0bf2f784bbe77f4bc"
UV_RELEASE = "0.13.9"


def invoke(argv: list[str], *, cwd: Path | None = None,
           env: dict[str, str] | None = None) -> str:
    print("NATIVE_TOOL:", " ".join(argv), flush=True)
    result = subprocess.run(argv, cwd=cwd, env=env, text=True,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            check=False)
    output = result.stdout or ""
    # No untrusted contract source is present during this subcommand.
    if output:
        # The prior 12k clipping hid the root Kotlin/KSP compiler diagnostic.
        # This stage is trusted-toolchain-only; retain more native failure output.
        print(output[-120000:] if result.returncode else output[-12000:], flush=True)
    if result.returncode:
        raise RuntimeError(
            f"Native tool {argv[0]} exited {result.returncode}: {output[-2000:]}"
        )
    return output.strip()


def digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def require_binary(name: str, env: dict[str, str]) -> Path:
    resolved = shutil.which(name, path=env["PATH"])
    if not resolved:
        raise RuntimeError(f"Required local executable missing from PATH: {name}")
    return Path(resolved).resolve()


def local_toolchain(root: Path) -> dict[str, object]:
    if not os.environ.get("GITHUB_ACTIONS") == "true":
        raise RuntimeError("Certora toolchain must be built on its intended GitHub Actions runner")
    root = root.resolve()
    root.mkdir(parents=True, exist_ok=True)
    source = root / "CertoraProver"
    target = root / "installed"
    venv = root / "python-venv"
    env = os.environ.copy()
    env["CERTORA"] = str(target)
    env["DEBIAN_FRONTEND"] = "noninteractive"
    # This pinned Certora source targets Java 19; setup-java supplies the JDK.
    # Force the JVM loading KSP providers to match the compiled Java 19 classes.
    java_home_text = env.get("JAVA_HOME", "")
    java_home = Path(java_home_text) if java_home_text else Path(".")
    if not java_home.is_absolute() or not (java_home / "bin" / "java").is_file():
        raise RuntimeError("I02.1 requires setup-java JDK19 and an absolute JAVA_HOME")
    env["PATH"] = f"{java_home / 'bin'}:{env.get('PATH', '')}"
    java_version = invoke(["java", "-version"], env=env)
    if not re.search(r'(?:openjdk|java) version "19(?:[."]|$)', java_version, re.IGNORECASE):
        raise RuntimeError(f"Expected Java 19 runtime, observed: {java_version[:300]}")


    # Tool installation occurs before the admitted ZIP is retrieved or unpacked.
    invoke(["sudo", "apt-get", "update"], env=env)
    invoke(["sudo", "apt-get", "install", "-y", "--no-install-recommends",
            "ca-certificates", "curl", "git", "build-essential", "cmake",
            "pkg-config", "clang", "llvm", "unzip", "python3-venv",
            "python3-pip", "z3", "cvc5"], env=env)
    rustup = shutil.which("rustup")
    if not rustup:
        installer = root / "rustup-init.sh"
        invoke(["curl", "--fail", "--location", "--retry", "3", "--output",
                str(installer), "https://sh.rustup.rs"], env=env)
        invoke(["sh", str(installer), "-y", "--profile", "minimal",
                "--default-toolchain", "stable"], env=env)
        installer.unlink(missing_ok=True)
    cargo_bin = Path.home() / ".cargo" / "bin"
    env["PATH"] = f"{cargo_bin}:{target}:{env.get('PATH', '')}"
    invoke(["rustup", "toolchain", "install", "stable", "--profile", "minimal"], env=env)
    invoke(["rustup", "default", "stable"], env=env)
    rust_version = invoke(["rustc", "--version"], env=env)
    version = re.search(r"rustc (\d+)\.(\d+)", rust_version)
    if not version or tuple(map(int, version.groups())) < (1, 81):
        raise RuntimeError(f"Certora requires Rust 1.81+; observed {rust_version}")
    invoke(["cargo", "install", "rustfilt", "--locked"], env=env)

    if not (source / ".git").exists():
        invoke(["git", "clone", "--filter=blob:none", "--no-checkout",
                PROVER_REPO, str(source)], env=env)
    invoke(["git", "-C", str(source), "fetch", "--depth=1", "origin", PROVER_COMMIT], env=env)
    invoke(["git", "-C", str(source), "checkout", "--detach", "FETCH_HEAD"], env=env)
    actual = invoke(["git", "-C", str(source), "rev-parse", "HEAD"], env=env)
    if actual != PROVER_COMMIT:
        raise RuntimeError(f"Certora source pin mismatch: {actual}")
    # Upstream submodule URL is git@github.com:..., unsuitable for CI without SSH.
    invoke(["git", "-C", str(source), "config", "--local",
            "url.https://github.com/.insteadOf", "git@github.com:"], env=env)
    # Propagate the HTTPS rewrite into nested git submodule clone processes,
    # not just the superproject's local config (which child clones do not read).
    env["GIT_CONFIG_COUNT"] = "1"
    env["GIT_CONFIG_KEY_0"] = "url.https://github.com/.insteadOf"
    env["GIT_CONFIG_VALUE_0"] = "git@github.com:"
    invoke(["git", "-C", str(source), "submodule", "sync", "--recursive"], env=env)
    invoke(["git", "-C", str(source), "submodule", "update",
            "--init", "--recursive"], env=env)

    for name in ("llvm-symbolizer", "llvm-dwarfdump"):
        if shutil.which(name, path=env["PATH"]):
            continue
        alternatives = sorted(Path("/usr/bin").glob(name + "-[0-9]*"), reverse=True)
        if not alternatives:
            raise RuntimeError(f"Missing LLVM tool: {name}")
        target_bin = root / "tool-bin"
        target_bin.mkdir(exist_ok=True)
        (target_bin / name).symlink_to(alternatives[0])
        env["PATH"] = f"{target_bin}:{env['PATH']}"

    # Native build tasks only: no Gradle test, forge test, fuzz, or deployment.
    # Upstream Gradle 7.2 wrapper cannot run on Java 19; official compatibility
    # starts with Gradle 7.6. Select a checksum-verified 7.6.5 runtime while
    # keeping the pinned upstream checkout completely unchanged.
    gradle_zip = root / "gradle-7.6.5-bin.zip"
    invoke(["curl", "--fail", "--location", "--retry", "3", "--output",
            str(gradle_zip),
            "https://services.gradle.org/distributions/gradle-7.6.5-bin.zip"], env=env)
    gradle_sha = "b812fec0edb7d27e0ae35955887bb2954536fa3e44edaf481150da058e154d9a"
    if digest(gradle_zip) != gradle_sha:
        raise RuntimeError("Pinned Gradle 7.6.5 distribution SHA256 mismatch")
    invoke(["unzip", "-q", str(gradle_zip), "-d", str(root)], env=env)
    gradle = root / "gradle-7.6.5" / "bin" / "gradle"
    invoke([str(gradle), "--version"], cwd=source, env=env)
    # --stacktrace retains the native Kotlin compiler cause on failure.
    build_flags = ["--no-daemon", "--no-parallel", "--max-workers=1",
                   "-Pksp.incremental=false", "--stacktrace"]
    invoke([str(gradle), "assemble", *build_flags], cwd=source, env=env)
    invoke([str(gradle), "copy-assets", *build_flags], cwd=source, env=env)
    invoke([sys.executable, "-m", "venv", str(venv)], cwd=source, env=env)
    python = venv / "bin" / "python"
    invoke([str(python), "-m", "pip", "install", "--disable-pip-version-check",
            "-r", str(source / "scripts" / "certora_cli_requirements.txt")], env=env)
    env["PATH"] = f"{venv / 'bin'}:{env['PATH']}"

    emv = target / "emv.jar"
    cli = target / "certoraRun.py"
    optimizer = target / "tac_optimizer"
    for artifact in (emv, cli, optimizer):
        if not artifact.is_file() or artifact.stat().st_size == 0:
            raise RuntimeError(f"Required local Certora distribution asset missing: {artifact}")
    if not os.access(cli, os.X_OK):
        raise RuntimeError(f"Certora CLI is not executable: {cli}")
    versions: dict[str, str] = {}
    for name, args in (
        ("java", ["java", "-version"]),
        ("rustc", ["rustc", "--version"]),
        ("gradle", [str(gradle), "--version"]),
        ("z3", ["z3", "-version"]),
        ("cvc5", ["cvc5", "--version"]),
        ("llvm-symbolizer", ["llvm-symbolizer", "--version"]),
        ("llvm-dwarfdump", ["llvm-dwarfdump", "--version"]),
    ):
        versions[name] = invoke(args, cwd=source, env=env).splitlines()[0]
    # Exact upstream documented CLI startup. This is not a proof verdict.
    cli_help = invoke([str(python), str(cli), "-h"], cwd=source, env=env)
    if not cli_help:
        raise RuntimeError("certoraRun.py -h produced no native startup output")
    return {
        "status": "LOCAL_TOOLCHAIN_STARTUP_VERIFIED",
        "proverGitCommit": actual,
        "certoraDir": str(target),
        "cli": str(cli),
        "cliHelpObserved": True,
        "emvJarSha256": digest(emv),
        "optimizerSha256": digest(optimizer),
        "versions": versions,
        "solverPaths": {name: str(require_binary(name, env)) for name in ("z3", "cvc5")},
        "noCloudProver": True,
        "noPaidInference": True,
        "notAProofResult": True,
    }


def prepare_compiler_toolchain(*, root: Path, identity_file: Path,
                               requirements_file: Path, artifacts_file: Path,
                               request_file: Path) -> dict[str, object]:
    """I02.2: qualify source-bound native compiler versions, without extracting source."""
    if os.environ.get("GITHUB_ACTIONS") != "true":
        raise RuntimeError("I02.2 compiler qualification requires GitHub Actions")
    identity = json.loads(identity_file.read_text())
    requirements = json.loads(requirements_file.read_text())
    compiled = json.loads(artifacts_file.read_text())
    request = json.loads(request_file.read_text())

    if identity.get("schemaVersion") != "curveyield-lite-phase0-build-source-identity-v1":
        raise RuntimeError("I02.2 unexpected authenticated source identity schema")
    if identity.get("status") != "PASS" or identity.get("build", {}).get("status") != "completed":
        raise RuntimeError("I02.2 requires verified completed source build")
    if requirements.get("schemaVersion") != "curveyield-standalone-toolchain-plan-v1":
        raise RuntimeError("I02.2 unrecognized toolchain requirement source")
    if compiled.get("schemaVersion") != "curveyield-phase0-execution-build-artifacts-v2":
        raise RuntimeError("I02.2 unrecognized native build artifact schema")
    if request.get("schemaVersion") != "curveyield-security-preflight-request-v1":
        raise RuntimeError("I02.2 must bind exactly one authorized existing source request")
    source = identity.get("source", {})
    required = request.get("source", {})
    artifact_source = compiled.get("source", {})
    for field in ("repository", "commit", "archivePath", "archiveSha256"):
        if not isinstance(required.get(field), str) or source.get(field) != required[field]:
            raise RuntimeError("I02.2 source/request identity mismatch: " + field)
        if artifact_source.get(field) != required[field]:
            raise RuntimeError("I02.2 compiled artifact source mismatch: " + field)
    expected = required["archiveSha256"]
    if not re.fullmatch(r"[a-f0-9]{64}", expected):
        raise RuntimeError("I02.2 source archive SHA256 invalid")
    if (source.get("archiveSha256Observed") != expected or
            requirements.get("sourceZipSha256") != expected):
        raise RuntimeError("I02.2 source artifact checksum not authenticated")
    if identity.get("requestId") != request.get("requestId"):
        raise RuntimeError("I02.2 request ID differs from prior certified source")
    build = identity["build"]
    if build.get("buildConfigurationDigestSha256") != compiled.get("buildConfigurationDigestSha256"):
        raise RuntimeError("I02.2 compiled settings digest mismatch")
    units = build.get("compilationUnits")
    if not isinstance(units, list) or not units:
        raise RuntimeError("I02.2 no authenticated compilation units")
    sol_versions = set(build.get("compilerVersions") or [build.get("compilerVersion")])
    if not sol_versions or any(not re.fullmatch(r"\d+\.\d+\.\d+", str(v)) for v in sol_versions):
        raise RuntimeError("I02.2 unqualified Solidity compiler versions")
    if set(requirements.get("solidityCompilerCandidates") or []) < sol_versions:
        raise RuntimeError("I02.2 source build compiler version absent from toolchain requirements")
    if not all(u.get("compilerVersion") in sol_versions for u in units):
        raise RuntimeError("I02.2 inconsistent compilation-unit compiler version")
    artifacts = compiled.get("artifacts")
    if not isinstance(artifacts, list) or not artifacts:
        raise RuntimeError("I02.2 no compiler-observed ABI/link artifacts")
    artifact_versions = {a.get("compilerVersion") for a in artifacts}
    if artifact_versions - sol_versions:
        raise RuntimeError("I02.2 contract artifact compiler version mismatch")
    for artifact in artifacts:
        if (not isinstance(artifact.get("abi"), list) or
                not isinstance(artifact.get("linkReferences"), dict) or
                not isinstance(artifact.get("deployedLinkReferences"), dict)):
            raise RuntimeError("I02.2 compiled artifact missing ABI or link identity")
        if not re.fullmatch(r"[a-f0-9]{64}", str(artifact.get("abiDigestSha256", ""))):
            raise RuntimeError("I02.2 invalid ABI identity digest")

    root.mkdir(parents=True, exist_ok=True)
    base = "https://binaries.soliditylang.org/linux-amd64"
    with urlopen(Request(base + "/list.json",
                         headers={"User-Agent": "CurveYield-Trusted-Compiler-Qualification/1"}),
                 timeout=45) as response:
        release_index = json.load(response)
    if not isinstance(release_index, dict) or not isinstance(release_index.get("builds"), list):
        raise RuntimeError("I02.2 official Solidity release manifest invalid")
    release_map = release_index.get("releases", {})
    native_compilers = []
    for version in sorted(sol_versions):
        binary_name = release_map.get(version)
        matches = [entry for entry in release_index["builds"]
                   if entry.get("path") == binary_name and entry.get("version") == version]
        if len(matches) != 1 or not re.fullmatch(
                r"solc-linux-amd64-v\d+\.\d+\.\d+\+commit\.[a-fA-F0-9]+",
                str(binary_name)):
            raise RuntimeError("I02.2 compiler not uniquely pinned by official manifest: " + version)
        release = matches[0]
        expected_hash = str(release.get("sha256", "")).removeprefix("0x").lower()
        if not re.fullmatch(r"[a-f0-9]{64}", expected_hash):
            raise RuntimeError("I02.2 no official SHA256 compiler identity: " + version)
        compiler = root / "native-compilers" / ("solc-v" + version)
        compiler.parent.mkdir(parents=True, exist_ok=True)
        with urlopen(Request(base + "/" + quote(binary_name, safe=""),
                             headers={"User-Agent": "CurveYield-Trusted-Compiler-Qualification/1"}),
                     timeout=90) as response, compiler.open("wb") as target:
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                target.write(chunk)
        observed_hash = digest(compiler)
        if observed_hash != expected_hash:
            raise RuntimeError("I02.2 compiler binary SHA256 mismatch: " + version)
        compiler.chmod(0o755)
        reported = invoke([str(compiler), "--version"])
        if not re.search(r"Version:\s*" + re.escape(version) + r"\+commit\.", reported):
            raise RuntimeError("I02.2 native Solidity executable version mismatch: " + version)
        native_compilers.append({
            "language": "Solidity", "version": version, "executable": str(compiler),
            "sha256": observed_hash, "nativeVersionOutput": reported
        })

    scope = identity.get("auditScope", {})
    prefixes = scope.get("inScopePaths")
    exclusions = scope.get("excludedPaths")
    if not isinstance(prefixes, list) or not prefixes or not isinstance(exclusions, list):
        raise RuntimeError("I02.2 authentic audit scope invalid")
    scoped = [a for a in artifacts
              if any(str(a.get("sourceName", "")).startswith(prefix) for prefix in prefixes)
              and not any(str(a.get("sourceName", "")).startswith(ex) for ex in exclusions)]
    if not scoped:
        raise RuntimeError("I02.2 authenticated build has no in-scope compiled artifacts")
    scope_digest = hashlib.sha256(json.dumps([
        (a["qualifiedName"], a["compilerVersion"], a["abiDigestSha256"],
         a.get("deployedBytecodeDigestSha256"), a["linkReferences"],
         a["deployedLinkReferences"])
        for a in scoped
    ], sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    return {
        "status": "COMPILER_TOOLCHAIN_VERIFIED", "stage": "I02.2",
        "source": required, "requestId": request["requestId"],
        "buildConfigurationDigestSha256": build["buildConfigurationDigestSha256"],
        "compilerInputSha256": build.get("compilerInputSha256"),
        "compilerOutputSha256": build.get("compilerOutputSha256"),
        "compilationUnits": [{
            "unitId": u.get("unitId"), "compilerVersion": u.get("compilerVersion"),
            "settings": u.get("settings"),
            "compilerInputSha256": u.get("compilerInputSha256"),
            "compilerOutputSha256": u.get("compilerOutputSha256")
        } for u in units],
        "compilerToolchain": native_compilers,
        "inScopeCompiledArtifactCount": len(scoped),
        "inScopeABIAndLinkIdentitySha256": scope_digest,
        "artifactSetDigestSha256": compiled.get("artifactSetDigestSha256"),
        "sourceEvidenceDigests": {
            "BUILD_AND_SOURCE_IDENTITY_v1.json": digest(identity_file),
            "TOOLCHAIN_REQUIREMENTS_v1.json": digest(requirements_file),
            "PHASE0_EXECUTION_BUILD_ARTIFACTS_v2.json": digest(artifacts_file)
        },
        "compilerMatchingSourceRecompileDeferredTo": "I05.2",
        "noSourceZipRead": True, "noContractTests": True,
        "notAProofResult": True
    }



def uncredentialed_formal_environment(private_root: Path, tool_paths: dict[str, str]) -> dict[str, str]:
    """Construct a narrow environment; never forward a runner's GitHub/AI/chain secrets."""
    root = private_root.resolve()
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    root.chmod(0o700)
    home = root / "formal-home"
    home.mkdir(mode=0o700, exist_ok=True)
    home.chmod(0o700)
    env = {"PATH": str(tool_paths["PATH"]), "HOME": str(home),
           "TMPDIR": str(root), "LANG": "C.UTF-8",
           "PYTHONDONTWRITEBYTECODE": "1", "PYTHONNOUSERSITE": "1"}
    for name in ("JAVA_HOME", "CERTORA"):
        if name in tool_paths:
            env[name] = str(tool_paths[name])
    # Deliberately no GH_TOKEN, GITHUB_TOKEN, Actions OIDC, cloud/AI API keys,
    # AWS/Cloudflare credentials, proxy variables, or source-authored hooks.
    return env


def admit_source_to_private_scratch(*, work_dir: Path, source_zip: Path,
                                    request_file: Path, manifest_file: Path,
                                    toolchain_report: Path, compiler_report: Path) -> Path:
    """I02.3 source boundary, first exercised with authentic input at I04/I05.

    Call only AFTER trusted native toolchains are prepared in this same runner.
    Source is inert ZIP data here; no source files, npm hooks, build scripts,
    forge tests, deployment scripts, or generated shell commands are executed.
    """
    if os.environ.get("GITHUB_ACTIONS") != "true":
        raise RuntimeError("Formal source intake requires the authenticated GitHub Actions runner")
    scratch_parent = Path(os.environ.get("RUNNER_TEMP", "")).resolve()
    root = work_dir.resolve()
    if root == scratch_parent or scratch_parent not in root.parents:
        raise RuntimeError("Formal scratch must be a private child of RUNNER_TEMP")
    for supplied in (work_dir, source_zip, request_file, manifest_file,
                     toolchain_report, compiler_report):
        if supplied.is_symlink():
            raise RuntimeError("Source admission refuses symlinked input: " + str(supplied))
    request = json.loads(request_file.read_text())
    manifest = json.loads(manifest_file.read_text())
    toolchain = json.loads(toolchain_report.read_text())
    compilers = json.loads(compiler_report.read_text())
    if (request.get("schemaVersion") != "curveyield-security-preflight-request-v1" or
            request.get("runMode") != "SOURCE_PREFLIGHT"):
        raise RuntimeError("Formal source request type mismatch")
    source = request.get("source", {})
    observed = manifest.get("source", {})
    expected = source.get("archiveSha256")
    if (not isinstance(expected, str) or not re.fullmatch(r"[a-f0-9]{64}", expected) or
            manifest.get("sourceAdmissionVerified") is not True or
            observed.get("expectedSha256") != expected or
            observed.get("observedSha256") != expected or
            any(observed.get(k) != source.get(k)
                for k in ("repository", "commit", "archivePath"))):
        raise RuntimeError("Source ZIP and preflight run identity are not independently authenticated")
    if (toolchain.get("status") != "LOCAL_TOOLCHAIN_STARTUP_VERIFIED" or
            toolchain.get("proverGitCommit") != PROVER_COMMIT or
            toolchain.get("noCloudProver") is not True or
            compilers.get("status") != "COMPILER_TOOLCHAIN_VERIFIED" or
            compilers.get("source") != source):
        raise RuntimeError("Current-run trusted native toolchain receipts missing or inconsistent")
    if (not source_zip.is_file() or
            source_zip.stat().st_size > 16 * 1024 * 1024 or
            digest(source_zip) != expected):
        raise RuntimeError("Admitted source ZIP bytes or original archive digest invalid")
    for artifact in ("emv.jar", "certoraRun.py", "tac_optimizer"):
        if not (Path(str(toolchain.get("certoraDir"))) / artifact).is_file():
            raise RuntimeError("Current runner lacks verified local Certora asset " + artifact)
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    root.chmod(0o700)
    private = root / "private"
    private.mkdir(mode=0o700, exist_ok=True)
    private.chmod(0o700)
    destination = Path(tempfile.mkdtemp(prefix="admitted-source-", dir=private))
    members_seen = set()
    declared_total = 0
    extracted_total = 0
    try:
        with zipfile.ZipFile(source_zip) as archive:
            infos = archive.infolist()
            if len(infos) > 50000:
                raise RuntimeError("Source ZIP member count exceeds isolated runner budget")
            for info in infos:
                original = info.filename
                if (not original or original.startswith("/") or
                        "\\" in original or "\x00" in original or
                        re.match(r"^[A-Za-z]:", original)):
                    raise RuntimeError("Unsafe ZIP filename: " + repr(original))
                rel = original[:-1] if info.is_dir() else original
                parts = rel.split("/")
                if any(part in ("", ".", "..") for part in parts):
                    raise RuntimeError("ZIP traversal or ambiguous path: " + repr(original))
                mode = (info.external_attr >> 16) & 0xFFFF
                entry_type = stat.S_IFMT(mode)
                if entry_type not in (0, stat.S_IFDIR, stat.S_IFREG):
                    raise RuntimeError("ZIP symlink/device/special member rejected: " + repr(original))
                canonical = str(PurePosixPath(*parts))
                if canonical in members_seen:
                    raise RuntimeError("Duplicate ZIP member path: " + canonical)
                members_seen.add(canonical)
                declared_total += info.file_size
                if (info.file_size > 128 * 1024 * 1024 or
                        declared_total > 1024 * 1024 * 1024 or
                        info.flag_bits & 0x1):
                    raise RuntimeError("ZIP member violates budget or is encrypted")
            for info in infos:
                name = info.filename[:-1] if info.is_dir() else info.filename
                target = destination.joinpath(*name.split("/"))
                if destination not in target.parents:
                    raise RuntimeError("ZIP destination escapes private scratch")
                if info.is_dir():
                    target.mkdir(mode=0o700, parents=True, exist_ok=True)
                    continue
                target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                with archive.open(info, "r") as reader, target.open("xb") as writer:
                    while True:
                        chunk = reader.read(1024 * 1024)
                        if not chunk:
                            break
                        extracted_total += len(chunk)
                        if extracted_total > 1024 * 1024 * 1024:
                            raise RuntimeError("Extracted ZIP exceeds real output budget")
                        writer.write(chunk)
                target.chmod(0o600)
        return destination
    except Exception:
        shutil.rmtree(destination, ignore_errors=True)
        raise


def prepare_upstream_autoprover(root: Path) -> dict[str, object]:
    """I03.1 real pinned host installation; no AutoProver pipeline/LLM/proofs."""
    if os.environ.get("GITHUB_ACTIONS") != "true":
        raise RuntimeError("AutoProver installation must run in the GitHub qualification job")
    root = root.resolve()
    native_report = root / "toolchain-bootstrap-v1.json"
    if not native_report.is_file():
        raise RuntimeError("I03.1 native Certora must be rebuilt/restored in THIS runner")
    native = json.loads(native_report.read_text())
    if (native.get("status") != "LOCAL_TOOLCHAIN_STARTUP_VERIFIED" or
            native.get("proverGitCommit") != PROVER_COMMIT or
            native.get("noCloudProver") is not True):
        raise RuntimeError("I03.1 native toolchain receipt inconsistent")
    certora_dir = Path(str(native.get("certoraDir")))
    for name in ("emv.jar", "certoraRun.py", "tac_optimizer"):
        if not (certora_dir / name).is_file():
            raise RuntimeError("I03.1 current-run local Certora asset missing " + name)

    source = root / "AutoProver"
    env = os.environ.copy()
    env["DEBIAN_FRONTEND"] = "noninteractive"
    env["GIT_CONFIG_COUNT"] = "1"
    env["GIT_CONFIG_KEY_0"] = "url.https://github.com/.insteadOf"
    env["GIT_CONFIG_VALUE_0"] = "git@github.com:"
    env["UV_NO_DEV"] = "1"
    env["UV_NO_PROGRESS"] = "1"
    env["UV_CACHE_DIR"] = str(root / "uv-cache")
    env["UV_PYTHON_DOWNLOADS"] = "never"
    env["CERTORA"] = str(certora_dir)
    if not source.exists():
        invoke(["git", "clone", "--filter=blob:none", "--no-checkout",
                AUTOPROVER_REPO, str(source)], env=env)
    invoke(["git", "-C", str(source), "fetch", "--depth=1",
            "origin", AUTOPROVER_COMMIT], env=env)
    invoke(["git", "-C", str(source), "checkout", "--detach", "FETCH_HEAD"], env=env)
    actual = invoke(["git", "-C", str(source), "rev-parse", "HEAD"], env=env)
    if actual != AUTOPROVER_COMMIT:
        raise RuntimeError("I03.1 AutoProver upstream commit mismatch")
    invoke(["git", "-C", str(source), "submodule", "sync", "--recursive"], env=env)
    invoke(["git", "-C", str(source), "submodule", "update",
            "--init", "--recursive"], env=env)
    graphcore = invoke(["git", "-C", str(source / "graphcore"),
                        "rev-parse", "HEAD"], env=env)
    if graphcore != AUTOPROVER_GRAPHCORE_COMMIT:
        raise RuntimeError("I03.1 graphcore submodule pin mismatch: " + graphcore)
    lockfile = source / "uv.lock"
    if not lockfile.is_file() or not lockfile.stat().st_size:
        raise RuntimeError("I03.1 pinned upstream uv.lock missing")

    # Keep tool installation separate from source-authored audit projects.
    uvbootstrap = root / "uv-bootstrap"
    invoke([sys.executable, "-m", "venv", str(uvbootstrap)], env=env)
    python = uvbootstrap / "bin" / "python"
    invoke([str(python), "-m", "pip", "install",
            "--disable-pip-version-check", f"uv=={UV_RELEASE}"], env=env)
    uv = uvbootstrap / "bin" / "uv"
    observed_uv = invoke([str(uv), "--version"], env=env)
    if not observed_uv.startswith("uv " + UV_RELEASE):
        raise RuntimeError("I03.1 pinned uv runtime version differs from expected")
    if sys.version_info[:2] != (3, 12):
        raise RuntimeError("I03.1 headless AutoProver must use selected Python 3.12")
    invoke([str(uv), "sync", "--no-dev", "--locked",
            "--python", sys.executable], cwd=source, env=env)
    cli = source / ".venv" / "bin" / "console-autoprove"
    if not cli.is_file() or not os.access(cli, os.X_OK):
        raise RuntimeError("I03.1 native console-autoprove entrypoint not installed")
    # Help/startup only. Never launch the AutoProver agent or cloud proof.
    clean_env = uncredentialed_formal_environment(root / "private",
                {"PATH": str(source / ".venv" / "bin") + ":" + env["PATH"],
                 "CERTORA": str(certora_dir),
                 "JAVA_HOME": env.get("JAVA_HOME", "")})
    help_text = invoke([str(cli), "--help"], cwd=source, env=clean_env)
    if not help_text or "usage" not in help_text.lower():
        raise RuntimeError("I03.1 headless console startup/help unavailable")
    installed_python = source / ".venv" / "bin" / "python"
    imports = invoke([str(installed_python), "-c",
                      "import composer.cli.console_autoprove; import graphcore; "
                      "print('PINNED_AUTOPROVER_IMPORTS_OK')"],
                     cwd=source, env=clean_env)
    if "PINNED_AUTOPROVER_IMPORTS_OK" not in imports:
        raise RuntimeError("I03.1 pinned AutoProver/graphcore imports unavailable")
    return {
        "status": "UPSTREAM_AUTOPROVER_CLI_VERIFIED",
        "stage": "I03.1",
        "autoproverGitCommit": actual,
        "graphcoreGitCommit": graphcore,
        "lockSha256": digest(lockfile),
        "uvVersion": observed_uv,
        "pythonVersion": invoke([str(installed_python), "--version"], env=clean_env),
        "consoleEntrypoint": str(cli),
        "consoleHelpVerified": True,
        "nativeCertoraProverCommit": native["proverGitCommit"],
        "nativeCertoraBuiltThisRunner": True,
        "noCloudProof": True, "noPaidModelCalls": True,
        "noSourceContractsLoaded": True, "notAProofResult": True,
    }

def main() -> int:
    parser = argparse.ArgumentParser(description="CurveYield source-bound local formal dispatcher")
    commands = parser.add_subparsers(dest="operation", required=True)
    prep = commands.add_parser("prepare-toolchain", help="I02.1 local Certora Prover build and startup")
    prep.add_argument("--work-dir", type=Path, required=True)
    compilers = commands.add_parser("prepare-compilers", help="I02.2 native source-bound compiler qualification")
    compilers.add_argument("--work-dir", type=Path, required=True)
    compilers.add_argument("--identity", type=Path, required=True)
    compilers.add_argument("--requirements", type=Path, required=True)
    compilers.add_argument("--artifacts", type=Path, required=True)
    compilers.add_argument("--request", type=Path, required=True)
    autoprover = commands.add_parser("prepare-autoprover", help="I03.1 upstream AutoProver native CLI qualification")
    autoprover.add_argument("--work-dir", type=Path, required=True)
    args = parser.parse_args()
    if args.operation == "prepare-autoprover":
        work_dir = args.work_dir.resolve()
        report_path = work_dir / "autoprover-bootstrap-v1.json"
        begun = time.monotonic()
        try:
            result = prepare_upstream_autoprover(work_dir)
            result["elapsedSeconds"] = round(time.monotonic() - begun, 2)
            report_path.parent.mkdir(parents=True, exist_ok=True)
            report_path.write_text(json.dumps(result, indent=2) + "\n")
            print("LOCAL_AUTOPROVER_BOOTSTRAP_PASS:", str(report_path))
            return 0
        except Exception as exc:
            report_path.parent.mkdir(parents=True, exist_ok=True)
            report_path.write_text(json.dumps({
                "status": "UPSTREAM_AUTOPROVER_INSTALL_FAILED", "stage": "I03.1",
                "error": str(exc),
                "elapsedSeconds": round(time.monotonic() - begun, 2),
                "notAProofResult": True
            }, indent=2) + "\n")
            print("LOCAL_AUTOPROVER_BOOTSTRAP_FAILURE: " + str(exc), file=sys.stderr)
            return 1
    if args.operation == "prepare-compilers":
        work_dir = args.work_dir.resolve()
        report_path = work_dir / "compiler-bootstrap-v1.json"
        begun = time.monotonic()
        try:
            result = prepare_compiler_toolchain(root=work_dir,
                identity_file=args.identity, requirements_file=args.requirements,
                artifacts_file=args.artifacts, request_file=args.request)
            result["elapsedSeconds"] = round(time.monotonic() - begun, 2)
            report_path.parent.mkdir(parents=True, exist_ok=True)
            report_path.write_text(json.dumps(result, indent=2) + "\n")
            print("LOCAL_CERTORA_COMPILERS_PASS:", str(report_path))
            return 0
        except Exception as exc:
            report_path.parent.mkdir(parents=True, exist_ok=True)
            report_path.write_text(json.dumps({
                "status": "COMPILER_TOOLCHAIN_FAILED", "stage": "I02.2",
                "error": str(exc),
                "elapsedSeconds": round(time.monotonic() - begun, 2),
                "notAProofResult": True
            }, indent=2) + "\n")
            print("LOCAL_CERTORA_COMPILERS_FAILURE: " + str(exc), file=sys.stderr)
            return 1
    if args.operation == "prepare-toolchain":
        work_dir = args.work_dir.resolve()
        report_path = work_dir / "toolchain-bootstrap-v1.json"
        begun = time.monotonic()
        try:
            result = local_toolchain(work_dir)
            result["elapsedSeconds"] = round(time.monotonic() - begun, 2)
            report_path.parent.mkdir(parents=True, exist_ok=True)
            report_path.write_text(json.dumps(result, indent=2) + "\n")
            print("LOCAL_CERTORA_BOOTSTRAP_PASS:", str(report_path))
            return 0
        except Exception as exc:
            report_path.parent.mkdir(parents=True, exist_ok=True)
            report_path.write_text(json.dumps({
                "status": "LOCAL_TOOLCHAIN_BOOTSTRAP_FAILED",
                "stage": "I02.1",
                "error": str(exc),
                "elapsedSeconds": round(time.monotonic() - begun, 2),
                "notAProofResult": True
            }, indent=2) + "\n")
            print(f"LOCAL_CERTORA_BOOTSTRAP_FAILURE: {exc}", file=sys.stderr)
            return 1
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
