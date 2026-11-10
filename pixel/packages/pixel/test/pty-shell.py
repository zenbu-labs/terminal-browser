"""Runs an interactive shell on a real pty and types the given bytes into it.

usage: pty-shell.py <json>  where json = {"argv": [...], "inputs": ["...", ...]}
After each input the harness waits for the shell to react: a fresh prompt when the input
ended a line, otherwise a short silence. Afterwards the line is cancelled with ctrl-c and
the shell is asked to exit. Everything the shell printed goes to stdout.
"""
import json
import os
import select
import shutil
import sys
import tempfile
import time

PROMPT = b"pty-shell$ "
QUIET = 0.15
LIMIT = 5.0

spec = json.loads(sys.argv[1])
scratch = tempfile.mkdtemp(prefix="pty-shell-")
pid, fd = os.forkpty()
if pid == 0:
    os.chdir(scratch)
    os.environ["TERM"] = "xterm-256color"
    os.environ["PS1"] = PROMPT.decode()
    os.execvp(spec["argv"][0], spec["argv"])

output = b""
closed = False


def read_some(timeout):
    global output, closed
    ready, _, _ = select.select([fd], [], [], timeout)
    if not ready:
        return False
    try:
        chunk = os.read(fd, 65536)
    except OSError:
        chunk = b""
    if not chunk:
        closed = True
        return False
    output += chunk
    return True


def wait_quiet():
    last = time.time()
    end = last + LIMIT
    while not closed and time.time() < end:
        if read_some(0.02):
            last = time.time()
        elif time.time() - last >= QUIET:
            return


def wait_prompt():
    prompts = output.count(PROMPT)
    end = time.time() + LIMIT
    while not closed and time.time() < end and output.count(PROMPT) == prompts:
        read_some(0.05)
    wait_quiet()


wait_prompt()
for text in spec["inputs"]:
    os.write(fd, text.encode())
    if text.endswith("\n"):
        wait_prompt()
    else:
        wait_quiet()
os.write(fd, b"\x03")
wait_prompt()
os.write(fd, b"exit\n")
end = time.time() + LIMIT
while not closed and time.time() < end:
    read_some(0.05)
try:
    os.kill(pid, 9)
except OSError:
    pass
os.waitpid(pid, 0)
leftovers = os.listdir(scratch)
shutil.rmtree(scratch, ignore_errors=True)
if leftovers:
    sys.stderr.write("shell created files: " + ", ".join(sorted(leftovers)) + "\n")
    sys.exit(3)
sys.stdout.buffer.write(output)
