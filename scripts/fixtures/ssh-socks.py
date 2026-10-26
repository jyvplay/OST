# TT42 TEST-ONLY fixture (asyncssh is EPL-2.0 / GPL-2.0+: used by tests, never shipped or imported by the app).
# An in-process SSH server (no auth; loopback only) plus an SSH client whose forward_socks listener is a real
# SOCKS 4 / 4a / 5 server: every CONNECT becomes an SSH direct-tcpip channel; the SERVER dials the destination and
# logs exactly which host string it was asked for (a name for SOCKS4a, an address for SOCKS4).
#   python ssh-socks.py <ssh_port> <socks_port>
import asyncio, sys, asyncssh

class Server(asyncssh.SSHServer):
    def begin_auth(self, username):
        return False  # loopback test server: no authentication
    def connection_requested(self, dest_host, dest_port, orig_host, orig_port):
        print("DIRECT-TCPIP", dest_host, dest_port, flush=True)
        return True

async def main():
    ssh_port, socks_port = int(sys.argv[1]), int(sys.argv[2])
    key = asyncssh.generate_private_key("ssh-ed25519")
    await asyncssh.create_server(Server, "127.0.0.1", ssh_port, server_host_keys=[key])
    conn = await asyncssh.connect("127.0.0.1", ssh_port, username="t", known_hosts=None, client_keys=None)
    await conn.forward_socks("127.0.0.1", socks_port)
    print("READY", flush=True)
    await asyncio.Future()

asyncio.run(main())
