import argparse
import base64
import fcntl
import json
import os
import pty
import re
import select
import signal
import struct
import subprocess
import sys
import termios
import time

parser = argparse.ArgumentParser()
parser.add_argument("--capture", required=True)
parser.add_argument("--script", required=True)
parser.add_argument("--cols", type=int, default=100)
parser.add_argument("--rows", type=int, default=30)
parser.add_argument("--cell", default="10x20")
parser.add_argument("--timeout", type=float, default=30)
parser.add_argument("--frames", help="directory to keep the images sent through shared memory (t=s) in")
parser.add_argument("--version", default="1.2.3")
parser.add_argument("--legacy-keys", action="store_true")
parser.add_argument("--old-output", type=int)
parser.add_argument("--old-line", default="old output {n}")
parser.add_argument("--no-dsr", action="store_true")
parser.add_argument("--dsr-typeahead", default="{reply}")
parser.add_argument("command", nargs=argparse.REMAINDER)
args = parser.parse_args()
command = args.command[1:] if args.command and args.command[0] == "--" else args.command
cell_w, cell_h = (int(n) for n in args.cell.split("x"))
cols, rows = args.cols, args.rows
steps = json.load(open(args.script))

pid, fd = pty.fork()
if pid == 0:
    os.execvp(command[0], command)


def set_size():
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, cols * cell_w, rows * cell_h))


set_size()
capture = bytearray()
pending = b""
marks = {}
resizes = []
model = None
model_fed = 0


def model_catch_up(upto):
    global model_fed
    if model and upto > model_fed:
        model.stdin.write("write " + base64.b64encode(bytes(capture[model_fed:upto])).decode() + "\n")
        model_fed = upto


def cursor_answer(upto):
    if not model:
        return b"\x1b[1;1R"
    model_catch_up(upto)
    model.stdin.write("cursor\n")
    model.stdin.flush()
    row, col = (int(n) for n in model.stdout.readline().split())
    return args.dsr_typeahead.encode().decode("unicode_escape").encode("latin-1").replace(b"{reply}", b"\x1b[%d;%dR" % (row + 1, col + 1))


if args.old_output is not None:
    capture.extend(b"".join(args.old_line.replace("{n}", str(n)).encode() + b"\r\n" for n in range(1, args.old_output + 1)))
    model = subprocess.Popen(["node", os.path.join(os.path.dirname(os.path.abspath(__file__)), "model.js"), str(cols), str(rows), str(cell_w), str(cell_h)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
modes = set()
kitty_stack = {False: [], True: []}
alt = False


def write(data):
    os.write(fd, data)


def answer_csi(params, final, upto):
    global alt
    if final == "c" and params in ("", "0"):
        return b"\x1b[?62;22c"
    if final == "q" and params.startswith(">"):
        return b"\x1bP>|ghostty %s\x1b\\" % args.version.encode()
    if final == "n" and params == "6":
        return None if args.no_dsr else cursor_answer(upto)
    if final == "t" and params == "14":
        return b"\x1b[4;%d;%dt" % (rows * cell_h, cols * cell_w)
    if final == "t" and params == "16":
        return b"\x1b[6;%d;%dt" % (cell_h, cell_w)
    if final == "t" and params == "18":
        return b"\x1b[8;%d;%dt" % (rows, cols)
    if final == "u" and params == "?":
        stack = kitty_stack[alt]
        return b"\x1b[?%du" % (stack[-1] if stack else 0)
    if final == "u" and params.startswith(">"):
        kitty_stack[alt].append(int(params[1:] or 0))
    if final == "u" and params.startswith("<"):
        for _ in range(int(params[1:] or 1)):
            if kitty_stack[alt]:
                kitty_stack[alt].pop()
    if final == "p" and params.startswith("?") and params.endswith("$"):
        mode = int(params[1:-1])
        return b"\x1b[?%d;%d$y" % (mode, 1 if mode in modes else 2)
    if final in "hl" and params.startswith("?"):
        for part in params[1:].split(";"):
            if part.isdigit():
                (modes.add if final == "h" else modes.discard)(int(part))
                if int(part) in (1049, 1047, 47):
                    alt = final == "h"
    return None


def answer_osc(body):
    m = re.match(rb"^(10|11);\?$", body)
    if m:
        color = b"rgb:dcdc/dfdf/e4e4" if m.group(1) == b"10" else b"rgb:1e1e/2020/2626"
        return b"\x1b]" + m.group(1) + b";" + color + b"\x1b\\"
    m = re.match(rb"^4;(\d+);\?$", body)
    if m:
        return b"\x1b]4;" + m.group(1) + b";rgb:e5e5/c0c0/7b7b\x1b\\"
    return None


frames = []


def keep_frame_before_sender_removes_it(body):
    keys, _, payload = body[1:].partition(b";")
    fields = dict(part.split(b"=", 1) for part in keys.split(b",") if b"=" in part)
    if fields.get(b"t") != b"s" or not args.frames:
        return
    width, height = int(fields[b"s"]), int(fields[b"v"])
    name = base64.b64decode(payload).decode()
    try:
        import _posixshmem
        import mmap

        fd = _posixshmem.shm_open(name, os.O_RDONLY, 0)
        try:
            data = mmap.mmap(fd, width * height * 4, prot=mmap.PROT_READ)[:]
        finally:
            os.close(fd)
    except OSError as error:
        print("could not read %s: %s" % (name, error), file=sys.stderr)
        return
    os.makedirs(args.frames, exist_ok=True)
    file = os.path.join(args.frames, "frame-%d.rgba" % len(frames))
    open(file, "wb").write(data)
    frames.append({"offset": len(capture), "file": file, "width": width, "height": height, "id": int(fields.get(b"i", b"0")), "cols": int(fields.get(b"c", b"0")), "rows": int(fields.get(b"r", b"0"))})


def answer_apc(body):
    if body.startswith(b"G"):
        keep_frame_before_sender_removes_it(body)
    if body.startswith(b"G") and b"a=q" in body.split(b";")[0]:
        ident = re.search(rb"i=(\d+)", body)
        return b"\x1b_Gi=" + (ident.group(1) if ident else b"0") + b";OK\x1b\\"
    return None


def scan(data):
    global pending
    buf = pending + data
    replies, da1 = [], []
    i = 0
    while True:
        at = buf.find(b"\x1b", i)
        if at < 0 or at + 1 >= len(buf):
            pending = buf[at:] if at >= 0 else b""
            break
        kind = buf[at + 1 : at + 2]
        if kind == b"[":
            m = re.compile(rb"\x1b\[([\x30-\x3f]*)([\x20-\x2f]*)([\x40-\x7e])").match(buf, at)
            if not m:
                if re.compile(rb"\x1b\[[\x20-\x3f]*$").match(buf, at):
                    pending = buf[at:]
                    break
                i = at + 1
                continue
            params = (m.group(1) + m.group(2)).decode()
            reply = answer_csi(params, m.group(3).decode(), len(capture) - len(buf) + m.end())
            if reply:
                (da1 if m.group(3) == b"c" else replies).append(reply)
            i = m.end()
        elif kind in (b"]", b"_", b"P"):
            end = len(buf)
            stop = None
            for j in range(at + 2, len(buf)):
                if buf[j] == 7:
                    stop = (j, j + 1)
                    break
                if buf[j] == 0x1B and j + 1 < len(buf) and buf[j + 1] == 0x5C:
                    stop = (j, j + 2)
                    break
            if stop is None:
                pending = buf[at:]
                break
            body = buf[at + 2 : stop[0]]
            reply = answer_osc(body) if kind == b"]" else answer_apc(body) if kind == b"_" else None
            if reply:
                replies.append(reply)
            i = stop[1]
        else:
            i = at + 2
    if replies or da1:
        write(b"".join(replies + da1))


def pump(seconds):
    end = time.time() + seconds
    while True:
        left = end - time.time()
        if left <= 0:
            return True
        r, _, _ = select.select([fd], [], [], left)
        if fd in r:
            try:
                data = os.read(fd, 65536)
            except OSError:
                return False
            if not data:
                return False
            capture.extend(data)
            scan(data)


def decode(text):
    return text.encode("utf-8").decode("unicode_escape").encode("latin-1")


MOD_BITS = {"shift": 1, "alt": 2, "ctrl": 4, "super": 8}
CURSOR_FINALS = {"up": "A", "down": "B", "right": "C", "left": "D", "home": "H", "end": "F"}
TILDE_CODES = {"insert": 2, "delete": 3, "pageup": 5, "pagedown": 6}
KITTY_CODES = {"escape": 27, "enter": 13, "tab": 9, "backspace": 127, "space": 32}
LEGACY_BYTES = {"escape": b"\x1b", "enter": b"\r", "tab": b"\t", "backspace": b"\x7f", "space": b" "}


def ghostty_key(chord):
    *mods, key = chord.split("+")
    bits = sum(MOD_BITS[m] for m in mods)
    param = bits + 1
    stack = kitty_stack[alt]
    disambiguate = bool(stack and stack[-1] & 1) and not args.legacy_keys
    if key in CURSOR_FINALS:
        final = CURSOR_FINALS[key]
        if bits:
            return b"\x1b[1;%d%s" % (param, final.encode())
        return (b"\x1bO" if 1 in modes else b"\x1b[") + final.encode()
    if key in TILDE_CODES:
        return b"\x1b[%d%s~" % (TILDE_CODES[key], b";%d" % param if bits else b"")
    if disambiguate:
        if key in KITTY_CODES and (bits or key == "escape"):
            return b"\x1b[%d%su" % (KITTY_CODES[key], b";%d" % param if bits else b"")
        if key in LEGACY_BYTES:
            return LEGACY_BYTES[key]
        if bits & ~MOD_BITS["shift"]:
            return b"\x1b[%d;%du" % (ord(key.lower()), param)
        return (key.upper() if bits else key).encode()
    if key == "tab" and bits == MOD_BITS["shift"]:
        return b"\x1b[Z"
    if key == "space" and bits == MOD_BITS["ctrl"]:
        return b"\x00"
    text = LEGACY_BYTES.get(key) or (key.upper() if bits & MOD_BITS["shift"] else key).encode()
    if bits & MOD_BITS["ctrl"] and len(key) == 1:
        text = bytes([ord(key.lower()) & 0x1F])
    if bits & MOD_BITS["super"]:
        return b""
    return (b"\x1b" if bits & MOD_BITS["alt"] else b"") + text


alive = True
deadline = time.time() + args.timeout
search_from = 0
for step in steps:
    if not alive:
        break
    if "send" in step:
        write(decode(step["send"]) if step.get("escaped", True) else step["send"].encode())
    elif "key" in step:
        for chord in step["key"].split():
            write(ghostty_key(chord))
            alive = pump(0.03)
    elif "sleep" in step:
        alive = pump(step["sleep"] / 1000)
    elif "wait_for" in step:
        needle = decode(step["wait_for"])
        while alive and capture.find(needle, search_from) < 0 and time.time() < deadline:
            alive = pump(0.05)
        found = capture.find(needle, search_from)
        if found < 0:
            print("timed out waiting for %r" % step["wait_for"], file=sys.stderr)
            break
        search_from = found + len(needle)
    elif "resize" in step:
        cols, rows = step["resize"]
        model_catch_up(len(capture))
        if model:
            model.stdin.write("resize %d %d\n" % (cols, rows))
            model.stdin.flush()
        resizes.append([len(capture), cols, rows])
        set_size()
        os.kill(pid, signal.SIGWINCH)
    elif "mark" in step:
        marks[step["mark"]] = len(capture)

while alive and time.time() < deadline:
    alive = pump(0.2)
    if alive and os.waitpid(pid, os.WNOHANG)[0]:
        pump(0.1)
        break

try:
    os.kill(pid, signal.SIGKILL)
except ProcessLookupError:
    pass
open(args.capture, "wb").write(capture)
json.dump(marks, open(args.capture + ".marks.json", "w"))
json.dump(resizes, open(args.capture + ".resizes.json", "w"))
if model:
    model.stdin.close()
    model.wait()
if args.frames:
    json.dump(frames, open(os.path.join(args.frames, "frames.json"), "w"))
