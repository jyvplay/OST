"""
TT38 test fixture: an independent RFC 6455 server (Python `websockets`, BSD-3) for Fusion's WebSocket tests.
Test-only; never shipped. Prints "READY <port>" once listening on 127.0.0.1.

Paths:  /echo        echoes every message (text stays text, binary stays binary); picks subprotocol chat.v2 if offered
        /frag        sends one text message in 3 fragments, then one binary message in 2 fragments
        /ping        server pings; replies "pong-ok" when the client's pong arrived
        /close4001   closes with 4001 "bye ✓"          /close1011  closes with 1011
        /big?n=N     sends one binary message of N bytes (bytes i % 251)
        /headers     sends JSON of the handshake's User-Agent, Origin, Cookie; the 101 reply sets a cookie
        /hold        sends "hi" and keeps the socket open; prints "CLOSED <code>" when the client closes
        /count       sends 1..200 as text as fast as it can, then closes 1000
"""
import asyncio, json, sys
from urllib.parse import urlparse, parse_qs
from websockets.asyncio.server import serve
from websockets.exceptions import ConnectionClosed


def select(connection, offered):
    return "chat.v2" if "chat.v2" in offered else None


def on_response(connection, request, response):
    if urlparse(request.path).path == "/headers":
        response.headers["Set-Cookie"] = "wsck=from101; Path=/"
    return response


async def handler(ws):
    u = urlparse(ws.request.path)
    p = u.path
    if p == "/echo":
        try:
            async for m in ws:
                await ws.send(m)
        except ConnectionClosed:
            pass  # a non-1000 close from the client is part of the tests
    elif p == "/frag":
        await ws.send(["fra", "gmen", "ted ✓"])
        await ws.send([b"\x00\x01", b"\x02\xff"])
        await ws.wait_closed()
    elif p == "/ping":
        waiter = await ws.ping(b"probe")
        await asyncio.wait_for(waiter, 5)
        await ws.send("pong-ok")
        await ws.wait_closed()
    elif p == "/close4001":
        await ws.close(4001, "bye ✓")
    elif p == "/close1011":
        await ws.close(1011, "")
    elif p == "/big":
        n = int(parse_qs(u.query).get("n", ["0"])[0])
        await ws.send(bytes(i % 251 for i in range(n)))
        await ws.wait_closed()
    elif p == "/headers":
        h = ws.request.headers
        await ws.send(json.dumps({"ua": h.get("User-Agent"), "origin": h.get("Origin"), "cookie": h.get("Cookie")}))
        await ws.wait_closed()
    elif p == "/hold":
        await ws.send("hi")
        await ws.wait_closed()
        print("CLOSED", ws.protocol.close_code, flush=True)
    elif p == "/count":
        for i in range(1, 201):
            await ws.send(str(i))
        await ws.close(1000, "done")


async def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 0
    async with serve(handler, "127.0.0.1", port, select_subprotocol=select, process_response=on_response, max_size=32 * 1024 * 1024, ping_interval=None) as server:
        print("READY", server.sockets[0].getsockname()[1], flush=True)
        await asyncio.get_running_loop().create_future()


asyncio.run(main())
