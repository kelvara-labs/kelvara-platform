#!/usr/bin/env python3
"""Local static mirror plus same-origin HAOS API reverse proxy."""
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit
from urllib.request import Request, urlopen
from urllib.error import HTTPError
import json
import argparse

UPSTREAM = "http://192.168.0.193:7650"

def forwarded_headers(headers):
    forwarded = {"Origin": "https://app.kelvara.xyz"}
    for key in ("Content-Type", "Authorization", "X-Kelvara-Network", "X-Kelvara-Genesis"):
        if headers.get(key):
            forwarded[key] = headers[key]
    return forwarded

class Handler(SimpleHTTPRequestHandler):
    def do_GET(self): self._proxy_or_static("GET")
    def do_POST(self): self._proxy_or_static("POST")
    def _proxy_or_static(self, method):
        path = urlsplit(self.path).path
        if path == "/healthz" or path.startswith("/api/"):
            self._proxy(method)
        else:
            if path == "/": self.path = "/index.deployed.html"
            super().do_GET()
    def _proxy(self, method):
        body = None
        if method == "POST":
            length = int(self.headers.get("Content-Length", "0")); body = self.rfile.read(length)
        req = Request(UPSTREAM + self.path, data=body, method=method, headers=forwarded_headers(self.headers))
        try:
            with urlopen(req, timeout=30) as response:
                self._relay(response.status, response.headers, response.read())
        except HTTPError as exc:
            self._relay(exc.code, exc.headers, exc.read())
        except Exception:
            self._relay_json(502, {"error": "HAOS upstream unavailable"})
    def _relay(self, status, headers, data):
        self.send_response(status)
        for key in ("Content-Type", "Cache-Control"):
            if headers.get(key): self.send_header(key, headers[key])
        self.send_header("Content-Length", str(len(data))); self.end_headers(); self.wfile.write(data)
    def _relay_json(self, status, payload):
        data = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data))); self.end_headers(); self.wfile.write(data)
    def log_message(self, fmt, *args): print(fmt % args)

if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("--port", type=int, default=7780); ap.add_argument("--bind", default="127.0.0.1"); args = ap.parse_args()
    ThreadingHTTPServer((args.bind, args.port), Handler).serve_forever()
