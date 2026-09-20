#!/usr/bin/env python3
"""Servidor local para ejecutar Tienda Nápoles sin internet."""

from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import os

PORT = 8766
ROOT = Path(__file__).resolve().parent


class OfflineHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        # El service worker conserva una copia para cuando no exista red.
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()


if __name__ == "__main__":
    os.chdir(ROOT)
    server = ThreadingHTTPServer(("127.0.0.1", PORT), OfflineHandler)
    print(f"Tienda Nápoles Offline: http://127.0.0.1:{PORT}/admin.html")
    server.serve_forever()
