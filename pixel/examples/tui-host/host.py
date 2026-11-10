#!/usr/bin/env python3

import fcntl
import json
import os
import re
import select
import signal
import socket
import struct
import subprocess
import sys
import termios
import tty

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
BIN = os.path.join(ROOT, "packages", "pixel", "dist", "bin.js")
APP = os.path.join(ROOT, "examples", "hello")
# Any pixel app works, e.g.  host.py terminal-browser open https://example.com
COMMAND = sys.argv[1:] or ["node", BIN, APP]
IMAGE_ID = 0x7E42
SIDEBAR = 28

PLACEHOLDER = "\U0010EEEE"
ROW_COLUMN_DIACRITICS = [chr(c) for c in (
    0x0305, 0x030D, 0x030E, 0x0310, 0x0312, 0x033D, 0x033E, 0x033F, 0x0346, 0x034A,
    0x034B, 0x034C, 0x0350, 0x0351, 0x0352, 0x0357, 0x035B, 0x0363, 0x0364, 0x0365,
    0x0366, 0x0367, 0x0368, 0x0369, 0x036A, 0x036B, 0x036C, 0x036D, 0x036E, 0x036F,
    0x0483, 0x0484, 0x0485, 0x0486, 0x0487, 0x0592, 0x0593, 0x0594, 0x0595, 0x0597,
    0x0598, 0x0599, 0x059C, 0x059D, 0x059E, 0x059F, 0x05A0, 0x05A1, 0x05A8, 0x05A9,
    0x05AB, 0x05AC, 0x05AF, 0x05C4, 0x0610, 0x0611, 0x0612, 0x0613, 0x0614, 0x0615,
    0x0616, 0x0617, 0x0657, 0x0658, 0x0659, 0x065A, 0x065B, 0x065D, 0x065E, 0x06D6,
    0x06D7, 0x06D8, 0x06D9, 0x06DA, 0x06DB, 0x06DC, 0x06DF, 0x06E0, 0x06E1, 0x06E2,
    0x06E4, 0x06E7, 0x06E8, 0x06EB, 0x06EC, 0x0730, 0x0732, 0x0733, 0x0735, 0x0736,
    0x073A, 0x073D, 0x073F, 0x0740, 0x0741, 0x0743, 0x0745, 0x0747, 0x0749, 0x074A,
    0x07EB, 0x07EC, 0x07ED, 0x07EE, 0x07EF, 0x07F0, 0x07F1, 0x07F3, 0x0816, 0x0817,
    0x0818, 0x0819, 0x081B, 0x081C, 0x081D, 0x081E, 0x081F, 0x0820, 0x0821, 0x0822,
    0x0823, 0x0825, 0x0826, 0x0827, 0x0829, 0x082A, 0x082B, 0x082C, 0x082D, 0x0951,
    0x0953, 0x0954, 0x0F82, 0x0F83, 0x0F86, 0x0F87, 0x135D, 0x135E, 0x135F, 0x17DD,
    0x193A, 0x1A17, 0x1A75, 0x1A76, 0x1A77, 0x1A78, 0x1A79, 0x1A7A, 0x1A7B, 0x1A7C,
    0x1B6B, 0x1B6D, 0x1B6E, 0x1B6F, 0x1B70, 0x1B71, 0x1B72, 0x1B73, 0x1CD0, 0x1CD1,
    0x1CD2, 0x1CDA, 0x1CDB, 0x1CE0, 0x1DC0, 0x1DC1, 0x1DC3, 0x1DC4, 0x1DC5, 0x1DC6,
    0x1DC7, 0x1DC8, 0x1DC9, 0x1DCB, 0x1DCC, 0x1DD1, 0x1DD2, 0x1DD3, 0x1DD4, 0x1DD5,
    0x1DD6, 0x1DD7, 0x1DD8, 0x1DD9, 0x1DDA, 0x1DDB, 0x1DDC, 0x1DDD, 0x1DDE, 0x1DDF,
    0x1DE0, 0x1DE1, 0x1DE2, 0x1DE3, 0x1DE4, 0x1DE5, 0x1DE6, 0x1DFE, 0x20D0, 0x20D1,
    0x20D4, 0x20D5, 0x20D6, 0x20D7, 0x20DB, 0x20DC, 0x20E1, 0x20E7, 0x20E9, 0x20F0,
    0x2CEF, 0x2CF0, 0x2CF1, 0x2DE0, 0x2DE1, 0x2DE2, 0x2DE3, 0x2DE4, 0x2DE5, 0x2DE6,
    0x2DE7, 0x2DE8, 0x2DE9, 0x2DEA, 0x2DEB, 0x2DEC, 0x2DED, 0x2DEE, 0x2DEF, 0x2DF0,
    0x2DF1, 0x2DF2, 0x2DF3, 0x2DF4, 0x2DF5, 0x2DF6, 0x2DF7, 0x2DF8, 0x2DF9, 0x2DFA,
    0x2DFB, 0x2DFC, 0x2DFD, 0x2DFE, 0x2DFF, 0xA66F, 0xA67C, 0xA67D, 0xA6F0, 0xA6F1,
    0xA8E0, 0xA8E1, 0xA8E2, 0xA8E3, 0xA8E4, 0xA8E5, 0xA8E6, 0xA8E7, 0xA8E8, 0xA8E9,
    0xA8EA, 0xA8EB, 0xA8EC, 0xA8ED, 0xA8EE, 0xA8EF, 0xA8F0, 0xA8F1, 0xAAB0, 0xAAB2,
    0xAAB3, 0xAAB7, 0xAAB8, 0xAABE, 0xAABF, 0xAAC1, 0xFE20, 0xFE21, 0xFE22, 0xFE23,
    0xFE24, 0xFE25, 0xFE26, 0x10A0F, 0x10A38, 0x1D185, 0x1D186, 0x1D187, 0x1D188, 0x1D189,
    0x1D1AA, 0x1D1AB, 0x1D1AC, 0x1D1AD, 0x1D242, 0x1D243, 0x1D244,
)]


def winsize():
    rows, cols, xpx, ypx = struct.unpack("HHHH", fcntl.ioctl(1, termios.TIOCGWINSZ, b"\0" * 8))
    return rows, cols, xpx, ypx


def write(s):
    os.write(1, s.encode() if isinstance(s, str) else s)


def supports_pixel_mouse(fd):
    """DECRQM for mode 1016: mouse reports in pixels rather than cells, so
    clicks and drags land where the pointer is and not on the cell grid."""
    write("\x1b[?1016$p")
    buf = b""
    while select.select([fd], [], [], 0.3)[0]:
        buf += os.read(fd, 64)
        if b"$y" in buf:
            break
    m = re.search(rb"\x1b\[\?1016;([12])\$y", buf)
    return m is not None


def query_cell_size(fd):
    """Asks the terminal for its cell size in pixels (CSI 16 t); falls back to the
    window pixel size the tty reports, then to a guess."""
    write("\x1b[16t")
    buf = b""
    while select.select([fd], [], [], 0.3)[0]:
        buf += os.read(fd, 64)
        if b"t" in buf:
            break
    m = re.search(rb"\x1b\[6;(\d+);(\d+)t", buf)
    if m:
        return int(m.group(2)), int(m.group(1)), True
    rows, cols, xpx, ypx = winsize()
    if xpx and ypx and rows and cols:
        return xpx // cols, ypx // rows, False
    return 10, 20, False


def query_colors(fd):
    """Asks the terminal for its foreground and background (OSC 10 and 11) so the
    app can match the theme. Returns None if the terminal does not answer."""
    write("\x1b]10;?\x1b\\\x1b]11;?\x1b\\")
    buf = b""
    while select.select([fd], [], [], 0.3)[0]:
        buf += os.read(fd, 256)
        if buf.count(b"rgb:") >= 2:
            break
    colors = {}
    for slot, name in ((b"10", "foreground"), (b"11", "background")):
        m = re.search(rb"\x1b\]" + slot + rb";rgb:([0-9a-fA-F]+)/([0-9a-fA-F]+)/([0-9a-fA-F]+)", buf)
        if m:
            colors[name] = [int(part[:2], 16) for part in m.groups()] + [255]
    return colors or None


class Host:
    def __init__(self):
        self.fd = sys.stdin.fileno()
        self.saved = termios.tcgetattr(self.fd)
        self.title = "starting"
        self.conn = None
        self.grid = None
        self.child = None
        self.buf = b""
        self.line_buf = b""
        self.pointer_in_app = False
        self.sock_path = f"/tmp/tui-host-{os.getpid()}.sock"

    def region(self):
        rows, cols, _, _ = winsize()
        col0 = SIDEBAR + 1
        return {"col0": col0, "row0": 1, "cols": max(1, cols - col0), "rows": max(1, rows - 2)}

    def draw_sidebar(self):
        rows, cols, _, _ = winsize()
        lines = [
            " ctrl+c  quit",
        ]
        for r in range(rows):
            text = lines[r] if r < len(lines) else ""
            write(f"\x1b[{r + 1};1H\x1b[0m{text.ljust(SIDEBAR)}\x1b[2m|\x1b[0m")
        write(f"\x1b[{rows};{SIDEBAR + 2}H\x1b[2m image id {IMAGE_ID}, {self.transport} frames\x1b[0m")

    def print_placeholders(self):
        if not self.grid:
            return
        r = self.region()
        cols = min(self.grid["cols"], r["cols"], len(ROW_COLUMN_DIACRITICS))
        rows = min(self.grid["rows"], r["rows"], len(ROW_COLUMN_DIACRITICS))
        image = self.grid["imageId"]
        fg = f"\x1b[38;2;{(image >> 16) & 255};{(image >> 8) & 255};{image & 255}m"
        out = []
        for row in range(rows):
            out.append(f"\x1b[{r['row0'] + row + 1};{r['col0'] + 1}H{fg}")
            out.append("".join(PLACEHOLDER + ROW_COLUMN_DIACRITICS[row] + ROW_COLUMN_DIACRITICS[col] for col in range(cols)))
        out.append("\x1b[39m")
        write("".join(out))

    def send(self, message):
        if self.conn:
            try:
                self.conn.sendall((json.dumps(message) + "\n").encode())
            except OSError:
                pass

    def size_message(self, kind):
        r = self.region()
        return {"type": kind, "cols": r["cols"], "rows": r["rows"],
                "width": r["cols"] * self.cell[0], "height": r["rows"] * self.cell[1],
                "cell": list(self.cell)}

    def resized(self):
        """The terminal may have changed its font as well as its size, so the cell
        size is asked for again; the app answers the new size with a fresh
        placement and the placeholders are printed then."""
        self.grid = None
        write("\x1b[2J")
        self.draw_sidebar()
        write("\x1b[16t")
        self.send(self.size_message("size"))

    def cell_reply(self, w, h):
        if (w, h) != self.cell:
            self.cell = (w, h)
            self.grid = None
            self.send(self.size_message("size"))

    def handle_app_line(self, line):
        try:
            message = json.loads(line)
        except ValueError:
            return
        kind = message.get("type")
        if kind == "join":
            init = self.size_message("init")
            init.update({"cell": list(self.cell), "imageId": IMAGE_ID, "transport": self.transport, "focused": True})
            if self.colors:
                init["colors"] = self.colors
            self.send(init)
        elif kind == "placed":
            self.grid = message
            self.print_placeholders()
        elif kind == "title":
            self.title = message.get("text") or self.title
            self.draw_sidebar()

    def key(self, name, text=None, **mods):
        m = {"shift": False, "alt": False, "ctrl": False, "super": False}
        m.update(mods)
        event = {"type": "key", "key": name, "kind": "press", "mods": m}
        if text is not None:
            event["text"] = text
        self.send(event)

    def mouse(self, seq):
        m = re.match(rb"\x1b\[<(\d+);(\d+);(\d+)([Mm])", seq)
        if not m:
            return
        b, x, y, kind = int(m.group(1)), int(m.group(2)), int(m.group(3)), m.group(4)
        r = self.region()
        if self.pixel_mouse:
            px = x - 1 - r["col0"] * self.cell[0]
            py = y - 1 - r["row0"] * self.cell[1]
            inside = 0 <= px < r["cols"] * self.cell[0] and 0 <= py < r["rows"] * self.cell[1]
        else:
            cx, cy = x - 1 - r["col0"], y - 1 - r["row0"]
            inside = 0 <= cx < r["cols"] and 0 <= cy < r["rows"]
            px, py = cx * self.cell[0] + self.cell[0] // 2, cy * self.cell[1] + self.cell[1] // 2
        if self.pointer_in_app and not inside:
            # the app may have set a pointer shape for what it was hovering
            write("\x1b]22;default\x1b\\")
        self.pointer_in_app = inside
        if not inside:
            return
        mods = {"shift": bool(b & 4), "alt": bool(b & 8), "ctrl": bool(b & 16), "super": False}
        if b & 64:
            action, button = ("scrollup" if (b & 3) == 0 else "scrolldown"), "none"
        elif b & 32:
            action, button = "move", "none"
        else:
            action = "down" if kind == b"M" else "up"
            button = ["left", "middle", "right", "none"][b & 3]
        self.send({"type": "mouse", "kind": action, "button": button, "mods": mods, "x": px, "y": py})

    def handle_input(self, data):
        self.buf += data
        while self.buf:
            b = self.buf
            m = re.match(rb"\x1b\[6;(\d+);(\d+)t", b)
            if m:
                self.buf = b[m.end():]
                self.cell_reply(int(m.group(2)), int(m.group(1)))
                continue
            if b.startswith(b"\x1b[6;") and len(b) < 16:
                return
            if b.startswith(b"\x1b[<"):
                m = re.match(rb"\x1b\[<\d+;\d+;\d+[Mm]", b)
                if not m:
                    return
                self.mouse(m.group(0))
                self.buf = b[m.end():]
                continue
            if b.startswith(b"\x1b["):
                m = re.match(rb"\x1b\[(\d*)(?:;(\d+))?([A-Za-z~])", b)
                if not m:
                    return
                self.buf = b[m.end():]
                final, num = m.group(3), m.group(1)
                arrows = {b"A": "up", b"B": "down", b"C": "right", b"D": "left", b"H": "home", b"F": "end"}
                if final in arrows:
                    self.key(arrows[final])
                elif final == b"~" and num == b"3":
                    self.key("delete")
                continue
            if b[:1] == b"\x1b":
                if len(b) == 1:
                    self.key("escape")
                    self.buf = b""
                    return
                self.buf = b[1:]
                continue
            ch = b[:1]
            if ch == b"\x03":
                raise KeyboardInterrupt
            if ch == b"\r":
                self.key("enter")
            elif ch == b"\x7f":
                self.key("backspace")
            elif ch == b"\t":
                self.key("tab")
            elif 1 <= ch[0] <= 26:
                self.key(chr(ch[0] + 96), ctrl=True)
            else:
                try:
                    text = b.decode()
                except UnicodeDecodeError:
                    self.buf = b[1:]
                    continue
                for c in text:
                    self.key(c, text=c, shift=c.isupper())
                self.buf = b""
                return
            self.buf = b[1:]

    def run(self):
        tty.setraw(self.fd)
        cell_w, cell_h, answered = query_cell_size(self.fd)
        self.cell = (cell_w, cell_h)
        self.transport = "file" if answered else "inline"
        self.colors = query_colors(self.fd)
        self.pixel_mouse = supports_pixel_mouse(self.fd)
        write("\x1b[?1049h\x1b[?25l\x1b[2J\x1b[?1003h\x1b[?1006h" + ("\x1b[?1016h" if self.pixel_mouse else ""))
        self.draw_sidebar()
        if os.path.exists(self.sock_path):
            os.remove(self.sock_path)
        server = socket.socket(socket.AF_UNIX)
        server.bind(self.sock_path)
        server.listen(1)
        env = dict(os.environ, PIXEL_EMBED=self.sock_path, PIXEL_TTY=os.ttyname(self.fd))
        env.pop("PIXEL_PANE", None)
        log = open(os.path.join(HERE, "app.stderr.log"), "ab")
        self.child = subprocess.Popen(COMMAND, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=log)
        resized = [False]
        # signal.signal(signal.SIGWINCH, lambda *_: resized.__setitem__(0, True))
        signal.signal(signal.SIGWINCH, lambda *args: on_resize(resized, args))
        try:
            while True:
                watch = [self.fd, server] + ([self.conn] if self.conn else [])
                try:
                    ready, _, _ = select.select(watch, [], [], 0.2)
                except InterruptedError:
                    ready = []
                if resized[0]:
                    resized[0] = False
                    self.resized()
                if server in ready:
                    self.conn, _ = server.accept()
                    self.line_buf = b""
                if self.conn in ready:
                    data = self.conn.recv(65536)
                    if not data:
                        return
                    self.line_buf += data
                    while b"\n" in self.line_buf:
                        line, self.line_buf = self.line_buf.split(b"\n", 1)
                        self.handle_app_line(line)
                if self.fd in ready:
                    data = os.read(self.fd, 4096)
                    if not data:
                        return
                    self.handle_input(data)
                if self.child.poll() is not None:
                    return
        except KeyboardInterrupt:
            pass
        finally:
            if self.child.poll() is None:
                self.child.terminate()
            write("\x1b[?1016l\x1b[?1006l\x1b[?1003l\x1b[?25h\x1b[?1049l")
            termios.tcsetattr(self.fd, termios.TCSADRAIN, self.saved)
            try:
                os.remove(self.sock_path)
            except OSError:
                pass



def on_resize(resized, args):
    resized.__setitem__(0, True)

if __name__ == "__main__":
    Host().run()
