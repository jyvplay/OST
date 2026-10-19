# TT44: SSH-2 client + SFTP (TD-03), a from-scratch terminal emulator, reflow

Since v3.1 the register said TD-03's SSH/SFTP half was **blocked**: "browsers have no raw TCP; SSH would require a
user-hosted WebSocket proxy". TT44 removes that blocker without a proxy. The **server half of Fusion** (the Next.js
process the user already runs) speaks SSH-2 itself, and the browser gets a framed HTTP stream. Everything is original
code:
- `src/lib/server/ssh/` holds the wire format, transport (KEX, ciphers, MACs, strict KEX, rekeying), user auth,
  channels, OpenSSH key files, known_hosts, SFTP v3, and the HTTP bridge. No SSH library is used.
- `src/lib/vt.ts` is a VT100/VT220/xterm emulator: no DOM, no dependencies.
- `src/lib/ssh-client.ts` is the DOM-free browser client (frames, ordered POST queue, re-attach).
- `src/components/modules/Ssh.tsx` is the window (form, host-key and auth dialogs, terminal, SFTP pane).

Prior art was read for protocol facts only: RFCs 4251–4254, 5656, 8268, 8308, 8709, 8731, 4419; OpenSSH's PROTOCOL,
PROTOCOL.key and PROTOCOL.chacha20poly1305; the strict-KEX draft; draft-ietf-secsh-filexfer-02; xterm's ctlseqs and
util.c. No code was copied. asyncssh (EPL/GPL), paramiko (LGPL), bcrypt-py and @xterm/headless (MIT) are **test-only
oracles**. None of them ships, and package.json lists @xterm only under devDependencies.

## Runtime honesty

**What ran,** in the Arena Linux sandbox:
- Node 22.22.3 and Next 16.2.6 production builds on :3999.
- Playwright 1.64.1 driving headless Chromium 153 (`@sparticuz/chromium`, installed from npm).
- PostgreSQL 18.4 from `embedded-postgres` (npm). See "Sandbox reset" below.
- Python 3.11 venv with asyncssh 2.24.1, cryptography, bcrypt and paramiko (PyPI), used as the **independent SSH server
  and SFTP server**.
- OpenSSH's `ssh-keygen` (Debian) as the oracle for fingerprints, key files and hashed known_hosts.
- @xterm/headless 6.0.0 plus addon-unicode11 as the terminal oracle. A real pty runs real programs (ls, less, top, bash
  readline, an ncurses app, git log --graph).

**Sandbox reset mid-turn:** the sandbox came back as Debian 12 with no PostgreSQL, no node_modules, no Python venv and
no browser. apt is blocked (only GitHub, npm and PyPI are reachable), so everything was rebuilt from those registries
with the repo's `scripts/sandbox/bootstrap.sh`, which now also installs the TT44 SSH oracles. After that every TT44 suite was re-run, and the full run
below is on the rebuilt environment.

**Not available, so not tested:**
- a real OpenSSH `sshd` (none in the sandbox, and apt is blocked), so the server oracle is asyncssh. OpenSSH appears
  only as `ssh-keygen`;
- vim and tmux as real programs (not installed);
- Firefox and Safari;
- a real remote host on the internet: egress is limited to GitHub, npm and PyPI, none of which serve SSH. Every server
  in the tests is on 127.0.0.1.

## A. Formal model

**Objects:**
- `Session = (id, host, port, user, route, state ∈ {new, connecting, hostkey, auth, ready, closed}, events[], prompts)`;
- `KnownHosts = OpenSSH-syntax lines` in the VFS at `/System/ssh/known_hosts`;
- `Key = OpenSSH private key file` (VFS path or pasted, never stored server-side);
- `Vt = (main, alt, scrollback, modes, pen, cursor)`.

**Access model:** the browser only talks to `/api/ssh*` on its own origin. Cross-site requests, and requests with
Origin `null`, are refused with 403. The Node process opens TCP:
- through the active privacy route (Tor, SOCKS or an HTTP proxy) by default;
- directly only when the user ticks "Bypass route". Even then .onion is refused in direct mode, with a Tor hint.

**Resource counted:** secrets sent before the host is authenticated. The target is **0**.

**Success:** for **every** server S and attacker M on the path:
- the client sends no password, key signature or keyboard-interactive answer before S's host key is either matched in
  known_hosts or explicitly accepted by the user after seeing its SHA256 fingerprint;
- a changed key of a known type is refused, with no prompt;
- every byte the user sees is authenticated by the negotiated AEAD or MAC.

**Failure:** any secret sent first, a changed key prompted instead of refused, or a forged or altered byte delivered.

**Terminal success:** for every byte stream, the visible cells, cursor and replies equal xterm's semantics. Where
xterm.js differs from xterm/VT510 we follow xterm and say so (H). Width changes re-wrap the primary buffer without
losing or inventing characters.

**Boundaries:**
- ≤ 16 sessions (the 17th gets 429);
- a 120 s re-attach grace period; 15 s keepalive; 300 s prompt timeout; ≤ 3 passphrase tries;
- POST frames ≤ 1 MiB; the browser parser caps a frame at 4 MiB;
- SFTP chunks of 32 KiB; the VFS copy is limited to 8 MiB (larger files: use Download).

**Adjacent problems not substituted:**
- a WebSocket-to-TCP proxy;
- an SSH library such as ssh2;
- a server-side keystore;
- port forwarding (not offered);
- Mosh;
- a telnet client.

## B. Hypotheses

- **H+:** an in-process SSH-2 client behind same-origin HTTP satisfies the contract. *Accepted:* tt44-unit 18/18,
  tt44-bridge 8/8, e2e-tt44 5/5.
- **H−:** "SSH is impossible from a browser." This holds for browser-side TCP only. It is not true of this stack,
  which already has a server half: that is the H∂ condition.
- **H∂:** the claim needs the Fusion server to reach the SSH host. With the default route that means the proxy or Tor
  path must allow the port. Some Tor exits block port 22, which is disclosed in the UI as a route error.

## C. Frontier

**Imported results:**
- RFC 4253 §8 / RFC 8731 key exchange. The exchange hash H covers V_C, V_S, I_C, I_S, K_S, Q_C, Q_S and K; the
  signature over H authenticates the server.
- Strict KEX (OpenSSH 9.6) closes Terrapin. Its preconditions: the client offers `kex-strict-c-v00@openssh.com` in the
  **initial** KEXINIT only, sequence numbers reset at every NEWKEYS, and any non-KEX message in the initial exchange
  aborts.
- chacha20-poly1305@openssh: the MAC is checked before decryption.

**Open interface:** post-quantum KEX (mlkem768x25519-sha256). Node 22 has no ML-KEM in `node:crypto`, so writing it
from scratch would mean an unverified lattice implementation. It is not shipped, and is listed as a blocker.

## D. Negative shapes (≥ 15) and the modal-shortcut test

Each of these looks like a solution but violates the contract. Each is tested to fail, or else excluded by design:
1. asking for the passphrase or password **before** the host key is accepted (tt44-bridge asserts the hostkey prompt
   index < the auth prompt index);
2. "Trust once" leaking to the next connection through a process-wide map (removed; tested by a second connection
   that prompts again);
3. a changed host key offered as a prompt rather than a refusal (tt44-bridge `hostkey-refused`);
4. a different host key accepted at a **rekey** (new this turn: a test plus mutant M6);
5. Terrapin: an IGNORE before the server KEXINIT (tt44-unit);
6. an IGNORE inside the initial KEX after KEXINIT (new this turn: a test plus mutant M2);
7. a bit flip after the handshake delivering corrupted bytes (5 cipher/MAC modes; delivered bytes must be a clean
   prefix);
8. an all-zero X25519 point (RFC 8731 §3);
9. private keys or passwords persisted (recent.json is checked for "pw1" and "PRIVATE KEY");
10. SFTP data written by the server into the VFS (refused by design: the browser decides and posts through /api/fs);
11. cross-site POST or GET to /api/ssh (403, including Origin `null`);
12. oversized or truncated frames (413 / 400);
13. OSC 52 letting the remote host read or write the clipboard (refused);
14. paste injection, where a pasted ESC sequence breaks out of bracketed paste (stripped; client-helper test);
15. a native `window.prompt` / `confirm` in the SFTP pane (replaced with in-app dialogs; the e2e counts native
    dialogs and expects 0);
16. a terminal narrowed by the Files pane silently cutting long lines (replaced by reflow; tt44-vt plus a round trip);
17. an action result wiped by the listing refresh, so the user never sees "Uploaded…" (fixed; the e2e checks the
    message is still shown after the refresh).

**The modal shortcut is "trust on first use, silently".** Most web SSH demos accept whatever host key arrives and show
the shell. It passes every functional test, yet it hands the password to a man in the middle on first contact.

**Test that detects it** (tt44-bridge and e2e-tt44):
- the first connection must emit a `hostkey` prompt **before** any auth prompt;
- its fingerprint must equal `ssh-keygen -lf` of the server's key;
- declining must close the session without any auth request reaching the server.

## E. Mechanism-distinct approaches considered

| # | Approach | Artifact / verdict |
|---|---|---|
| 1 | WebSocket-to-TCP proxy with SSH in the browser (the v3.1 plan) | Rejected: it needs a user-hosted proxy, and keys live in page JS. |
| 2 | An SSH library on the server (ssh2) | Rejected: the task requires original code. |
| 3 | **Original SSH-2 in the Node process plus a framed HTTP stream** | **Shipped.** Gap: post-quantum KEX. |
| 4 | Server-held keystore with the key decrypted at connect | Rejected: secrets at rest; the passphrase would be asked before the host-key check. |
| 5 | Terminal via xterm.js shipped to the browser | Rejected for shipping: 300 KB+ and not original. Used as the oracle only. |
| 6 | **Original VT emulator** (DOM-free) | **Shipped**; differential against xterm.js plus xterm C semantics. |
| 7 | SFTP through the VFS on the server | Rejected: the server would write user files without a browser decision. Upload and download go browser ↔ SFTP; "Save to Fusion" is an explicit browser action. |

## F. Artifacts

- **SSH:** `src/lib/server/ssh/{wire,crypto,transport,keys,sftp,known-hosts,bridge}.ts`.
- **API:** `src/app/api/ssh/route.ts`, `[id]/route.ts`, `[id]/sftp/route.ts`.
- **Client and UI:** `src/lib/ssh-client.ts`, `src/lib/vt.ts`, `src/components/modules/Ssh.tsx`. Terminal gains
  `ssh user@host -p N`; Devices links to the window.
- **Oracles:** `scripts/oracle/{ssh-server.py, pty-capture.py, curses-demo.py, vt-diff.mts}`.
- **Suites:** `scripts/{tt44-unit,tt44-vt,tt44-bridge,e2e-tt44}.mts`.
- **Infrastructure:** `scripts/sandbox/bootstrap.sh` (now with the TT44 oracles).

## G. Adversary findings (this turn)

- A process-wide "trust once" map made the trust last for the whole server process. It now covers one connection.
- The private key was decrypted (asking for the passphrase) **before** the host-key check. It is now loaded lazily,
  when the server first offers publickey, matching OpenSSH's order.
- `.fs-ask-show` (a checkbox class) had been put on the host-key backdrop. It was removed. The dialog is now measured
  in the e2e: topmost via `elementFromPoint`, effective opacity 1.
- The Files pane's "Files" button had the same accessible name as the shelf's Files app. It is renamed "Remote files".
- Row actions used arrow and emoji glyphs that this font stack lacks, so the buttons were **invisible**. They are now
  SVG icons with aria-labels; the e2e asserts targets ≥ 24 px, each with one path.
- The SSH terminal input had the same aria-label as Fusion's Terminal input. It is renamed "Remote terminal input".

## H. External verification

**Bound to tools:**
- tt44-unit 18/18 against asyncssh:
  - 18 KEX × cipher × MAC combinations with strict KEX;
  - password, banner, publickey and keyboard-interactive auth;
  - pty, exec and signals; rekeying both ways during 10 MiB transfers;
  - SFTP v3;
  - bcrypt_pbkdf and Poly1305 equal Python's; key files equal ssh-keygen's.
- tt44-bridge 8/8 over real HTTP. The fingerprint equals `ssh-keygen -lf`, and a 9 MiB SFTP transfer is byte-identical.
- e2e-tt44 5/5 in Chromium. It drives the real UI from the Terminal command to SFTP, with files checked on disk by
  sha256.

**Terminal:**
- fuzz: 600 seeds × 2 sizes, 1.43 M cells, 0 unexplained differences;
- 6 real programs × 2 chunkings;
- mouse 648/648; keys equal terminfo.

**Reflow (new this turn):** 300 seeds × 4 width changes. Every logical line equals the **input** (ground truth), and
equals xterm.js wherever xterm.js keeps the input.

**Documented divergences from xterm.js** (we follow xterm/VT510):
- DECALN, DECOM relative moves, CPR under DECOM and in pending wrap;
- an xterm.js crash on `CUP-past-corner` + ED1 (vt.ts survives it);
- DECRQSS ` q`; the saved cursor after a scroll;
- the pending-wrap erase (xterm util.c ClearRight);
- **new:** xterm.js does not reflow the line holding the cursor, so narrowing cuts it (347 of 1,200 reflow states).
  vt.ts re-wraps it, as VTE and kitty do. A minimal reproduction is a named test, and it proves the rule by showing
  the same line survives when the cursor is elsewhere.

**Mutation set** (6 mutants on the shipped code):

| Mutant | Result |
|---|---|
| poly1305 tag unchecked | killed (by a hang until the suite timeout, not a clean assertion) |
| strict-KEX enforcement off | **survived at first**, then killed by the new test |
| known_hosts "changed" dropped | killed |
| reflow padding marker ignored | killed |
| reflow cursor off by one | killed |
| rekey host-key change accepted | **survived at first**, then killed by the new test |

## I. Repair, then a new attack against the repair

**Repair 1, reflow:**
- The first version treated a blank last cell before a wide character as padding. That deleted real spaces typed at
  the last column.
- Padding is now marked as an unwritten cell (`""`, which is how xterm.js models it). `text()` and the renderer show
  it as blank.
- Attack on the patch: the cell vacated when reflow itself pushes a wide character down must carry the same marker,
  otherwise the **next** reflow inserts a space. A test found exactly that ("日本 語"); it is fixed, and the
  300×4-state test passes.

**Repair 2, the oracle harness:** my own extraction of xterm.js text dropped the second half of a wide character (an
empty cell of width 0), which falsely blamed xterm.js. It is fixed (width must be 1). Only the cursor-line rule is now
excused, by a mechanical classifier: an excused line must be the cursor's line, and every later line must match.

**Repair 3, the rekey hook:** the test-only `rekeyHostKeyAlgs` option was attacked for reachability. The bridge builds
SshClient options explicitly (username, preferHostKeyAlgs, verifyHostKey, auth), so no browser-supplied field reaches
the transport.

## J. Stopping

TD-03 is built. All four TT44 suites pass, the two surviving mutants were turned into tests, and the full run is below.

**Not reached:**
- post-quantum KEX (no ML-KEM in Node 22). **Closed in TT45:** an original FIPS 203 ML-KEM plus the three ML-KEM hybrids (DESIGN-TT45.md);
- diffie-hellman-group-exchange; zlib; certificates; port and agent forwarding;
- a real `sshd` oracle (apt blocked);
- vim and tmux captures;
- Firefox and Safari.

## Results (this turn)

Filled in from the full run; see the PR body for the final numbers.
