#!/usr/bin/env python3
"""Fail-closed, bounded subprocess runner for evidence-producing audit jobs (v1).

Exit codes: 124 wall timeout; 125 inactivity timeout; 126 startup error.
Preserves the child's original nonzero exit code and streamed raw log.
"""
import argparse
import os
import selectors
import signal
import subprocess
import sys
import time
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--wall", type=int, required=True)
    parser.add_argument("--idle", type=int, required=True)
    parser.add_argument("--log", required=True)
    parser.add_argument("--label", required=True)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command or not (0 < args.idle < args.wall):
        parser.error("requires command with 0 < idle < wall")
    path = Path(args.log)
    path.parent.mkdir(parents=True, exist_ok=True)
    start = last_output = last_notice = time.monotonic()
    print(f"::notice::{args.label}: wall={args.wall}s idle={args.idle}s", flush=True)
    with path.open("wb") as log:
        try:
            proc = subprocess.Popen(command, stdout=subprocess.PIPE,
                                    stderr=subprocess.STDOUT, start_new_session=True, bufsize=0)
        except OSError as error:
            line = f"::error::{args.label}: launch failed: {error}\n".encode()
            log.write(line)
            sys.stdout.buffer.write(line)
            sys.stdout.buffer.flush()
            return 126
        os.set_blocking(proc.stdout.fileno(), False)
        selector = selectors.DefaultSelector()
        selector.register(proc.stdout, selectors.EVENT_READ)
        timed_out = None
        while selector.get_map() or proc.poll() is None:
            for key, _ in selector.select(timeout=1):
                data = os.read(key.fileobj.fileno(), 65536)
                if data:
                    last_output = time.monotonic()
                    log.write(data)
                    log.flush()
                    sys.stdout.buffer.write(data)
                    sys.stdout.buffer.flush()
                else:
                    selector.unregister(key.fileobj)
            now = time.monotonic()
            if proc.poll() is not None and not selector.get_map():
                break
            if now - last_notice >= 60:
                print(f"::notice::{args.label}: elapsed={int(now-start)}s quiet={int(now-last_output)}s", flush=True)
                last_notice = now
            if now - start >= args.wall:
                timed_out = ("wall timeout", 124)
                break
            if now - last_output >= args.idle:
                timed_out = ("output inactivity", 125)
                break
        selector.close()
        if timed_out is not None:
            line = f"::error::{args.label}: {timed_out[0]} after {int(time.monotonic()-start)}s\n".encode()
            log.write(line)
            log.flush()
            sys.stdout.buffer.write(line)
            sys.stdout.buffer.flush()
            try:
                os.killpg(proc.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                proc.wait(timeout=8)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(proc.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                proc.wait()
            return timed_out[1]
        return proc.returncode if proc.returncode is not None else 1


if __name__ == "__main__":
    sys.exit(main())
