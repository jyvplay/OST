import type { SpecRow } from "./row";

/**
 * TT44 register change: TD-03's SSH/SFTP half — blocked since v3.1 ("no raw TCP in a browser") — closed with original
 * code: the SERVER half of Fusion speaks SSH-2 (from-scratch transport, KEX, ciphers, auth, channels, SFTP v3) and the
 * browser gets a framed HTTP stream; the terminal is a from-scratch VT emulator (src/lib/vt.ts).
 */
export function patchTT44(f: SpecRow): SpecRow {
  if (f.code !== "TD-03") return f;
  return {
    ...f,
    status: "built",
    route: "SSH window (Connect group; Terminal: `ssh user@host -p N`) — SSH-2 client + SFTP v3 browser; Devices → Serial: Web Serial console with baud selection",
    nuance: "TT44: original SSH-2 implementation in src/lib/server/ssh (no SSH library): curve25519-sha256 / ecdh-sha2-nistp256/384/521 / "
      + "diffie-hellman-group16-sha512 / group14-sha256 KEX with strict-kex (Terrapin, CVE-2023-48795, refused); chacha20-poly1305, aes128/256-gcm, aes-ctr + "
      + "hmac-sha2-256/512(-etm); ssh-ed25519 / ecdsa-sha2-nistp* / rsa-sha2-256/512 host keys and user keys (OpenSSH key format incl. "
      + "bcrypt-pbkdf encrypted keys); password, publickey, keyboard-interactive auth; pty, resize, signals, exit status; rekeying; SFTP v3 "
      + "(list, upload/download in 32 KiB pipelined chunks, mkdir/rmdir/rename/remove). Host keys are checked BEFORE any secret is sent "
      + "(first contact shows the SHA256 fingerprint, identical to ssh-keygen -lf; a changed key is refused with the known_hosts line); "
      + "trusted keys live in /System/ssh/known_hosts (OpenSSH syntax incl. hashed entries); private keys are read from /Private and "
      + "decrypted only after the host key is accepted; passwords are never stored. Connections go through the active privacy route "
      + "(Tor/SOCKS/HTTP proxy) unless 'Bypass route' is chosen. Terminal: VT100/VT220/xterm emulator differentially checked against "
      + "xterm.js (1.43 M cells fuzzed, 6 real programs via a real pty, mouse, keys == terminfo), with reflow on width change. "
      + "Verified against an independent server (asyncssh) and OpenSSH's ssh-keygen. Not supported (disclosed): diffie-hellman-group-exchange, "
      + "zlib compression, post-quantum KEX (mlkem768x25519 / sntrup761x25519), ssh-rsa SHA-1 signatures, certificates, port forwarding, "
      + "agent forwarding, X11; terminal: DECCOLM, sixel, DECLRMM, OSC 52 (refused on purpose). Serial is Chromium-only (Web Serial).",
    test: "tt44-unit.mts; tt44-vt.mts; tt44-bridge.mts; e2e-tt44.mts",
  };
}
