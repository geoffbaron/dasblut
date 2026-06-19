// DasBlut multiplayer + static server.
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
app.use(express.static(DIST));
// SPA fallback: any non-asset route serves index.html.
app.get("*", (_req, res) => res.sendFile(path.join(DIST, "index.html")));

const server = app.listen(PORT, () => console.log(`DasBlut server on :${PORT}`));

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
