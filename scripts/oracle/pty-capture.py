#!/usr/bin/env python3
"""TT44 TEST-ONLY: run a program under a real pty (given size, TERM=xterm-256color), type scripted keys, and print
everything it wrote as one base64 line. Keys: JSON list of [delay_seconds, "text"] in env KEYS.
Usage: pty-capture.py COLS ROWS cmd args..."""
import base64, json, os, pty, select, struct, sys, termios, time, fcntl, signal

cols, rows = int(sys.argv[1]), int(sys.argv[2])
cmd = sys.argv[3:]
keys = json.loads(os.environ.get("KEYS", "[]"))
pid, fd = pty.fork()
if pid == 0:
    os.environ.update({"TERM": "xterm-256color", "COLUMNS": str(cols), "LINES": str(rows), "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8", "PS1": "\\u$ ", "LESSHISTFILE": "-", "HOME": "/tmp"})
    fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))  # size set BEFORE exec (no race)
    os.execvp(cmd[0], cmd)
out = bytearray()
def pump(t):
    end = time.time() + t
    while True:
        left = end - time.time()
        if left <= 0: return True
        r, _, _ = select.select([fd], [], [], left)
        if r:
            try: d = os.read(fd, 65536)
            except OSError: return False
            if not d: return False
            out.extend(d)
alive = pump(0.6)
for delay, text in keys:
    if not alive: break
    os.write(fd, text.encode())
    alive = pump(delay)
if alive:
    pump(0.4)
    try: os.kill(pid, signal.SIGTERM)
    except ProcessLookupError: pass
try: os.waitpid(pid, 0)
except ChildProcessError: pass
print(base64.b64encode(bytes(out)).decode())
