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

PROVER_REPO = "https://github.com/Certora/CertoraProver.git"
PROVER_COMMIT = "4ef546d00cd67d333914845dead2d72081e1f014"


def invoke(argv: list[str], *, cwd: Path | None = None,
           env: dict[str, str] | None = None) -> str:
    print("NATIVE_TOOL:", " ".join(argv), flush=True)
    result = subprocess.run(argv, cwd=cwd, env=env, text=True,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            check=False)
    output = result.stdout or ""
    # No untrusted contract source is present during this subcommand.
    if output:
        print(output[-12000:], flush=True)
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

    # Tool installation occurs before the admitted ZIP is retrieved or unpacked.
    invoke(["sudo", "apt-get", "update"], env=env)
    invoke(["sudo", "apt-get", "install", "-y", "--no-install-recommends",
            "ca-certificates", "curl", "git", "build-essential", "cmake",
            "pkg-config", "clang", "llvm", "openjdk-21-jdk", "python3-venv",
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
    invoke(["bash", "./gradlew", "assemble", "--no-daemon"], cwd=source, env=env)
    invoke(["bash", "./gradlew", "copy-assets", "--no-daemon"], cwd=source, env=env)
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
        ("gradle", ["bash", "./gradlew", "--version"]),
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


def main() -> int:
    parser = argparse.ArgumentParser(description="CurveYield source-bound local formal dispatcher")
    commands = parser.add_subparsers(dest="operation", required=True)
    prep = commands.add_parser("prepare-toolchain", help="I02.1 local Certora Prover build and startup")
    prep.add_argument("--work-dir", type=Path, required=True)
    args = parser.parse_args()
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
