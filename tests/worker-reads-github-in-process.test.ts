import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pr } from "./fixtures";

// Invariant worker-reads-github-in-process. 2026-11-11 (#116) moved PR polling off gh; the rc.3 live check (2026-11-12)
// still saw ~50 `gh api …/compare/…` spawns after a start: Deployments.contains() was a read path #116 didn't cover,
// and Summary's PR read, reviewer suggestions and the ranker's review search spawned gh too. Every worker read path
// runs here with its default wiring (no injected runner), a logging gh and gcloud first on PATH and a fake GitHub
// API: reads must reach the API and never the gh on PATH. Token lookups (`gh auth token`/`status` through
// FOLLOW_UP_GH_BIN) are allowed, once per owner or account. Writes (merge, retarget, reviewers) stay on gh.
test("worker-reads-github-in-process: no read path spawns gh; tokens resolve once per owner or account", async t => {
  const dir = await mkdtemp(join(tmpdir(), "follow-reads-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const log = join(dir, "spawns.log"); await writeFile(log, "");
  const shim = (name: string, body: string) => `#!/usr/bin/env node\nrequire("fs").appendFileSync(${JSON.stringify(log)}, ${JSON.stringify(name)} + " " + process.argv.slice(2).join(" ") + "\\n");\nconst a = process.argv.slice(2);\n${body}\n`;
  const services = ["backend", "etl", "interpretation", "public-api", "web"].map(role => ({ metadata: { name: `acme-service-app-${role}-x`, labels: { "cloud.googleapis.com/location": "us-central1" } }, status: { conditions: [{ type: "Ready", status: "True" }], traffic: [{ revisionName: `${role}-r1`, percent: 100 }] } }));
  const revision = { spec: { containers: [{ name: "app", image: `us-central1-docker.pkg.dev/acme-prod/acme-docker/prod-app-backend@sha256:${"1".repeat(64)}` }] }, status: { conditions: [{ type: "Ready", status: "True" }] } };
  await writeFile(join(dir, "gh"), shim("gh", `console.log(a[1] === "graphql" ? "{}" : "[]");`));
  await writeFile(join(dir, "gcloud"), shim("gcloud", `console.log(a[0] === "auth" ? "registry-token" : a[1] === "services" ? ${JSON.stringify(JSON.stringify(services))} : ${JSON.stringify(JSON.stringify(revision))});`));
  await writeFile(join(dir, "gh-auth"), shim("gh-auth", `if (a[1] === "status") console.error("Logged in to github.com account personal\\nLogged in to github.com account work"); else console.log("token-" + (a[a.indexOf("--user") + 1] || "active"));`));
  await writeFile(join(dir, "account-map"), "* personal\n");
  for (const f of ["gh", "gcloud", "gh-auth"]) await chmod(join(dir, f), 0o700);

  const reads: string[] = [];
  const server = createServer(async (req, res) => {
    let body = ""; for await (const c of req) body += c;
    reads.push(`${req.method} ${req.url} ${req.headers.authorization}`);
    const url = req.url ?? "";
    const reply = url === "/graphql" ? { data: { rateLimit: { cost: 1, remaining: 4999, resetAt: "2026-01-01T11:00:00Z" }, repository: { defaultBranchRef: { name: "main" }, p0: null } } }
      : url.includes("/compare/") ? { status: "ahead" }
      : /\/pulls\/\d+$/.test(url) ? { title: "Fix it", state: "closed", merged_at: "2026-01-01T09:00:00Z", body: "Body" }
      : url.startsWith("/search/issues") ? { items: [] } : [];
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(reply));
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r)); t.after(() => new Promise<void>(r => server.close(() => r())));
  const saved = { ...process.env }; t.after(() => { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); });
  delete process.env.GH_TOKEN; delete process.env.GITHUB_TOKEN;
  Object.assign(process.env, { PATH: `${dir}:${process.env.PATH}`, FOLLOW_UP_GITHUB_API: `http://127.0.0.1:${(server.address() as { port: number }).port}`, FOLLOW_UP_GH_BIN: join(dir, "gh-auth"), GH_ACCOUNT_MAP: join(dir, "account-map") });

  const { Github } = await import("../server/github");
  const { Deployments } = await import("../server/deployments");
  const { ReviewerSuggestions } = await import("../server/reviewer-config");
  const { liveSources } = await import("../server/about");
  const { liveRankSources } = await import("../server/ranker");
  const { AiJobs } = await import("../server/ai-jobs");
  const registry = (async (url: string) => ({ ok: true, text: async () => JSON.stringify(String(url).includes("/manifests/") ? { config: { digest: `sha256:${"3".repeat(64)}` } } : { config: { Labels: { "org.opencontainers.image.revision": "b".repeat(40) } } }) })) as unknown as typeof fetch;

  // Every read path, default wiring.
  const deployments = new Deployments(undefined, registry);
  const github = new Github(undefined, undefined, deployments);
  const merged = pr({ repo: "acme/acme-poc", key: "acme/acme-poc#1", snapshot: { ...pr().snapshot!, state: "MERGED", mergeCommit: "a".repeat(40) } });
  await github.observe([pr(), merged]);
  await deployments.observe([merged]);
  await new ReviewerSuggestions().suggest("example/app");
  assert.equal((await liveSources(async () => { throw new Error("mcpproxy not needed"); }).pr("example/app", 1))?.state, "MERGED");
  await liveRankSources(new AiJobs(), { run: async () => { throw new Error("mcpproxy not needed"); }, slackUser: null }).github();

  const spawns = (await readFile(log, "utf8")).trim().split("\n").filter(Boolean);
  assert.deepEqual(spawns.filter(s => s.startsWith("gh ")), [], "a read path spawned the gh on PATH");
  assert.ok(reads.some(r => r.includes("/compare/")), "the deployment ancestry read reached the API");
  assert.ok(reads.some(r => /\/pulls\/1 /.test(r)), "Summary's PR read reached the API");
  assert.ok(reads.some(r => r.includes("/collaborators")), "reviewer suggestions reached the API");
  assert.equal(reads.filter(r => r.startsWith("GET /search/issues")).length, 2, "one review search per logged-in account");
  const auth = spawns.filter(s => s.startsWith("gh-auth "));
  // Two owners (example, acme) and two accounts (personal, work), each keyed once, plus one account list.
  assert.equal(auth.filter(s => s.includes("auth status")).length, 1, "the account list is read once");
  assert.ok(auth.filter(s => s.includes("auth token")).length <= 4, `one token lookup per owner or account: ${auth.join(" | ")}`);
  const before = auth.length;
  await github.observe([pr(), merged]); await new ReviewerSuggestions().suggest("example/web");
  await liveRankSources(new AiJobs(), { run: async () => { throw new Error("mcpproxy not needed"); }, slackUser: null }).github();
  assert.equal((await readFile(log, "utf8")).trim().split("\n").filter(s => s.startsWith("gh-auth ")).length, before, "later reads reuse the cached tokens");
});

test("worker-reads-github-in-process: server/ spawns gh only for writes and token lookups", async () => {
  // A new `"gh"` spawn in server/ has to be a write or be listed here with its reason.
  const allowed: Record<string, RegExp> = {
    "github-api.ts": /auth", "token"|"auth", "status"/, // token and account lookups, cached
    "github.ts": /exec\("gh", args/, // the gh runner behind writes (merge, retarget, reviewers) and cliApi tests
    "pr-actions.ts": /./, // writes
  };
  const offenders: string[] = [];
  for (const name of (await readdir("server")).filter(n => /\.(ts|mjs)$/.test(n))) {
    const text = await readFile(join("server", name), "utf8");
    for (const line of text.split("\n")) if (/\(\s*"gh"\s*,/.test(line) && !(allowed[name]?.test(line))) offenders.push(`${name}: ${line.trim().slice(0, 120)}`);
  }
  // index.server.ts: the setup flow's readiness check runs `gh api user` on demand: it checks gh itself, which writes need.
  const index = await readFile("index.server.ts", "utf8");
  for (const line of index.split("\n")) if (/\(\s*"gh"\s*,/.test(line) && !/"api", "user"/.test(line)) offenders.push(`index.server.ts: ${line.trim().slice(0, 120)}`);
  assert.deepEqual(offenders, []);
});
