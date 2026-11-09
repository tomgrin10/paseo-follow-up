// Counts what each client asks an isolated Paseo daemon, for the scale check and harness measurements.
//
// A small proxy in front of the daemon: HTTP (the web app) passes through, and every WebSocket frame a client sends is
// tallied by the clientId from its hello and the request type (`fetch_workspaces_request`, plugin RPC method names).
// The daemon only logs slow requests, so this is the only way to see the whole rate. Never point it at the live daemon.
import { createServer, request as httpRequest } from "node:http";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { WebSocket, WebSocketServer } = require("ws");

/** Request type for one client frame: the session message type, with plugin RPCs split out by method. */
export function requestType(frame) {
  const message = frame?.type === "session" ? frame.message : null;
  if (!message || typeof message.type !== "string") return null;
  if (/plugin.*rpc/i.test(message.type) && typeof message.method === "string") return `plugin_rpc:${message.method}`;
  return message.type;
}

export async function startCounter(targetPort) {
  if (targetPort === 6767) throw new Error("refusing the live daemon port");
  const counts = new Map(); // clientId -> Map<type, n>
  const connections = new Map(); // clientId -> number of sockets opened
  const bytes = new Map(); // clientId -> Map<type, response bytes>
  const addBytes = (clientId, type, n) => { let m = bytes.get(clientId); if (!m) bytes.set(clientId, m = new Map()); m.set(type, (m.get(type) ?? 0) + n); };
  const bump = (clientId, type) => { let m = counts.get(clientId); if (!m) counts.set(clientId, m = new Map()); m.set(type, (m.get(type) ?? 0) + 1); };
  const server = createServer((req, res) => {
    const upstream = httpRequest({ host: "127.0.0.1", port: targetPort, method: req.method, path: req.url, headers: { ...req.headers, host: `127.0.0.1:${targetPort}` } }, up => { res.writeHead(up.statusCode ?? 502, up.headers); up.pipe(res); });
    upstream.on("error", () => { res.writeHead(502); res.end(); });
    req.pipe(upstream);
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, client => {
      const headers = { ...req.headers }; for (const h of ["host", "connection", "upgrade", "sec-websocket-key", "sec-websocket-version", "sec-websocket-extensions"]) delete headers[h];
      const up = new WebSocket(`ws://127.0.0.1:${targetPort}${req.url}`, req.headers["sec-websocket-protocol"]?.split(",").map(s => s.trim()) ?? [], { headers });
      let clientId = "unknown"; const queue = []; const pending = new Map(); // requestId -> type
      client.on("message", (data, binary) => {
        if (!binary) {
          try {
            const frame = JSON.parse(data.toString());
            if (typeof frame?.clientId === "string" && clientId === "unknown") { clientId = frame.clientId; connections.set(clientId, (connections.get(clientId) ?? 0) + 1); }
            const type = requestType(frame); if (type) { bump(clientId, type); const id = frame.message?.requestId; if (typeof id === "string") pending.set(id, type); }
          } catch { /* not JSON: pass through */ }
        }
        if (up.readyState === WebSocket.OPEN) up.send(data, { binary }); else queue.push([data, binary]);
      });
      up.on("open", () => { for (const [d, b] of queue.splice(0)) up.send(d, { binary: b }); });
      up.on("message", (data, binary) => {
        if (!binary && pending.size) {
          const text = data.toString(); const id = /"requestId":"([^"]+)"/.exec(text)?.[1];
          if (id && pending.has(id)) { addBytes(clientId, pending.get(id), Buffer.byteLength(text)); pending.delete(id); }
        }
        if (client.readyState === WebSocket.OPEN) client.send(data, { binary });
      });
      const close = () => { try { client.close(); } catch {} try { up.close(); } catch {} };
      up.on("close", close); up.on("error", close); client.on("close", close); client.on("error", close);
    });
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  return {
    port: server.address().port,
    /** A copy of the counts so far: { clientId: { type: n } }, plus connections opened per client. */
    snapshot: () => ({ requests: Object.fromEntries([...counts].map(([id, m]) => [id, Object.fromEntries(m)])), connections: Object.fromEntries(connections), bytes: Object.fromEntries([...bytes].map(([id, m]) => [id, Object.fromEntries(m)])) }),
    close: () => new Promise(r => { for (const c of wss.clients) c.terminate(); server.close(() => r()); server.closeAllConnections?.(); }),
  };
}

/** Per-minute rate between two snapshots for one client: { total, byType, connections }. */
export function ratePerMinute(before, after, clientId, ms) {
  const a = before.requests[clientId] ?? {}; const b = after.requests[clientId] ?? {};
  const byType = {};
  for (const [type, n] of Object.entries(b)) { const d = n - (a[type] ?? 0); if (d > 0) byType[type] = Math.round(d / (ms / 60_000) * 10) / 10; }
  const total = Math.round(Object.values(byType).reduce((s, n) => s + n, 0) * 10) / 10;
  const connections = Math.round(((after.connections[clientId] ?? 0) - (before.connections[clientId] ?? 0)) / (ms / 60_000) * 10) / 10;
  return { total, byType: Object.fromEntries(Object.entries(byType).sort((x, y) => y[1] - x[1])), connections };
}
