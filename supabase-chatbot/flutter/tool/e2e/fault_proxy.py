"""A reverse proxy in front of `graphrt serve` that breaks run streams on purpose.

Paths are `/<mode>/<serve path>`; the proxy forwards the request to serve and
relays the SSE response event by event (chunked), then, per mode:

- `pass`:  relays everything (control case);
- `cut`:   closes the socket right after the first `response` event, mid-chunked
           body, like a dropped mobile connection;
- `stall`: stops relaying after the first `response` event and keeps the
           connection open and silent for 30 s, like a dead network path.

Standard library only. Usage: python3 fault_proxy.py <listen_port> <serve_port>
"""

import http.client
import socket
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LISTEN_PORT, SERVE_PORT = int(sys.argv[1]), int(sys.argv[2])
HOP_BY_HOP = {"connection", "transfer-encoding", "content-length", "keep-alive"}


class FaultProxy(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_):
        pass

    def do_POST(self):
        _, mode, upstream_path = self.path.split("/", 2)
        body = self.rfile.read(int(self.headers.get("content-length") or 0))
        upstream = http.client.HTTPConnection("127.0.0.1", SERVE_PORT, timeout=60)
        headers = {k: v for k, v in self.headers.items() if k.lower() not in HOP_BY_HOP | {"host"}}
        upstream.request("POST", "/" + upstream_path, body=body, headers=headers)
        response = upstream.getresponse()
        self.send_response(response.status)
        for name, value in response.getheaders():
            if name.lower() not in HOP_BY_HOP:
                self.send_header(name, value)
        self.send_header("transfer-encoding", "chunked")
        self.end_headers()
        block = b""
        while True:
            line = response.readline()
            if not line:
                break
            block += line
            if line.strip():
                continue
            self.write_chunk(block)
            is_response_event = block.startswith(b"event: response")
            block = b""
            if is_response_event and mode == "cut":
                # No terminating 0-chunk: a broken body. shutdown() because
                # close() waits for the handler's file objects.
                self.connection.shutdown(socket.SHUT_RDWR)
                self.close_connection = True
                return
            if is_response_event and mode == "stall":
                time.sleep(30)
                return
        self.write_chunk(block)
        self.wfile.write(b"0\r\n\r\n")

    def write_chunk(self, data):
        if data and not self.close_connection:
            self.wfile.write(f"{len(data):x}\r\n".encode() + data + b"\r\n")
            self.wfile.flush()


ThreadingHTTPServer(("127.0.0.1", LISTEN_PORT), FaultProxy).serve_forever()
