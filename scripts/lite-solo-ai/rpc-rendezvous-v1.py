#!/usr/bin/env python3
"""Exact-run ephemeral Tailscale GGML RPC rendezvous for Lite-Solo MiMo inference.

The existing infer job remains the only audit/controller actor. Remote ranks
announce only an RPC endpoint and then monitor the infer job's completion.
This script is NOT a training coordinator and never accesses private audits.
"""
import argparse
import ipaddress
import json
import os
from pathlib import Path
import subprocess
import time

REPOSITORY = "curveyield3/Contract-Automation"
PORT = 50052
PREFIX = "lite-solo-ai-rpc-v1"


def require_env():
    if os.environ.get("GITHUB_REPOSITORY") != REPOSITORY:
        raise RuntimeError("Wrong repository for MiMo private rendezvous")


def validate_run(value):
    if not value.isdecimal() or not (4 <= len(value) <= 24):
        raise ValueError("Expected exact GitHub workflow run ID")
    return value


def validate_mode(value):
    if value not in ("2", "4"):
        raise ValueError("RPC requires two or four inference runners")
    return int(value)


def validate_ip(value):
    address = ipaddress.ip_address(value)
    if address.version != 4 or address not in ipaddress.ip_network("100.64.0.0/10"):
        raise ValueError("Expected an ephemeral Tailscale 100.64.0.0/10 IPv4")
    return str(address)


def gh(*args):
    return subprocess.check_output(["gh", *args], text=True, timeout=40).strip()


def announce(a):
    require_env()
    validate_run(a.run_id)
    count = validate_mode(a.mode)
    if a.rank not in range(1, count):
        raise ValueError("Invalid remote RPC rank for selected inference mode")
    path = Path(a.output)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({
        "schemaVersion": "lite-solo-ai-rpc-peer-v1",
        "repository": REPOSITORY,
        "runId": a.run_id,
        "rank": a.rank,
        "inferenceRunners": count,
        "modelSha256": a.model_sha256,
        "llamaCommit": a.llama_commit,
        "tailscaleIPv4": validate_ip(a.address),
        "rpcPort": PORT,
    }, sort_keys=True, indent=2) + "\n", encoding="utf-8")
    print(f"RPC rank {a.rank} private endpoint announced", flush=True)


def collect(a):
    require_env()
    validate_run(a.run_id)
    count = validate_mode(a.mode)
    folder = Path(a.destination)
    folder.mkdir(parents=True, exist_ok=True)
    matches = {}
    expected = set(range(1, count))
    for attempt in range(80):
        listing = json.loads(gh(
            "api", f"repos/{REPOSITORY}/actions/runs/{a.run_id}/artifacts?per_page=100"
        ))
        artifacts = {}
        for item in listing.get("artifacts", []):
            if not item.get("expired"):
                artifacts.setdefault(item.get("name"), []).append(item)
        for rank in sorted(expected - set(matches)):
            name = f"{PREFIX}-{a.run_id}-rank-{rank}"
            if name not in artifacts:
                continue
            if len(artifacts[name]) != 1:
                raise ValueError("Ambiguous RPC peer receipt")
            target = folder / str(rank)
            target.mkdir(exist_ok=True)
            subprocess.run([
                "gh", "run", "download", a.run_id, "--repo", REPOSITORY,
                "--name", name, "--dir", str(target),
            ], check=True, timeout=90)
            receipts = list(target.rglob("rendezvous.json"))
            if len(receipts) != 1:
                raise ValueError("Missing or duplicated RPC peer receipt")
            data = json.loads(receipts[0].read_text(encoding="utf-8"))
            if (
                data.get("schemaVersion") != "lite-solo-ai-rpc-peer-v1"
                or data.get("repository") != REPOSITORY
                or data.get("runId") != a.run_id
                or data.get("rank") != rank
                or data.get("inferenceRunners") != count
                or data.get("modelSha256") != a.model_sha256
                or data.get("llamaCommit") != a.llama_commit
                or data.get("rpcPort") != PORT
            ):
                raise ValueError("Source/model/run/rank mismatch in RPC receipt")
            matches[rank] = validate_ip(data["tailscaleIPv4"]) + f":{PORT}"
        if set(matches) == expected:
            break
        print(f"Waiting for exact-run MiMo RPC peers: {len(matches)}/{count-1}, "
              f"attempt {attempt+1}/80", flush=True)
        time.sleep(15)
    if set(matches) != expected:
        raise RuntimeError("Private MiMo RPC peer rendezvous expired")
    # Always include coordinator's localhost RPC device: even rank zero's CPU
    # participates in remote-device tensor sharding, instead of idle waiting.
    all_devices = [f"127.0.0.1:{PORT}"] + [matches[i] for i in sorted(expected)]
    Path(a.output).write_text(",".join(all_devices) + "\n", encoding="utf-8")
    print(f"Resolved {count} GGML RPC devices (including local coordinator)", flush=True)


def monitor(a):
    require_env()
    validate_run(a.run_id)
    validate_mode(a.mode)
    # The inference job can last 355 minutes. It is the sole agent allowed to
    # submit controller work; remote ranks must outlive every inference call.
    for attempt in range(1430):
        listing = json.loads(gh(
            "api", f"repos/{REPOSITORY}/actions/runs/{a.run_id}/jobs?per_page=100"
        ))
        infer = [j for j in listing.get("jobs", []) if j.get("name") == "infer"]
        if len(infer) == 1 and infer[0].get("status") == "completed":
            status = infer[0].get("conclusion")
            print("MiMo coordinator finished: " + str(status), flush=True)
            # Remote service cleanup follows the authoritative coordinator
            # termination even if it failed; never claim controller acceptance.
            print("Remote RPC peer stopping on coordinator completion; "
                  "no controller-acceptance claim", flush=True)
            return
        time.sleep(15)
    raise RuntimeError("MiMo coordinator did not finish in bounded shard lifetime")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    p = commands.add_parser("announce")
    p.add_argument("--run-id", required=True)
    p.add_argument("--mode", required=True)
    p.add_argument("--rank", required=True, type=int)
    p.add_argument("--address", required=True)
    p.add_argument("--model-sha256", required=True)
    p.add_argument("--llama-commit", required=True)
    p.add_argument("--output", required=True)
    p = commands.add_parser("collect")
    p.add_argument("--run-id", required=True)
    p.add_argument("--mode", required=True)
    p.add_argument("--model-sha256", required=True)
    p.add_argument("--llama-commit", required=True)
    p.add_argument("--destination", required=True)
    p.add_argument("--output", required=True)
    p = commands.add_parser("monitor")
    p.add_argument("--run-id", required=True)
    p.add_argument("--mode", required=True)
    args = parser.parse_args()
    {"announce": announce, "collect": collect, "monitor": monitor}[args.command](args)


if __name__ == "__main__":
    main()
