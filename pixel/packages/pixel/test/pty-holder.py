"""Holds a pty open for a test: prints the device path, then copies what's written to the pty to stdout and stdin to the pty.

usage: pty-holder.py  (exits when stdin closes)
"""
import fcntl
import os
import select
import struct
import sys
import termios

master, slave = os.openpty()
fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
sys.stdout.write(os.ttyname(slave) + "\n")
sys.stdout.flush()
out = sys.stdout.buffer
while True:
    ready, _, _ = select.select([master, 0], [], [])
    if master in ready:
        try:
            data = os.read(master, 65536)
        except OSError:
            break
        if not data:
            break
        out.write(data)
        out.flush()
    if 0 in ready:
        data = os.read(0, 65536)
        if not data:
            break
        os.write(master, data)
