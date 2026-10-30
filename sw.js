// Greedy Clips phone app: plays videos and thumbnails over the home-Wi-Fi direct link.
// Requests for "d/<path>" are handed to the open app page, which sends them straight to
// the PC over the direct link and streams the answer back. Everything else is untouched.
"use strict";
const CAP = 4 * 1024 * 1024;     // at most this much per video request (the player asks again)

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;
  const scope = new URL(self.registration.scope).pathname;
  if (!url.pathname.startsWith(scope + "d/")) return;
  e.respondWith(viaPage(e, url.pathname.slice(scope.length + 1) + url.search));
});

async function viaPage(e, path) {
  let client = e.clientId ? await self.clients.get(e.clientId) : null;
  if (!client) client = (await self.clients.matchAll({type: "window"}))[0];
  if (!client) return new Response("", {status: 503});
  let range = e.request.headers.get("Range");
  if (range) {                      // never pull a whole 300 MB clip in one go
    const m = /^bytes=(\d+)-(\d*)$/.exec(range.trim());
    if (m) {
      const a = +m[1], b = m[2] === "" ? a + CAP - 1 : Math.min(+m[2], a + CAP - 1);
      range = `bytes=${a}-${b}`;
    }
  }
  const ch = new MessageChannel();
  return new Promise(resolve => {
    let ctrl = null, started = false;
    const body = new ReadableStream({
      start(c) { ctrl = c; },
      cancel() { ch.port1.postMessage("cancel"); },     // the player stopped reading
    });
    ch.port1.onmessage = ev => {
      const m = ev.data;
      if (m.type === "head") {
        started = true;
        const empty = m.status === 204 || m.status === 304 || e.request.method === "HEAD";
        resolve(new Response(empty ? null : body, {status: m.status, headers: m.headers}));
      } else if (m.type === "data") {
        try { ctrl.enqueue(new Uint8Array(m.chunk)); } catch (_) {}
      } else if (m.type === "end") {
        try { ctrl.close(); } catch (_) {}
      } else if (m.type === "fail") {
        if (!started) resolve(new Response("", {status: 503}));
        else try { ctrl.error(new Error("direct link lost")); } catch (_) {}
      }
    };
    client.postMessage({type: "direct-fetch", path, range, method: e.request.method}, [ch.port2]);
  });
}
