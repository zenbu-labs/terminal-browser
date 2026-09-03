"""Runs an interactive shell on a real pty and types the given bytes into it.

usage: pty-shell.py <json>  where json = {"argv": [...], "inputs": ["...", ...], "settle_ms": 700}
Each input is written, then the shell gets settle_ms to react. Afterwards the line is
cancelled with ctrl-c and the shell is asked to exit. Everything the shell printed goes to stdout.
"""
import json
import os
import select
import sys
import time

spec = json.loads(sys.argv[1])
pid, fd = os.forkpty()
if pid == 0:
    os.environ["TERM"] = "xterm-256color"
    os.environ["PS1"] = "$ "
    os.execvp(spec["argv"][0], spec["argv"])

output = b""


def pump(seconds):
    global output
    end = time.time() + seconds
    while time.time() < end:
        ready, _, _ = select.select([fd], [], [], 0.05)
        if not ready:
            continue
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            return
        if not chunk:
            return
        output += chunk


pump(1.0)
for text in spec["inputs"]:
    os.write(fd, text.encode())
    pump(spec.get("settle_ms", 700) / 1000)
os.write(fd, b"\x03")
pump(0.3)
os.write(fd, b"exit\n")
pump(1.0)
try:
    os.kill(pid, 9)
except OSError:
    pass
sys.stdout.buffer.write(output)
