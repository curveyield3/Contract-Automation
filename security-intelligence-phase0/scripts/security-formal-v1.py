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
            f"Native tool {argv[0]} exited {result.returncode}: "
            f"BEGIN_FAILURE_OUTPUT {output[:6000]} END_FAILURE_OUTPUT {output[-2000:]}"
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
    # The pinned KSP plugin resolved in I02.1 and I03.1's first build;
    # retry ONLY a verified transient Gradle plugin repository resolution
    # failure, using a dependency refresh and more diagnostics. Do not
    # suppress source errors, compile failures, or fabricate build success.
    def native_gradle_task(task_name: str) -> None:
        argv = [str(gradle), task_name, *build_flags]
        try:
            invoke(argv, cwd=source, env=env)
        except RuntimeError as exc:
            detail = str(exc)
            if not ("com.google.devtools.ksp" in detail and
                    ("Plugin [id:" in detail or "UnknownPluginException" in detail)):
                raise
            print("GRADLE_PLUGIN_REPOSITORY_RECOVERY: pinned KSP metadata unavailable; "
                  "refreshing repository metadata once", flush=True)
            invoke([*argv, "--refresh-dependencies", "--info"], cwd=source, env=env)
    # Maven Central is rate-limiting GitHub-hosted runners (HTTP 429) even
    # after --refresh-dependencies. Probe a checksum-neutral public mirror
    # of the exact pinned plugin metadata before changing repository priority.
    # The checkout's build metadata is restored after the build, so the
    # source tree remains at its original pinned contents and commit.
    marker = ("com/google/devtools/ksp/com.google.devtools.ksp.gradle.plugin/"
              "1.9.20-1.0.14/com.google.devtools.ksp.gradle.plugin-1.9.20-1.0.14.pom")
    mirrors = (
        "https://maven-central.storage-download.googleapis.com/maven2",
        "https://repo1.maven.org/maven2",
    )
    qualified_mirror: str | None = None
    for candidate in mirrors:
        try:
            with urlopen(Request(candidate + "/" + marker,
                                 headers={"User-Agent": "CurveYield-Pinned-Gradle/1"}),
                         timeout=30) as resp:
                body = resp.read(8192)
            if (b"com.google.devtools.ksp" not in body or
                    b"1.9.20-1.0.14" not in body):
                raise RuntimeError("Unexpected pinned KSP plugin metadata at mirror")
            qualified_mirror = candidate
            break
        except Exception as exc:
            print("PINNED_GRADLE_REPOSITORY_PROBE_UNAVAILABLE: " +
                  candidate + " " + type(exc).__name__, flush=True)
    if qualified_mirror is None:
        raise RuntimeError("Pinned KSP metadata unreachable at approved Maven mirrors")
    settings_path = source / "settings.gradle.kts"
    root_build_path = source / "build.gradle.kts"
    original_settings = settings_path.read_text()
    original_build = root_build_path.read_text()
    settings_marker = "        mavenCentral()\n        gradlePluginPortal()"
    build_marker = "\t\tmavenLocal()\n\t\tmavenCentral()"
    if (original_settings.count(settings_marker) != 1 or
            original_build.count(build_marker) != 1):
        raise RuntimeError("Pinned upstream Maven repository declarations changed")
    settings_path.write_text(original_settings.replace(
        settings_marker,
        f'        maven {{ url = uri("{qualified_mirror}") }}\n' + settings_marker,
    ))
    root_build_path.write_text(original_build.replace(
        build_marker,
        build_marker.replace("\t\tmavenCentral()",
                             f'\t\tmaven {{ url = uri("{qualified_mirror}") }}\n\t\tmavenCentral()'),
    ))
    print("PINNED_GRADLE_METADATA_MIRROR: " + qualified_mirror, flush=True)
    try:
        native_gradle_task("assemble")
        native_gradle_task("copy-assets")
    finally:
        settings_path.write_text(original_settings)
        root_build_path.write_text(original_build)
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
        "dependencyRepositoryMirror": qualified_mirror,
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
    # The authenticated per-unit manifest is the authoritative version source.
    # The legacy build.compilerVersions summary can omit versions in a mixed-
    # compiler Hardhat build; never discard a unit or silently change its version.
    versions_by_unit: dict[str, str] = {}
    for unit in units:
        if not isinstance(unit, dict):
            raise RuntimeError("I02.2 malformed native compilation unit")
        unit_id, version = unit.get("unitId"), unit.get("compilerVersion")
        if (not isinstance(unit_id, str) or not unit_id or unit_id in versions_by_unit or
                not isinstance(version, str) or not re.fullmatch(r"\d+\.\d+\.\d+", version)):
            raise RuntimeError("I02.2 duplicated unit or invalid compiler version")
        versions_by_unit[unit_id] = version
    sol_versions = set(versions_by_unit.values())
    summary_versions = build.get("compilerVersions") or []
    if not isinstance(summary_versions, list) or any(
            v not in sol_versions for v in summary_versions):
        raise RuntimeError("I02.2 summary asserts a compiler absent from native units")
    if build.get("compilerVersion") not in (None, *sol_versions):
        raise RuntimeError("I02.2 primary compiler differs from native unit records")
    if not sol_versions.issubset(set(requirements.get("solidityCompilerCandidates") or [])):
        raise RuntimeError("I02.2 native unit compiler absent from source-derived toolchain plan")
    artifacts = compiled.get("artifacts")
    if not isinstance(artifacts, list) or not artifacts:
        raise RuntimeError("I02.2 no compiler-observed ABI/link artifacts")
    for artifact in artifacts:
        if not isinstance(artifact, dict):
            raise RuntimeError("I02.2 malformed compiler-observed artifact")
        unit_id = artifact.get("compilationUnitId")
        if unit_id not in versions_by_unit or artifact.get("compilerVersion") != versions_by_unit[unit_id]:
            raise RuntimeError("I02.2 artifact compiler identity differs from its native compilation unit")
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
                                    toolchain_report: Path | None = None,
                                    compiler_report: Path | None = None,
                                    require_native_tools: bool = True) -> Path:
    """I02.3 source boundary, first exercised with authentic input at I04/I05.

    I04 target inventory is inert data-only extraction, without a compiler.
    I05 live proving still requires native executable toolchain receipts and
    same-run tools. No source files, npm hooks, build scripts,
    forge tests, deployment scripts, or generated shell commands are executed.
    """
    if os.environ.get("GITHUB_ACTIONS") != "true":
        raise RuntimeError("Formal source intake requires the authenticated GitHub Actions runner")
    scratch_parent = Path(os.environ.get("RUNNER_TEMP", "")).resolve()
    root = work_dir.resolve()
    if root == scratch_parent or scratch_parent not in root.parents:
        raise RuntimeError("Formal scratch must be a private child of RUNNER_TEMP")
    for supplied in (work_dir, source_zip, request_file, manifest_file,
                     *(p for p in (toolchain_report, compiler_report) if p is not None)):
        if supplied.is_symlink():
            raise RuntimeError("Source admission refuses symlinked input: " + str(supplied))
    request = json.loads(request_file.read_text())
    manifest = json.loads(manifest_file.read_text())
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
    if require_native_tools:
        if toolchain_report is None or compiler_report is None:
            raise RuntimeError("Live source admission requires current-run native toolchain receipts")
        toolchain = json.loads(toolchain_report.read_text())
        compilers = json.loads(compiler_report.read_text())
        if (toolchain.get("status") != "LOCAL_TOOLCHAIN_STARTUP_VERIFIED" or
                toolchain.get("proverGitCommit") != PROVER_COMMIT or
                toolchain.get("noCloudProver") is not True or
                compilers.get("status") != "COMPILER_TOOLCHAIN_VERIFIED" or
                compilers.get("source") != source):
            raise RuntimeError("Current-run native toolchain identity missing or inconsistent")
    if (not source_zip.is_file() or
            source_zip.stat().st_size > 16 * 1024 * 1024 or
            digest(source_zip) != expected):
        raise RuntimeError("Admitted source ZIP bytes or original archive digest invalid")
    if require_native_tools:
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



def prepare_authenticated_target_map(*, work_dir: Path, source_zip: Path,
                                     artifact_request_file: Path, request_file: Path,
                                     manifest_file: Path, identity_file: Path,
                                     artifacts_file: Path, preflight_run_id: int,
                                     preflight_head_sha: str,
                                     toolchain_report: Path | None = None,
                                     compiler_report: Path | None = None) -> dict[str, object]:
    """I04.1: real source-bound, inert ZIP intake and all-target inventory.

    The only executable operations are this trusted Python program's data parsers.
    It deliberately does not execute build hooks, scripts, tests, a compiler,
    the local prover or a source-derived shell command.
    """
    req = json.loads(request_file.read_text())
    original = json.loads(artifact_request_file.read_text())
    manifest = json.loads(manifest_file.read_text())
    identity = json.loads(identity_file.read_text())
    compiled = json.loads(artifacts_file.read_text())
    declared = req.get("source", {})
    if (not isinstance(declared, dict) or
            req.get("requestId") != original.get("requestId") or
            req.get("requestId") != identity.get("requestId") or
            req.get("requestId") != compiled.get("requestIdentity", {}).get("requestId") or
            original.get("source") != declared):
        raise RuntimeError("I04.1 current request differs from exact source/artifact admission")
    if (identity.get("status") != "PASS" or
            identity.get("source", {}).get("archiveSha256") != declared.get("archiveSha256") or
            identity.get("source", {}).get("archiveSha256Observed") != declared.get("archiveSha256") or
            compiled.get("source", {}).get("archiveSha256") != declared.get("archiveSha256") or
            any(identity.get("source", {}).get(field) != declared.get(field)
                for field in ("repository", "commit", "archivePath")) or
            any(compiled.get("source", {}).get(field) != declared.get(field)
                for field in ("repository", "commit", "archivePath"))):
        raise RuntimeError("I04.1 source identities differ across evidence artifacts")
    if (not re.fullmatch(r"[a-f0-9]{40}", preflight_head_sha) or
            preflight_run_id <= 0 or
            manifest.get("schemaVersion") != "curveyield-security-clean-preflight-v1" or
            manifest.get("status") != "COLLECTED" or
            manifest.get("sourceOnly") is not False or
            identity.get("build", {}).get("status") != "completed" or
            compiled.get("schemaVersion") != "curveyield-phase0-execution-build-artifacts-v2"):
        raise RuntimeError("I04.1 prior preflight or native compiler output is not accepted")
    expected_hashes = {
        entry["name"]: entry["sha256"]
        for entry in manifest.get("files", [])
        if isinstance(entry, dict) and "name" in entry and "sha256" in entry
    }
    for name, file_path in (
        ("BUILD_AND_SOURCE_IDENTITY_v1.json", identity_file),
        ("PHASE0_EXECUTION_BUILD_ARTIFACTS_v2.json", artifacts_file),
    ):
        if (not re.fullmatch(r"[a-f0-9]{64}", str(expected_hashes.get(name, ""))) or
                digest(file_path) != expected_hashes[name]):
            raise RuntimeError("I04.1 preflight evidence file checksum mismatch: " + name)
    if (identity["build"].get("buildConfigurationDigestSha256") !=
            compiled.get("buildConfigurationDigestSha256")):
        raise RuntimeError("I04.1 authentic native build settings digest mismatch")
    scope = identity.get("auditScope", {})
    included = scope.get("inScopePaths")
    excluded = scope.get("excludedPaths")
    if (not isinstance(included, list) or not included or
            not isinstance(excluded, list) or
            any(not isinstance(p, str) or not p for p in included + excluded)):
        raise RuntimeError("I04.1 missing authentic audit scope")
    units = identity["build"].get("compilationUnits")
    if not isinstance(units, list) or not units:
        raise RuntimeError("I04.1 no authenticated native compilation units")
    unit_compilers = {
        item["unitId"]: item["compilerVersion"]
        for item in units
        if isinstance(item, dict) and "unitId" in item and "compilerVersion" in item
    }
    if len(unit_compilers) != len(units):
        raise RuntimeError("I04.1 native compilation-unit identifiers are invalid")
    records = compiled.get("artifacts")
    if not isinstance(records, list) or not records:
        raise RuntimeError("I04.1 missing authenticated per-contract ABI/artifacts")

    root = work_dir.resolve()
    if not root.is_relative_to(Path(os.environ.get("RUNNER_TEMP", "/invalid")).resolve()):
        raise RuntimeError("I04.1 private scratch is not runner-owned")
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    root.chmod(0o700)
    extracted = admit_source_to_private_scratch(
        work_dir=root, source_zip=source_zip, request_file=request_file,
        manifest_file=manifest_file,
        toolchain_report=toolchain_report,
        compiler_report=compiler_report,
        require_native_tools=toolchain_report is not None and compiler_report is not None,
    )
    eligible: list[dict[str, object]] = []
    ineligible: list[dict[str, object]] = []
    seen: set[str] = set()
    for item in records:
        if not isinstance(item, dict):
            raise RuntimeError("I04.1 native artifact is not an object")
        name = item.get("qualifiedName")
        source_name = item.get("sourceName")
        contract_name = item.get("contractName")
        unit_id = item.get("compilationUnitId")
        version = item.get("compilerVersion")
        if (not isinstance(name, str) or not isinstance(source_name, str) or
                not isinstance(contract_name, str) or
                name != f"{source_name}:{contract_name}" or name in seen):
            raise RuntimeError("I04.1 invalid or duplicate contract identity")
        seen.add(name)
        if unit_id not in unit_compilers or version != unit_compilers[unit_id]:
            raise RuntimeError("I04.1 per-artifact compiler version/unit mismatch")
        abi = item.get("abi")
        abi_digest = item.get("abiDigestSha256")
        if (not isinstance(abi, list) or
                not isinstance(abi_digest, str) or
                not re.fullmatch(r"[a-f0-9]{64}", abi_digest)):
            raise RuntimeError("I04.1 ABI identity missing for " + name)
        in_scope = (any(source_name.startswith(prefix) for prefix in included) and
                    not any(source_name.startswith(prefix) for prefix in excluded))
        record = {
            "target": name,
            "sourcePath": source_name,
            "contract": contract_name,
            "compilerVersion": version,
            "compilationUnitId": unit_id,
            "abiDigestSha256": abi_digest,
            "linkReferences": item.get("linkReferences", {}),
            "deployedLinkReferences": item.get("deployedLinkReferences", {}),
        }
        if not in_scope:
            record["reason"] = "OUTSIDE_AUTHENTIC_AUDIT_SCOPE"
            ineligible.append(record)
            continue
        source_parts = PurePosixPath(source_name).parts
        if (not source_name.endswith(".sol") or
                any(part in ("", ".", "..") for part in source_parts) or
                source_name.startswith("/")):
            record["reason"] = "NON_SOLIDITY_OR_UNSAFE_SOURCE"
            ineligible.append(record)
            continue
        src_path = extracted.joinpath(*source_parts)
        if not src_path.is_file() or src_path.is_symlink():
            raise RuntimeError("I04.1 in-scope contract source absent from authenticated ZIP: " + source_name)
        source_text = src_path.read_text(encoding="utf-8")
        declaration = re.search(
            r"\b(abstract\s+contract|contract|library|interface)\s+" +
            re.escape(contract_name) + r"\b",
            source_text,
        )
        kind = declaration.group(1) if declaration else "UNDETERMINED"
        record["sourceDeclarationKind"] = kind
        deployed = item.get("deployedBytecode")
        if kind in ("interface", "library", "abstract contract"):
            record["reason"] = "NON_DEPLOYABLE_SOURCE_DECLARATION"
            ineligible.append(record)
        elif not isinstance(deployed, str) or deployed in ("", "0x"):
            record["reason"] = "NO_COMPILED_RUNTIME_BYTECODE"
            ineligible.append(record)
        elif not re.fullmatch(r"0x[0-9a-fA-F]+", deployed):
            # Unresolved library links require compilation/link repair at I05.2,
            # not a false clean/verifiable target declaration.
            if not item.get("deployedLinkReferences"):
                raise RuntimeError("I04.1 compiler runtime bytecode is not valid linked hex")
            record["requiresLibraryLinking"] = True
            eligible.append(record)
        elif kind == "UNDETERMINED":
            record["reason"] = "UNKNOWN_COMPILER_DECLARATION"
            ineligible.append(record)
        else:
            record["requiresLibraryLinking"] = bool(item.get("deployedLinkReferences"))
            eligible.append(record)

    if not eligible:
        raise RuntimeError("I04.1 authenticated compilation has no eligible contract targets")
    readme = extracted / "README-v64.md"
    context = [
        "# Authenticated Solidity source context (factual, not design intent)",
        "",
        f"Source SHA256: {declared['archiveSha256']}",
        f"Source repository/commit: {declared['repository']} @ {declared['commit']}",
        "All items below were read from original source or native compiler artifacts.",
        "This document states no desired invariants or claimed economic guarantees.",
        "",
    ]
    if readme.is_file():
        context.extend([
            "Source-package documentation is present at README-v64.md.",
            "Its contents are not implicitly treated as formally specified invariants.",
            "",
        ])
    for target in eligible:
        item = next(x for x in records if x["qualifiedName"] == target["target"])
        funcs = [
            entry["name"]
            for entry in item["abi"]
            if isinstance(entry, dict) and entry.get("type") == "function"
            and isinstance(entry.get("name"), str)
        ]
        context.extend([
            f"## {target['target']}",
            f"- Compiler: Solidity {target['compilerVersion']}; unit {target['compilationUnitId']}",
            f"- Public ABI methods (compiler observed): {', '.join(funcs)}",
            "",
        ])
    target_doc = root / "source-context-v1.md"
    target_doc.write_text("\n".join(context), encoding="utf-8")
    target_doc.chmod(0o600)
    specs = sorted(str(p.relative_to(extracted)) for p in extracted.rglob("*")
                   if p.is_file() and p.suffix.lower() in (".spec", ".conf"))
    result = {
        "schemaVersion": "curveyield-formal-target-map-v1",
        "status": "AUTHENTICATED_SOURCE_TARGETS_READY",
        "stage": "I04.1",
        "source": declared,
        "requestId": req["requestId"],
        "preflightRunId": preflight_run_id,
        "preflightHeadSha": preflight_head_sha,
        "buildConfigurationDigestSha256": compiled["buildConfigurationDigestSha256"],
        "compilerVersions": sorted(set(unit_compilers.values())),
        "scope": scope,
        "eligible": eligible,
        "ineligible": ineligible,
        "existingCVL": specs,
        "targetContextFile": str(target_doc),
        "privateSourceRoot": str(extracted),
        "noSourceAuthoredScriptsExecuted": True,
        "noSourceCompiledOrProved": True,
        "notAProofResult": True,
    }
    out = root / "target-map-v1.json"
    out.write_text(json.dumps(result, indent=2) + "\n")
    out.chmod(0o600)
    return {
        "status": result["status"], "stage": "I04.1",
        "requestId": req["requestId"],
        "sourceSha256": declared["archiveSha256"],
        "preflightRunId": preflight_run_id,
        "compilerVersions": result["compilerVersions"],
        "eligibleCount": len(eligible), "ineligibleCount": len(ineligible),
        "existingCVLCount": len(specs),
        "privateIntake": True, "noSourceExecution": True,
        "contextDocumentCreated": True, "needsNativeCertoraBuild": False,
    }


def verify_cached_native_toolchain(root: Path) -> dict[str, object]:
    """Trust the restored *bytes*, never just an Actions cache-hit indicator.

    This is a source-blind verifier: the pinned toolchain's manifest + actual
    native JAR, optimizer, CLI and available solvers are mandatory.
    """
    root = root.resolve()
    manifest = root / "toolchain-bootstrap-v1.json"
    if not manifest.is_file():
        raise RuntimeError("Restored native cache lacks its original trusted receipt")
    record = json.loads(manifest.read_text())
    if (record.get("status") != "LOCAL_TOOLCHAIN_STARTUP_VERIFIED" or
            record.get("proverGitCommit") != PROVER_COMMIT or
            record.get("noCloudProver") is not True):
        raise RuntimeError("Restored native source pin and no-cloud identity invalid")
    installed = root / "installed"
    if str(installed) != str(Path(str(record.get("certoraDir", ""))).resolve()):
        raise RuntimeError("Restored native CERTORA install path changed")
    emv, optimizer, cli = [installed / name for name in
                           ("emv.jar", "tac_optimizer", "certoraRun.py")]
    for file in (emv, optimizer, cli):
        if not file.is_file() or file.is_symlink() or file.stat().st_size == 0:
            raise RuntimeError("Native cache missing runnable tool asset: " + file.name)
    if (digest(emv) != record.get("emvJarSha256") or
            digest(optimizer) != record.get("optimizerSha256") or
            not os.access(cli, os.X_OK) or not os.access(optimizer, os.X_OK)):
        raise RuntimeError("Restored native binary integrity mismatch")
    java_home = Path(os.environ.get("JAVA_HOME", ""))
    if not java_home.is_absolute():
        raise RuntimeError("Current runner did not configure Java 19")
    version = invoke([str(java_home / "bin/java"), "-version"])
    if not re.search(r'(?:openjdk|java) version "19(?:[."]|$)', version):
        raise RuntimeError("Restored native distribution requires Java 19")
    for tool in ("z3", "cvc5", "llvm-symbolizer", "llvm-dwarfdump"):
        if shutil.which(tool) is None:
            raise RuntimeError("Restored runner lacks required native solver/LLVM: " + tool)
    python = root / "python-venv" / "bin" / "python"
    if not python.is_file():
        raise RuntimeError("Restored Certora Python dependency environment missing")
    help_text = invoke([str(python), str(cli), "-h"])
    if not help_text:
        raise RuntimeError("Restored native Certora CLI did not start")
    print("RESTORED_CERTORA_NATIVE_BINARIES_VERIFIED", flush=True)
    return record


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
    # Upstream AutoProver imports certora_cli unconditionally at CLI load time.
    # Install the one upstream-supported stable CLI extra; use local Prover,
    # never CERTORAKEY or cloud mode for actual verification.
    invoke([str(uv), "sync", "--no-dev", "--locked",
            "--extra", "certora-cli", "--python", sys.executable], cwd=source, env=env)
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


def run_authenticated_existing_cvl(*, target_map_file: Path, native_toolchain_file: Path,
                                   compiler_file: Path, output_file: Path) -> dict[str, object]:
    """I06.1: run only authentic existing CVL; no model-generated specifications.

    Original source/spec/config bytes remain in private runner scratch. A native
    tool exit is never promoted into a PROVED property without actual rule data.
    """
    mapping = json.loads(target_map_file.read_text())
    toolchain = json.loads(native_toolchain_file.read_text())
    compilers = json.loads(compiler_file.read_text())
    if (mapping.get("status") != "AUTHENTICATED_SOURCE_TARGETS_READY"
            or toolchain.get("status") != "LOCAL_TOOLCHAIN_STARTUP_VERIFIED"
            or toolchain.get("proverGitCommit") != PROVER_COMMIT
            or compilers.get("status") != "COMPILER_TOOLCHAIN_VERIFIED"
            or mapping.get("source") != compilers.get("source")):
        raise RuntimeError("I06.1 missing authenticated target/native source provenance")
    root = Path(str(mapping["privateSourceRoot"])).resolve(strict=True)
    scratch = target_map_file.parent.resolve(strict=True)
    if (not scratch.is_relative_to(Path(os.environ.get("RUNNER_TEMP", "/invalid")).resolve())
            or not root.is_relative_to(scratch)):
        raise RuntimeError("I06.1 source or result scratch escapes private runner")
    specs = mapping.get("existingCVL")
    if not isinstance(specs, list):
        raise RuntimeError("I06.1 existing CVL inventory missing")
    for spec in specs:
        if (not isinstance(spec, str) or not spec.endswith((".spec", ".conf"))
                or not (root / spec).resolve(strict=True).is_relative_to(root)):
            raise RuntimeError("I06.1 existing CVL path is invalid")
    versions = {c["version"]: c for c in compilers.get("compilerToolchain", [])}
    for version, item in versions.items():
        executable = Path(item["executable"]).resolve(strict=True)
        if digest(executable) != item["sha256"]:
            raise RuntimeError("I06.1 native solc digest mismatch for " + version)
    certora_dir = Path(str(toolchain["certoraDir"])).resolve(strict=True)
    if digest(certora_dir / "emv.jar") != toolchain["emvJarSha256"]:
        raise RuntimeError("I06.1 native Prover binary checksum mismatch")
    outcome: dict[str, object] = {
        "schemaVersion": "curveyield-existing-cvl-v1",
        "stage": "I06.1",
        "sourceSha256": mapping["source"]["archiveSha256"],
        "requestId": mapping["requestId"],
        "originRunId": int(os.environ["GITHUB_RUN_ID"]),
        "originRunAttempt": int(os.environ["GITHUB_RUN_ATTEMPT"]),
        "originCommit": os.environ["GITHUB_SHA"],
        "nativeProverCommit": PROVER_COMMIT,
        "nativeProverSha256": toolchain["emvJarSha256"],
        "existingCVLCount": len(specs),
        "results": [],
        "nativeProverRuns": 0,
        "noCloudProver": True,
    }
    if not specs:
        outcome["status"] = "NOT_APPLICABLE_NO_EXISTING_CVL"
    else:
        # A .conf is executable configuration, not an authorized shell script.
        # Reconstruct a narrow config from source-bound contract and CVL paths.
        # Unknown options must never be silently dropped, because they can
        # change semantics, permission or compilation assumptions.
        allowed_conf = {"files", "verify", "solc", "msg"}
        listed_specs: set[str] = set()
        eligible = mapping.get("eligible", [])
        for conf_name in (p for p in specs if p.endswith(".conf")):
            item: dict[str, object] = {"configSha256": digest(root / conf_name)}
            try:
                conf = json.loads((root / conf_name).read_text())
                if not isinstance(conf, dict) or set(conf) - allowed_conf:
                    raise ValueError("UNSUPPORTED_OR_NON_DATA_ONLY_CONF")
                verify = conf.get("verify")
                if not isinstance(verify, str) or verify.count(":") != 1:
                    raise ValueError("CONF_HAS_NO_EXACT_VERIFY_MAPPING")
                contract, spec_path = verify.split(":", 1)
                matches = [t for t in eligible if t["contract"] == contract]
                if len(matches) != 1 or spec_path not in specs:
                    raise ValueError("CONF_AMBIGUOUS_OR_UNAUTHENTICATED_TARGET")
                selected = matches[0]
                source_file = selected["sourcePath"]
                files = conf.get("files", [source_file])
                if not isinstance(files, list) or not files or source_file not in files:
                    raise ValueError("CONF_FILES_EXCLUDE_COMPILER_AUTHENTICATED_TARGET")
                for path in files:
                    if (not isinstance(path, str) or not path.endswith(".sol")
                            or not (root / path).resolve(strict=True).is_relative_to(root)):
                        raise ValueError("CONF_REFERENCES_UNAUTHORIZED_SOURCE")
                compiler = versions[selected["compilerVersion"]]["executable"]
                item.update({"target": selected["target"],
                             "specSha256": digest(root / spec_path),
                             "compilerVersion": selected["compilerVersion"]})
                listed_specs.add(spec_path)
                private_run = scratch / "private" / "native-existing-cvl"
                private_run.mkdir(parents=True, exist_ok=True, mode=0o700)
                data_only_conf = private_run / ("native-" + str(len(outcome["results"])) + ".conf")
                data_only_conf.write_text(json.dumps({
                    "files": files, "verify": verify, "solc": str(compiler),
                    **({"msg": conf["msg"]} if isinstance(conf.get("msg"), str) else {}),
                }))
                data_only_conf.chmod(0o600)
                env = uncredentialed_formal_environment(
                    private_run, {
                        "PATH": str(Path(str(compiler)).parent) + ":" + os.environ.get("PATH", ""),
                        "CERTORA": str(certora_dir),
                        "JAVA_HOME": os.environ.get("JAVA_HOME", ""),
                    })
                # Capture all native output privately; never publish source,
                # CVL, solver diagnostics or counterexample traces.
                try:
                    proc = subprocess.run([
                        str(toolchain.get("certoraPython", scratch.parent / "curve-certora-formal"
                            / "python-venv" / "bin" / "python")),
                        str(certora_dir / "certoraRun.py"),
                        str(data_only_conf), "--local",
                    ], cwd=root, env=env, stdout=subprocess.PIPE,
                       stderr=subprocess.STDOUT, text=True, timeout=900, check=False)
                    log = private_run / ("native-" + str(len(outcome["results"])) + ".log")
                    log.write_text(proc.stdout or "", encoding="utf-8")
                    log.chmod(0o600)
                    item["nativeExitCode"] = proc.returncode
                    item["nativeOutputSha256"] = digest(log)
                    item["verdict"] = "ERROR" if proc.returncode else "UNKNOWN"
                    item["verdictReason"] = (
                        "NATIVE_NONZERO_EXIT" if proc.returncode
                        else "NATIVE_EXIT_ZERO_RULE_RESULTS_NOT_YET_CLASSIFIED")
                except subprocess.TimeoutExpired:
                    item["verdict"] = "TIMEOUT"
                    item["verdictReason"] = "LOCAL_PROVER_900_SECOND_DEADLINE"
                outcome["nativeProverRuns"] += 1
            except (ValueError, OSError, KeyError) as exc:
                item["verdict"] = "SPEC_INVALID"
                item["verdictReason"] = str(exc)[:160]
            outcome["results"].append(item)
        for spec in (p for p in specs if p.endswith(".spec") and p not in listed_specs):
            outcome["results"].append({
                "specSha256": digest(root / spec),
                "verdict": "NOT_RUN",
                "verdictReason": "NO_AUTHENTIC_SINGLE_TARGET_CONF_MAPPING",
            })
        outcome["status"] = "EXISTING_CVL_NATIVE_ATTEMPTED"
    output_file.parent.mkdir(parents=True, exist_ok=True)
    output_file.write_text(json.dumps(outcome, indent=2, sort_keys=True) + "\n")
    output_file.chmod(0o600)
    return outcome



def run_authenticated_autoprover(*, target_map_file: Path, native_toolchain_file: Path,
                                compiler_file: Path, session_file: Path,
                                output_file: Path, per_target_timeout: int = 1320) -> int:
    """I06.2: call pinned upstream console AutoProver sequentially, locally.

    No target-local failure is a clean verdict. Only observed upstream native
    output can establish CVL property success, never a zero process exit alone.
    """
    import signal

    mapping = json.loads(target_map_file.read_text())
    native = json.loads(native_toolchain_file.read_text())
    compilers = json.loads(compiler_file.read_text())
    session = json.loads(session_file.read_text())
    origin = int(os.environ["GITHUB_RUN_ID"])
    attempt = int(os.environ["GITHUB_RUN_ATTEMPT"])
    head = os.environ["GITHUB_SHA"]
    if (mapping.get("status") != "AUTHENTICATED_SOURCE_TARGETS_READY"
            or native.get("status") != "LOCAL_TOOLCHAIN_STARTUP_VERIFIED"
            or native.get("proverGitCommit") != PROVER_COMMIT
            or compilers.get("status") != "COMPILER_TOOLCHAIN_VERIFIED"
            or mapping.get("source") != compilers.get("source")
            or session.get("status") != "SOURCE_BOUND_PRIVATE_MIMO_CONNECTED"
            or session.get("originRunId") != origin
            or session.get("originRunAttempt") != attempt
            or session.get("originHeadSha") != head
            or session.get("requestId") != mapping.get("requestId")
            or session.get("sourceSha256") != mapping["source"]["archiveSha256"]
            or session.get("nativeProverHashSha256") != native.get("emvJarSha256")
            or session.get("privateTailscaleValidated") is not True
            or session.get("cloudProviderCalls") != 0):
        raise RuntimeError("I06.2 missing same-run private model/source/native provenance")
    ip = os.environ.get("CURVEYIELD_MIMO_VERIFIED_TAILNET_IP", "")
    endpoint = os.environ.get("CURVEYIELD_MIMO_BASE_URL", "")
    if (not re.fullmatch(r"100[.]\d+[.]\d+[.]\d+", ip)
            or endpoint != f"http://{ip}:8080/v1"):
        raise RuntimeError("I06.2 private MiMo endpoint was not bound to rendezvous")
    source = Path(str(mapping["privateSourceRoot"])).resolve(strict=True)
    scratch = target_map_file.parent.resolve(strict=True)
    runner_temp = Path(os.environ.get("RUNNER_TEMP", "/invalid")).resolve()
    if not source.is_relative_to(scratch) or not scratch.is_relative_to(runner_temp):
        raise RuntimeError("I06.2 source outside trusted private runner scratch")
    prover = Path(str(native["certoraDir"])).resolve(strict=True)
    if digest(prover / "emv.jar") != native.get("emvJarSha256"):
        raise RuntimeError("I06.2 local Certora Prover binary pin mismatch")
    upstream = runner_temp / "curve-certora-formal" / "AutoProver"
    if (not (upstream / ".venv/bin/console-autoprove").is_file()
            or not (upstream / "uv.lock").is_file()):
        raise RuntimeError("I06.2 exact upstream console AutoProver installation absent")
    if subprocess.run(["git", "-C", str(upstream), "rev-parse", "HEAD"],
                      capture_output=True, text=True, check=True).stdout.strip() != AUTOPROVER_COMMIT:
        raise RuntimeError("I06.2 AutoProver source pin mismatch")
    target_list = mapping.get("eligible", [])
    if not isinstance(target_list, list) or not target_list:
        raise RuntimeError("I06.2 requires actual authenticated eligible contracts")
    versions = {c["version"]: c for c in compilers.get("compilerToolchain", [])}
    for version, c in versions.items():
        if digest(Path(c["executable"])) != c.get("sha256"):
            raise RuntimeError("I06.2 installed native Solidity compiler digest changed")
    private = scratch / "private" / "autoprover"
    private.mkdir(mode=0o700, parents=True, exist_ok=True)
    tool_bin = private / "verified-solc-bin"
    tool_bin.mkdir(mode=0o700, exist_ok=True)
    for version, c in versions.items():
        executable = Path(c["executable"]).resolve(strict=True)
        # The pinned AutoSetup expects solc8.N names, while the original
        # compiler qualification stores fully versioned executable names.
        alias = tool_bin / ("solc" + ".".join(version.split(".")[1:]))
        if alias.exists() or alias.is_symlink():
            alias.unlink()
        alias.symlink_to(executable)
    outcome: dict[str, object] = {
        "schemaVersion": "curveyield-autoprover-execution-v1",
        "stage": "I06.2",
        "status": "RUNNING",
        "originRunId": origin,
        "originRunAttempt": attempt,
        "originCommit": head,
        "requestId": mapping["requestId"],
        "sourceSha256": mapping["source"]["archiveSha256"],
        "nativeProverCommit": PROVER_COMMIT,
        "nativeProverSha256": native["emvJarSha256"],
        "autoProverCommit": AUTOPROVER_COMMIT,
        "model": "lite-solo-mimo-v1",
        "mimoRunId": session.get("mimoWorkflowRunId"),
        "eligibleTargetCount": len(target_list),
        "results": [],
        "sourceAuthoredScriptExecutionVerified": False,
        "cloudProviderCalls": 0,
        "modelRequestCount": None,
        "nativeProofsProved": None,
    }
    def persist():
        output_file.parent.mkdir(parents=True, exist_ok=True)
        tmp = output_file.with_suffix(".part")
        tmp.write_text(json.dumps(outcome, sort_keys=True, indent=2) + "\n")
        tmp.replace(output_file)
        output_file.chmod(0o600)
    persist()
    begun = time.monotonic()
    # 330-minute Actions formal job includes source collection, native setup,
    # DB/RAG bootstrap and cleanup. Reserve time for the remaining runner steps.
    deadline = begun + 16500
    for index, target in enumerate(target_list):
        record: dict[str, object] = {
            "target": target["target"],
            "compilerVersion": target["compilerVersion"],
            "abiDigestSha256": target["abiDigestSha256"],
            "status": "NOT_RUN",
            "nativePropertyVerdicts": [],
        }
        remaining = deadline - time.monotonic()
        if remaining < 120:
            record["status"] = "NOT_RUN_GLOBAL_TIME_BUDGET"
            outcome["results"].append(record)
            persist()
            continue
        per_timeout = min(per_target_timeout, int(remaining - 50))
        project = private / ("target-" + str(index).zfill(2)) / "source"
        project.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        shutil.copytree(source, project)
        local_contract = project / target["sourcePath"]
        if not local_contract.is_file() or local_contract.is_symlink():
            record["status"] = "AUTHENTICATED_TARGET_COPY_MISSING"
            outcome["results"].append(record)
            persist()
            continue
        compiler = Path(versions[target["compilerVersion"]]["executable"]).resolve(strict=True)
        default_alias = tool_bin / "solc"
        if default_alias.exists() or default_alias.is_symlink():
            default_alias.unlink()
        default_alias.symlink_to(compiler)
        env = uncredentialed_formal_environment(private, {
            "PATH": ":".join([str(tool_bin), str(upstream / ".venv/bin"),
                              str(prover), os.environ.get("PATH", "/usr/bin:/bin")]),
            "JAVA_HOME": os.environ.get("JAVA_HOME", ""),
            "CERTORA": str(prover),
        })
        env.update({
            "CURVEYIELD_MIMO_VERIFIED_TAILNET_IP": ip,
            "CURVEYIELD_MIMO_BASE_URL": endpoint,
            "CERTORA_AI_COMPOSER_PGHOST": "127.0.0.1",
            "CERTORA_AI_COMPOSER_PGPORT": "5432",
            "COMPOSER_EMBED_DEVICE": "cpu",
            "PREAUDIT_LLM_BACKEND": "local",
            "PREAUDIT_LOCAL_LLM_BASE_URL": endpoint,
            "PREAUDIT_LOCAL_LLM_MODEL": "lite-solo-mimo-v1",
        })
        # Run the actual pinned console-autoprove main after activating the
        # MiMo-only AutoSetup adapter in the same process. Starting a separate
        # CLI process would lose its fail-closed runtime patch.
        entry = (
            "import sys; "
            "from curveyield_formal_mimo import configure_local_mimo_runtime; "
            "configure_local_mimo_runtime(); "
            "from composer.cli.console_autoprove import main; "
            "sys.argv=['console-autoprove']+sys.argv[1:]; "
            "raise SystemExit(main())"
        )
        args = [
            str(upstream / ".venv/bin/python"), "-c", entry,
            str(project), str(target["target"]), str(mapping["targetContextFile"]),
            "--heavy-model", "lite-solo-mimo-v1",
            "--lite-model", "lite-solo-mimo-v1",
            "--max-concurrent", "1",
            "--max-cpu-tasks", "1",
            "--run-mode", "comprehensive",
            "--tokens", "4096",
        ]
        logfile = project.parent / "native-autoprover-private.log"
        original_spec_digests = {
            p.relative_to(project).as_posix(): digest(p)
            for p in project.rglob("*.spec") if p.is_file()
        }
        record["originalSpecDigests"] = original_spec_digests
        started = time.monotonic()
        with logfile.open("wb") as out:
            process = subprocess.Popen(args, cwd=upstream, env=env, stdout=out,
                                       stderr=subprocess.STDOUT, start_new_session=True)
            try:
                returncode = process.wait(timeout=per_timeout)
                record["nativeExitCode"] = returncode
                record["status"] = ("NATIVE_AUTOPROVER_EXIT_ZERO_UNCLASSIFIED"
                                    if returncode == 0 else "NATIVE_AUTOPROVER_FAILED")
            except subprocess.TimeoutExpired:
                record["status"] = "TARGET_TIMEOUT"
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=12)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait(timeout=10)
            finally:
                if process.poll() is None:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait(timeout=10)
        logfile.chmod(0o600)
        record["elapsedSeconds"] = round(time.monotonic() - started, 2)
        record["privateNativeLogSha256"] = digest(logfile)
        final_specs = {
            p.relative_to(project).as_posix(): digest(p)
            for p in project.rglob("*.spec") if p.is_file()
        }
        record["finalSpecDigests"] = final_specs
        record["generatedSpecCount"] = len(set(final_specs) - set(original_spec_digests))
        internal = project / ".certora_internal" / "autoProve"
        run_index = internal / "components_to_prover_runs.json"
        if run_index.is_file():
            try:
                links = json.loads(run_index.read_text())
                if isinstance(links, dict):
                    record["nativeProverRunReferences"] = len(links)
                    # Parse only local paths, using the upstream's own strict
                    # treeView/RuleResult decoder. Do not infer rule success
                    # from stdout, exit zero, or generated CVL.
                    native_dirs = []
                    for link in links.values():
                        if not isinstance(link, str) or "://" in link:
                            continue
                        results_dir = Path(link)
                        if not results_dir.is_absolute():
                            results_dir = project / results_dir
                        results_dir = results_dir.resolve()
                        if results_dir.is_dir() and results_dir.is_relative_to(runner_temp):
                            native_dirs.append(str(results_dir))
                    if native_dirs:
                        reader = (
                            "import json,sys; from pathlib import Path; "
                            "from composer.prover.results import read_and_format_run_result; "
                            "rows=[]; "
                            "\nfor d in sys.argv[1:]:"
                            "\n result=read_and_format_run_result(Path(d),'evm')"
                            "\n if isinstance(result,str):"
                            "\n  rows.append({'resultError':result[:140]})"
                            "\n else:"
                            "\n  for r in result.values():"
                            "\n   rows.append({'rule':r.name,'nativeStatus':r.status,"
                            "'counterexamplePresent':r.counterexample is not None,"
                            "'sanity':r.path.sanity})"
                            "\nprint(json.dumps(rows))"
                        )
                        parser_result = subprocess.run(
                            [str(upstream / ".venv/bin/python"), "-c", reader, *native_dirs],
                            cwd=upstream, env=env, capture_output=True, text=True,
                            timeout=150, check=False)
                        if parser_result.returncode == 0:
                            parsed = json.loads(parser_result.stdout)
                            if isinstance(parsed, list):
                                permitted = {"VERIFIED", "VIOLATED", "TIMEOUT", "ERROR",
                                             "SANITY_FAILED", "SKIPPED"}
                                for item in parsed:
                                    if not isinstance(item, dict) or item.get("nativeStatus") not in permitted:
                                        continue
                                    normalized = {"VERIFIED": "PROVED",
                                                  "VIOLATED": "COUNTEREXAMPLE",
                                                  "TIMEOUT": "TIMEOUT",
                                                  "ERROR": "ERROR",
                                                  "SANITY_FAILED": "UNKNOWN",
                                                  "SKIPPED": "NOT_RUN"}
                                    record["nativePropertyVerdicts"].append({
                                        "rule": item.get("rule"),
                                        "nativeStatus": item["nativeStatus"],
                                        "verdict": normalized[item["nativeStatus"]],
                                        "counterexamplePresent": item.get("counterexamplePresent") is True,
                                        "sanity": item.get("sanity") is True,
                                    })
                        else:
                            record["nativeRuleParseError"] = (
                                "UPSTREAM_RULE_PARSER_FAILED_EXIT_" +
                                str(parser_result.returncode))
            except (ValueError, OSError, subprocess.TimeoutExpired):
                record["nativeProverRunReferences"] = None
        job_info = internal / "job_info.json"
        if job_info.is_file():
            try:
                info = json.loads(job_info.read_text())
                record["nativeJobInfoSha256"] = digest(job_info)
                if isinstance(info, dict) and isinstance(info.get("token_usage"), dict):
                    record["observedTokenUsage"] = {k: v for k, v in info["token_usage"].items()
                        if isinstance(v, (int, float)) and not isinstance(v, bool)}
            except (ValueError, OSError):
                pass
        if record["status"] == "NATIVE_AUTOPROVER_EXIT_ZERO_UNCLASSIFIED":
            if not record["nativePropertyVerdicts"]:
                record["status"] = "INCOMPLETE_NO_NATIVE_RULE_VERDICTS"
            else:
                record["status"] = "NATIVE_RULE_VERDICTS_CAPTURED"
        outcome["results"].append(record)
        persist()
        print(json.dumps({
            "stage": "I06.2", "targetIndex": index + 1,
            "targetCount": len(target_list), "status": record["status"],
            "generatedSpecCount": record.get("generatedSpecCount", 0),
            "elapsedSeconds": record.get("elapsedSeconds", 0),
        }, sort_keys=True), flush=True)
    observed = sum(len(r.get("nativePropertyVerdicts", [])) for r in outcome["results"])
    outcome["observedNativePropertyVerdicts"] = observed
    outcome["status"] = ("NATIVE_RULE_VERDICTS_OBSERVED" if observed
                         else "INCOMPLETE_NO_NATIVE_RULE_VERDICTS")
    outcome["nativeProofsProved"] = sum(
        v.get("nativeStatus") == "VERIFIED"
        for r in outcome["results"] for v in r.get("nativePropertyVerdicts", []))
    outcome["elapsedSeconds"] = round(time.monotonic() - begun, 2)
    persist()
    meaningful = sum(v.get("nativeStatus") not in ("SKIPPED", None)
                     for r in outcome["results"]
                     for v in r.get("nativePropertyVerdicts", []))
    return 0 if meaningful and len(outcome["results"]) == len(target_list) else 1


def main() -> int:
    parser = argparse.ArgumentParser(description="CurveYield source-bound local formal dispatcher")
    commands = parser.add_subparsers(dest="operation", required=True)
    restored = commands.add_parser("verify-native-cache", help="I05.2 verify restored native Certora binaries")
    restored.add_argument("--work-dir", type=Path, required=True)
    prep = commands.add_parser("prepare-toolchain", help="I02.1 local Certora Prover build and startup")
    prep.add_argument("--work-dir", type=Path, required=True)
    compilers = commands.add_parser("prepare-compilers", help="I02.2 native source-bound compiler qualification")
    compilers.add_argument("--work-dir", type=Path, required=True)
    compilers.add_argument("--identity", type=Path, required=True)
    compilers.add_argument("--requirements", type=Path, required=True)
    compilers.add_argument("--artifacts", type=Path, required=True)
    compilers.add_argument("--request", type=Path, required=True)
    intake = commands.add_parser("prepare-source-targets", help="I04.1 authenticated inert source intake")
    intake.add_argument("--work-dir", type=Path, required=True)
    intake.add_argument("--source-zip", type=Path, required=True)
    intake.add_argument("--artifact-request", type=Path, required=True)
    intake.add_argument("--request", type=Path, required=True)
    intake.add_argument("--manifest", type=Path, required=True)
    intake.add_argument("--identity", type=Path, required=True)
    intake.add_argument("--artifacts", type=Path, required=True)
    intake.add_argument("--preflight-run-id", type=int, required=True)
    intake.add_argument("--preflight-head-sha", required=True)
    intake.add_argument("--native-toolchain", type=Path)
    intake.add_argument("--native-compilers", type=Path)
    autoprover = commands.add_parser("prepare-autoprover", help="I03.1 upstream AutoProver native CLI qualification")
    autoprover.add_argument("--work-dir", type=Path, required=True)
    old_cvl = commands.add_parser("run-existing-cvl", help="I06.1 original authenticated CVL only")
    old_cvl.add_argument("--target-map", type=Path, required=True)
    old_cvl.add_argument("--native-toolchain", type=Path, required=True)
    old_cvl.add_argument("--native-compilers", type=Path, required=True)
    old_cvl.add_argument("--output", type=Path, required=True)
    generated = commands.add_parser("run-autoprover", help="I06.2 pinned upstream local AutoProver")
    generated.add_argument("--target-map", type=Path, required=True)
    generated.add_argument("--native-toolchain", type=Path, required=True)
    generated.add_argument("--native-compilers", type=Path, required=True)
    generated.add_argument("--session", type=Path, required=True)
    generated.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.operation == "run-autoprover":
        return run_authenticated_autoprover(
            target_map_file=args.target_map,
            native_toolchain_file=args.native_toolchain,
            compiler_file=args.native_compilers,
            session_file=args.session,
            output_file=args.output)
    if args.operation == "run-existing-cvl":
        result = run_authenticated_existing_cvl(
            target_map_file=args.target_map,
            native_toolchain_file=args.native_toolchain,
            compiler_file=args.native_compilers,
            output_file=args.output)
        print(json.dumps({k: v for k, v in result.items() if k != "results"},
                         sort_keys=True), flush=True)
        return 0
    if args.operation == "verify-native-cache":
        verify_cached_native_toolchain(args.work_dir)
        return 0
    if args.operation == "prepare-source-targets":
        result = prepare_authenticated_target_map(
            work_dir=args.work_dir, source_zip=args.source_zip,
            artifact_request_file=args.artifact_request,
            request_file=args.request, manifest_file=args.manifest,
            identity_file=args.identity, artifacts_file=args.artifacts,
            preflight_run_id=args.preflight_run_id,
            preflight_head_sha=args.preflight_head_sha,
            toolchain_report=args.native_toolchain,
            compiler_report=args.native_compilers,
        )
        print(json.dumps(result, sort_keys=True), flush=True)
        return 0
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
