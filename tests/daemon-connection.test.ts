import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { sharedDaemon, SHARED_CLIENT_IDLE_MS, SHARED_CLIENT_MARGIN_MS } from "../server/daemon";
import { TICK_MS } from "../shared/poll";

// Invariant a-running-worker-holds-one-daemon-connection. 2026-11-13 live (2.0.1-beta.4): the worker said hello to the
// daemon 39 times in 12 min. The shared connection closed after 5 s unused and was replaced after 60 s, but the engine
// ticks every TICK_MS (15 s), so every tick opened a fresh WebSocket with its own handshake, status and buffers.

test("a-running-worker-holds-one-daemon-connection: the idle bound is the engine's tick plus a named margin (drift check)", async () => {
  assert.equal(SHARED_CLIENT_IDLE_MS, TICK_MS + SHARED_CLIENT_MARGIN_MS);
  assert.ok(SHARED_CLIENT_MARGIN_MS > 0, "a slow tick still finds the connection open");
  const worker = await readFile("index.server.ts", "utf8");
  assert.match(worker, /setTimeout\(\(\) => void loop\(\), TICK_MS\)/, "the engine's loop is paced by the same TICK_MS");
});

test("a-running-worker-holds-one-daemon-connection: 10 ticks open exactly one WebSocket", async () => {
  let opened = 0, closed = 0, now = 0;
  const connect = sharedDaemon(async () => { opened++; return { close: async () => { closed++; } } as never; }, { now: () => now });
  for (let tick = 0; tick < 10; tick++) {
    // A tick asks several things of the daemon, one after another.
    for (let call = 0; call < 5; call++) await connect(async () => { now += 50; return null; });
    now += TICK_MS - 250;
    await connect.idle();
  }
  assert.equal(opened, 1, `10 ticks opened ${opened} connections`);
  assert.equal(closed, 0, "and never closed it between ticks");
  now += SHARED_CLIENT_IDLE_MS;
  await connect.idle();
  assert.equal(closed, 1, "once the ticks stop for longer than the idle bound, it closes");
});

test("a-worker-builds-one-daemon-client: every worker daemon call shares the one connection; only openDaemon builds a client", async () => {
  // 2026-11-13 live copy under live load: withDaemon built a DaemonClient per call (turn-end and inbox reads, usage,
  // permission events), 41 WebSockets a minute, while RSS climbed in native memory with a flat JS heap.
  const daemon = await readFile("server/daemon.ts", "utf8");
  assert.equal(daemon.match(/new module\.DaemonClient\(/g)?.length, 1, "server/daemon.ts builds a DaemonClient in one place");
  assert.match(daemon, /async function openDaemon\(\)[^]*?new module\.DaemonClient\(/, "and it is openDaemon, the shared connection's opener");
  assert.match(daemon, /export function withDaemon<T>[^{]*\{\s*return sharedConnect\(work\);/, "withDaemon is the shared connection");
  const { readdir } = await import("node:fs/promises");
  // The worker's own code. The .mjs files (the stdio bridge, the hook, the update watchdog) and their generated
  // server/*-source.ts copies run in other processes.
  const files = ["index.server.ts", ...(await readdir("server")).filter(f => f.endsWith(".ts") && f !== "daemon.ts" && !f.endsWith("-source.ts")).map(f => `server/${f}`)];
  for (const f of files) assert.doesNotMatch(await readFile(f, "utf8"), /new [\w.]*DaemonClient\(/, `${f} builds its own DaemonClient`);
});
