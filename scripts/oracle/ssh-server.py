#!/usr/bin/env python3
"""TT44 TEST-ONLY SSH/SFTP oracle server (asyncssh, not shipped). Prints "READY <port>" when listening.
Users: alice/pw1 (password), bob (publickey from AUTHKEYS), kbd (keyboard-interactive: two prompts "code"=4242, "pin"=7).
Exec commands: echo <x> | exit <n> | cat | sink | gen <n> | env <NAME> | sigwait | big-stderr <n>.
Shell (pty): prints a banner line with TERM and size, echoes lines, "size" -> current size, "exit" -> status 3."""
import asyncio, asyncssh, hashlib, os, sys

def B(x): return x if isinstance(x, (bytes, bytearray)) else str(x).encode()

ROOT = os.environ.get("SFTP_ROOT", "/tmp/sshroot")
AUTHKEYS = os.environ.get("AUTHKEYS", "")
HOSTKEYS = os.environ.get("HOSTKEYS", "").split(",")
KEX = os.environ.get("KEX")
REKEY = int(os.environ.get("REKEY_BYTES", "0") or 0)

class Server(asyncssh.SSHServer):
    def connection_made(self, conn): self._conn = conn
    def begin_auth(self, username):
        if username == "alice": self._conn.send_auth_banner("Authorized use only\n")
        return True
    def password_auth_supported(self): return True
    def validate_password(self, u, p): return u == "alice" and p == "pw1"
    def public_key_auth_supported(self): return True
    def kbdint_auth_supported(self): return True
    def get_kbdint_challenge(self, username, lang, submethods):
        if username != "kbd": return False
        return ("2FA", "answer both", "", [("code: ", True), ("pin: ", False)])
    def validate_kbdint_response(self, username, responses):
        return list(responses) == ["4242", "7"]

async def readline_cr(proc, state):
    """a terminal sends CR for Enter; asyncssh without a line editor does no ICRNL — split on CR or LF"""
    while True:
        for i, ch in enumerate(state["buf"]):
            if ch in (10, 13):
                line = bytes(state["buf"][:i]); del state["buf"][:i + 1]; return line + b"\n"
        d = await proc.stdin.read(4096)
        if not d: return b""
        state["buf"] += d

async def handle(proc: asyncssh.SSHServerProcess):
    cmd = proc.command
    if cmd is None:
        global ST
        ST = {"buf": bytearray()}
        tt = proc.get_terminal_type(); w, h, *_ = proc.get_terminal_size()
        proc.stdout.write(B(f"WELCOME TERM={tt} COLS={w} ROWS={h} ENV={proc.env.get('LANG','-')}\r\n$ "))
        try:
            while True:
                line = await readline_cr(proc, ST)
                if not line: break
                line = line.decode(errors="replace").strip()
                if line == "exit": proc.exit(3); return
                if line == "size":
                    w, h, *_ = proc.get_terminal_size(); proc.stdout.write(B(f"SIZE {w}x{h}\r\n$ ")); continue
                proc.stdout.write(B(f"YOU SAID [{line}]\r\n$ "))
        except asyncssh.TerminalSizeChanged as e:
            proc.stdout.write(B(f"\r\nRESIZED {e.width}x{e.height}\r\n"))
            # keep going after a resize
            return await handle_resumed(proc)
        proc.exit(0); return
    parts = cmd.split(" ", 1); op = parts[0]; arg = parts[1] if len(parts) > 1 else ""
    if op == "echo": proc.stdout.write(B(arg + "\n")); proc.exit(0)
    elif op == "exit": proc.exit(int(arg))
    elif op == "cat":
        while True:
            d = await proc.stdin.read(65536)
            if not d: break
            proc.stdout.write(d)
        proc.exit(0)
    elif op == "sink":
        h = hashlib.sha256(); n = 0
        while True:
            d = await proc.stdin.read(65536)
            if not d: break
            h.update(d); n += len(d)
        proc.stdout.write(B(f"{n} {h.hexdigest()}\n")); proc.exit(0)
    elif op == "gen":
        n = int(arg); h = hashlib.sha256(); i = 0
        while n > 0:
            chunk = hashlib.sha256(str(i).encode()).digest() * 1024
            chunk = chunk[:min(n, len(chunk))]; h.update(chunk); proc.stdout.write(chunk); n -= len(chunk); i += 1
            await proc.stdout.drain()
        proc.stderr.write(B(h.hexdigest().encode() + b"\n")); proc.exit(0)
    elif op == "big-stderr":
        proc.stderr.write(B(b"E" * int(arg))); proc.exit(0)
    elif op == "env": proc.stdout.write(B(proc.env.get(arg, "<unset>") + "\n")); proc.exit(0)
    elif op == "sigwait":
        proc.stdout.write(B("waiting\n"))
        try:
            await proc.stdin.read()
        except asyncssh.SignalReceived as s:
            proc.stdout.write(B(f"GOT {s.signal}\n")); proc.exit_with_signal("TERM", False, "terminated"); return
        proc.exit(0)
    else: proc.stderr.write(B(f"unknown: {cmd}\n")); proc.exit(127)

async def handle_resumed(proc):
    try:
        while True:
            line = await readline_cr(proc, ST)
            if not line: break
            line = line.decode(errors="replace").strip()
            if line == "exit": proc.exit(3); return
            if line == "size":
                w, h, *_ = proc.get_terminal_size(); proc.stdout.write(B(f"SIZE {w}x{h}\r\n$ ")); continue
            proc.stdout.write(B(f"YOU SAID [{line}]\r\n$ "))
    except asyncssh.TerminalSizeChanged as e:
        proc.stdout.write(B(f"\r\nRESIZED {e.width}x{e.height}\r\n")); return await handle_resumed(proc)
    proc.exit(0)

async def main():
    os.makedirs(ROOT, exist_ok=True)
    opts = dict(server_host_keys=[k for k in HOSTKEYS if k], process_factory=handle, encoding=None,
                sftp_factory=lambda chan: asyncssh.SFTPServer(chan, chroot=ROOT.encode()),
                authorized_client_keys=AUTHKEYS or None, line_editor=False, allow_scp=False)
    if KEX: opts["kex_algs"] = KEX.split(",")
    if REKEY: opts["rekey_bytes"] = REKEY
    srv = await asyncssh.create_server(Server, "127.0.0.1", int(os.environ.get("PORT", "0")), **opts)
    port = srv.sockets[0].getsockname()[1]
    print(f"READY {port}", flush=True)
    await asyncio.Future()

asyncio.run(main())
