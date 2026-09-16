#!/usr/bin/env python3
"""Serve app/ for the web build.

Two things the stock `python3 -m http.server` gets wrong causing quiet fails:

  caching    It sends no cache headers at all, so browsers fall back to
             heuristic freshness and may not revalidate. An edited module then
             loads from cache while its neighbours load fresh, and the mismatch
             fails at the import, which kills the whole app, since every
             listener is registered by the module that failed to load. The only
             symptom is one line in the console.

  0.0.0.0    Only localhost and 127.0.0.1 are trustworthy origins. Served on
             0.0.0.0 the page is not a secure context, so the File System
             Access API is missing and Chrome and Edge silently lose
             save-to-folder, falling back to ZIP downloads.

Usage: dev-server.py [port]
"""

import functools
import http.server
import os
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'app')


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # Never reuse a module across an edit: correctness beats a warm cache
        # on a local dev server serving files off an SSD.
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        super().end_headers()

    def send_head(self):
        # Binding to localhost is not enough to keep people off 0.0.0.0: that
        # address still reaches this server, it is the one the stock module
        # prints, and it costs a secure context. Send them to the real name.
        #
        # Only the page itself is redirected. 0.0.0.0 and localhost are
        # different origins, so bouncing a module or a stylesheet across would
        # fail CORS and break the very load this is meant to protect; once the
        # document lands on localhost, its subresources follow it there.
        # Brave strips the Sec-Fetch-* headers, so the document is identified
        # by what it asks for: only a navigation accepts text/html, while
        # modules and stylesheets ask for */* or text/css.
        host = self.headers.get('Host', '').split(':')[0]
        navigating = ('text/html' in self.headers.get('Accept', '')
                      or self.headers.get('Sec-Fetch-Dest') == 'document')
        if host == '0.0.0.0' and navigating:
            self.send_response(302)  # temporary: never cache a dev redirect
            self.send_header('Location', f'http://localhost:{PORT}{self.path}')
            self.end_headers()
            return None
        return super().send_head()


if __name__ == '__main__':
    handler = functools.partial(Handler, directory=ROOT)
    with http.server.ThreadingHTTPServer(('127.0.0.1', PORT), handler) as httpd:
        print(f'img-taggr → http://localhost:{PORT}   (Ctrl-C to stop)')
        httpd.serve_forever()
