import test from "node:test";
import assert from "node:assert/strict";
import { CHECK_INTERVAL_MS, RegistryChecker, due, packageUrl, registryUrl, type Fetch, type RegistrySnapshot } from "../server/update-registry";

const H = 60 * 60_000;
function fake(responses: { status: number; etag?: string; body?: unknown }[]) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetch: Fetch = async (url, init) => {
    calls.push({ url, headers: init.headers });
    const r = responses.shift();
    if (!r) throw new Error("offline");
    return { status: r.status, headers: { get: (n: string) => n === "etag" ? r.etag ?? null : null }, json: async () => r.body };
  };
  return { fetch, calls };
}
function checker(f: ReturnType<typeof fake>, clock: { t: number }) {
  let stored: RegistrySnapshot | null = null;
  const c = new RegistryChecker({ packageName: "paseo-follow-up", fetch: f.fetch, now: () => clock.t, registry: "https://registry.example/", load: async () => stored, save: async s => { stored = s; } });
  return c;
}
const body = (beta: string) => ({ "dist-tags": { latest: "1.0.1", beta }, versions: { "1.0.1": {}, [beta]: {} } });

test("registry: abbreviated metadata, then If-None-Match with the stored ETag; a 304 keeps the tags", async () => {
  const f = fake([{ status: 200, etag: '"v1"', body: body("1.4.0-beta.13") }, { status: 304 }]);
  const clock = { t: 0 }; const c = checker(f, clock);
  const first = await c.check("scheduled");
  assert.equal(f.calls[0]!.url, "https://registry.example/paseo-follow-up");
  assert.match(f.calls[0]!.headers.accept!, /application\/vnd\.npm\.install-v1\+json/);
  assert.equal(f.calls[0]!.headers["if-none-match"], undefined);
  assert.deepEqual(first.tags, { latest: "1.0.1", beta: "1.4.0-beta.13" });
  clock.t = CHECK_INTERVAL_MS;
  const second = await c.check("scheduled");
  assert.equal(f.calls[1]!.headers["if-none-match"], '"v1"');
  assert.deepEqual(second.tags, first.tags);
  assert.equal(second.okAt, CHECK_INTERVAL_MS);
});

test("registry: at most one scheduled request per six hours; Settings and Check now at most once a minute", async () => {
  const f = fake(Array.from({ length: 10 }, () => ({ status: 304 })));
  f.calls.length = 0;
  const clock = { t: 0 }; const c = checker(f, clock);
  await c.check("scheduled");
  for (const t of [1, H, 3 * H, 6 * H - 1]) { clock.t = t; await c.check("scheduled"); }
  assert.equal(c.requests, 1, "nothing until six hours have passed");
  clock.t = 6 * H; await c.check("scheduled");
  assert.equal(c.requests, 2);
  clock.t += 30_000; await c.check("settings");
  assert.equal(c.requests, 2, "opening Settings right after a check reuses it");
  clock.t += 30_000; await c.check("manual");
  assert.equal(c.requests, 3, "Check now always asks");
  clock.t += 1_000; await c.check("manual");
  assert.equal(c.requests, 3, "a double press is one request");
  clock.t += 5_000; await c.check("manual");
  assert.equal(c.requests, 4);
  // A day of idle ticks every 15 s costs four requests.
  const start = c.requests;
  for (let i = 0; i < (24 * H) / 15_000; i++) { clock.t += 15_000; await c.check("scheduled"); }
  assert.equal(c.requests - start, 4);
});

test("registry: concurrent checks share one request; failures are recorded and still wait for the next window", async () => {
  const f = fake([]);
  const clock = { t: 0 }; const c = checker(f, clock);
  const [a, b] = await Promise.all([c.check("manual"), c.check("settings")]);
  assert.equal(c.requests, 1);
  assert.equal(a.error, "Couldn't reach the registry.");
  assert.equal(b, a);
  clock.t = H; await c.check("scheduled");
  assert.equal(c.requests, 1, "a failed check doesn't turn into polling");
});

test("registry: 404 and 5xx keep the last known tags", async () => {
  const f = fake([{ status: 200, etag: "e", body: body("1.4.0-beta.13") }, { status: 503 }]);
  const clock = { t: 0 }; const c = checker(f, clock);
  await c.check("manual"); clock.t = 2 * 60_000;
  const s = await c.check("manual");
  assert.equal(s.error, "The registry answered 503.");
  assert.equal(s.tags.beta, "1.4.0-beta.13");
});

test("registry: due() and the registry URL", () => {
  assert.ok(due({ checkedAt: null }, 0, "scheduled"));
  assert.ok(due({ checkedAt: 10_000 }, 0, "scheduled"), "clock moved backwards");
  assert.equal(registryUrl({}), "https://registry.npmjs.org/");
  assert.equal(registryUrl({ npm_config_registry: "http://127.0.0.1:4873" }), "http://127.0.0.1:4873/");
  assert.equal(packageUrl("https://r/", "@scope/pkg"), "https://r/@scope%2Fpkg");
});
