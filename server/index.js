// Any War multiplayer + static server.
//
// Serves the built client from dist/ and runs a tiny authoritative-host relay over
// WebSockets. The first connected client becomes the HOST (runs the simulation and
// plays the US side); the next client that wants it becomes GERMAN (commands the
// Axis); everyone else SPECTATES. The server itself holds no game state — it just
// assigns roles and relays:
//   host  -> everyone : "setup" (the map) and "snapshot" (entity state) messages
//   german -> host    : "axisOrder" messages
// If the host disconnects the room resets and the next client is promoted to host.

import express from "express";
import { WebSocketServer } from "ws";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, "..", "dist");
const PORT = parseInt(process.env.PORT ?? "8080", 10);

const app = express();

// --- Overpass (OSM) proxy + cache ---------------------------------------------------
// The client used to hit these public mirrors directly, one at a time, 30s apiece —
// slow and prone to reading as "broken" whenever the first mirror was degraded. Now
// centralized here so we can (a) cache by bounding box, so the fixed coordinates behind
// the historic-battle presets are only ever fetched once per server lifetime, and
// (b) race every mirror in parallel and take whichever answers first, instead of
// waiting out a dead one before trying the next.
const OVERPASS_MIRRORS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];
const OVERPASS_TIMEOUT_MS = 25_000;
const OVERPASS_CACHE_MAX = 300; // small JSON payloads; generous cap, negligible memory
const overpassCache = new Map(); // bbox key -> elements[]

function overpassQuery(bbox) {
  return (
    `[out:json][timeout:25];(` +
    `way["building"](${bbox});` +
    `way["highway"](${bbox});` +
    `way["natural"~"wood|water"](${bbox});` +
    `way["landuse"~"forest|reservoir"](${bbox});` +
    `way["waterway"](${bbox});` +
    `way["barrier"~"hedge|wall|fence"](${bbox});` +
    `);out geom;`
  );
}

async function fetchOneMirror(url, body, signal) {
  const res = await fetch(url, {
    method: "POST",
    // Overpass's usage policy asks bulk/automated callers to self-identify with a
    // descriptive User-Agent; Node's fetch sends none by default, and at least one
    // mirror (overpass-api.de) flatly rejects that with a 406.
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "AnyWarGame/1.0 (+https://dasblut-production.up.railway.app; browser-based tactics game, non-bulk single-battlefield queries)",
    },
    body,
    signal,
  });
  if (!res.ok) throw new Error(`Overpass ${res.status} from ${url}`);
  const json = await res.json();
  return json.elements ?? [];
}

async function fetchOverpassRaced(bbox) {
  const body = "data=" + encodeURIComponent(overpassQuery(bbox));
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), OVERPASS_TIMEOUT_MS);
  try {
    // Promise.any resolves as soon as ANY mirror answers; only rejects (AggregateError)
    // if every one of them fails. A shared AbortController cancels the rest the moment
    // one wins, so we're not left racking up pointless outbound requests.
    return await Promise.any(OVERPASS_MIRRORS.map((url) => fetchOneMirror(url, body, ctrl.signal)));
  } finally {
    clearTimeout(timer);
    ctrl.abort(); // stop any still-in-flight losers
  }
}

app.get("/api/overpass", express.json(), async (req, res) => {
  const s = Number(req.query.s), w = Number(req.query.w), n = Number(req.query.n), e = Number(req.query.e);
  if (![s, w, n, e].every(Number.isFinite)) return res.status(400).json({ error: "bad bbox" });
  // Round to ~1m precision so float noise (map pan/zoom rounding, repeated clicks on
  // the same scenario) still lands on the same cache entry.
  const key = [s, w, n, e].map((v) => v.toFixed(5)).join(",");
  const cached = overpassCache.get(key);
  if (cached) return res.json({ elements: cached });
  try {
    const elements = await fetchOverpassRaced(`${s},${w},${n},${e}`);
    if (overpassCache.size >= OVERPASS_CACHE_MAX) overpassCache.delete(overpassCache.keys().next().value); // FIFO evict
    overpassCache.set(key, elements);
    res.json({ elements });
  } catch (err) {
    console.error("Overpass fetch failed (all mirrors):", err);
    res.status(502).json({ error: "Map service busy — all Overpass mirrors failed" });
  }
});

app.use(express.static(DIST));
// SPA fallback: any non-asset route serves index.html.
app.get("*", (_req, res) => res.sendFile(path.join(DIST, "index.html")));

const server = app.listen(PORT, () => console.log(`Any War server on :${PORT}`));

const wss = new WebSocketServer({ server, path: "/ws" });

let host = null;       // the host socket (runs the sim)
let german = null;     // the Axis commander socket
let lastSetup = null;  // remember the map so late joiners get it immediately
const clients = new Set();

function roleOf(ws) {
  if (ws === host) return "host";
  if (ws === german) return "german";
  return "spectator";
}

function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function broadcastExcept(sender, obj) {
  const msg = JSON.stringify(obj);
  for (const c of clients) if (c !== sender && c.readyState === 1) c.send(msg);
}

function notifyHostPresence() {
  send(host, { t: "germanPresent", value: german != null });
}

wss.on("connection", (ws) => {
  clients.add(ws);

  // Assign a role. First in is host; a later client may claim German if it's free.
  if (!host) host = ws;
  send(ws, { t: "role", role: roleOf(ws), germanPresent: german != null });

  // A fresh non-host client gets the current map right away (if a battle is running).
  if (ws !== host && lastSetup) send(ws, { t: "setup", data: lastSetup });

  ws.on("message", (buf) => {
    let m;
    try { m = JSON.parse(buf.toString()); } catch { return; }

    switch (m.t) {
      case "claimGerman":
        if (!german && ws !== host) {
          german = ws;
          send(ws, { t: "role", role: "german", germanPresent: true });
          notifyHostPresence();
        }
        break;
      case "setup": // host published the map
        if (ws === host) { lastSetup = m.data; broadcastExcept(host, { t: "setup", data: m.data }); }
        break;
      case "snapshot": // host published entity state
        if (ws === host) broadcastExcept(host, { t: "snapshot", data: m.data });
        break;
      case "axisOrder": // German player issued an order — forward to the host
        if (ws === german) send(host, { t: "axisOrder", data: m.data });
        break;
    }
  });

  ws.on("close", () => {
    clients.delete(ws);
    if (ws === german) { german = null; notifyHostPresence(); }
    if (ws === host) {
      // Promote the next client to host; the room restarts from their battle.
      host = null;
      lastSetup = null;
      const next = clients.values().next().value;
      if (next) {
        host = next;
        if (next === german) german = null;
        send(host, { t: "role", role: "host", germanPresent: german != null });
      }
    }
  });
});
