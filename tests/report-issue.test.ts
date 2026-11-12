import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile as read, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeGithub } from "../scripts/fake-github.mjs";
import { GithubAuthError, httpApi } from "../server/github-api";
import { MAX_DESCRIPTION, Reporter, manualIssueLink, reportInputSchema, reportToolDescription, reportToolProperties, type ReportPluginConfig } from "../server/report-issue";
import { assetPaths } from "../server/report-issue/github";
import { URL_LIMIT, newIssueUrl, slug } from "../server/report-issue/render";

/**
 * Report an issue (server/report-issue/): the agent files a bug, feature request or feedback in the plugin's public
 * repository through the developer's own GitHub auth, only after a dry run and the developer's yes. The GitHub here is
 * scripts/fake-github.mjs with an in-memory issues/contents API behind its `handle` hook.
 */
const REPO = "tomgrin10/paseo-follow-up";
type Req = { method: string; path: string; body?: any; authorization: string | null };

function memoryGithub(o: { login?: string | null; assetsRepo?: "missing" | "public" | "private"; failUpload?: boolean; issues?: { number: number; title: string; state?: string }[] } = {}) {
  const log: Req[] = [];
  const files = new Map<string, string>();
  let assets = o.assetsRepo ?? "missing";
  let next = 200;
  const handle = (r: Req) => {
    log.push(r);
    const [path, query] = r.path.split("?");
    if (path === "user") return o.login === null ? { status: 401, body: { message: "Bad credentials" } } : { status: 200, body: { login: o.login ?? "reporter" } };
    if (path === "search/issues") {
      const q = decodeURIComponent(new URLSearchParams(query).get("q") ?? "").toLowerCase();
      const words = q.split(/\s+/).filter(w => w && !w.startsWith("repo:") && !w.startsWith("is:") && w !== "or");
      const items = (o.issues ?? []).filter(i => words.some(w => i.title.toLowerCase().includes(w))).map(i => ({ number: i.number, title: i.title, state: i.state ?? "open", comments: 1, html_url: `https://github.com/${REPO}/issues/${i.number}` }));
      return { status: 200, body: { items } };
    }
    if (path === "repos/acme/billing") return { status: 200, body: { private: true } };
    if (path === "repos/samlee/blog") return { status: 200, body: { private: false, visibility: "public" } };
    if (path === "repos/reporter/paseo-issue-assets" && r.method === "GET") return assets === "missing" ? { status: 404, body: {} } : { status: 200, body: { private: assets === "private", default_branch: "main" } };
    if (path === "user/repos" && r.method === "POST") { assets = "public"; return { status: 201, body: { private: false, default_branch: "main", full_name: "reporter/paseo-issue-assets" } }; }
    const content = /^repos\/reporter\/paseo-issue-assets\/contents\/(.+)$/.exec(path);
    if (content && r.method === "PUT") {
      if (o.failUpload) return { status: 500, body: { message: "boom" } };
      const p = decodeURIComponent(content[1]);
      if (files.has(p) && !r.body.sha) return { status: 422, body: { message: "sha wasn't supplied" } };
      files.set(p, r.body.content); return { status: 201, body: { content: { path: p, sha: `sha-${p}` } } };
    }
    if (content && r.method === "GET") { const p = decodeURIComponent(content[1]); return files.has(p) ? { status: 200, body: { sha: `sha-${p}` } } : { status: 404, body: {} }; }
    const issue = new RegExp(`^repos/${REPO}/issues/(\\d+)$`).exec(path);
    if (issue && r.method === "GET") { const i = (o.issues ?? []).find(x => x.number === Number(issue[1])); return i ? { status: 200, body: { title: i.title, state: i.state ?? "open", html_url: `https://github.com/${REPO}/issues/${i.number}` } } : { status: 404, body: {} }; }
    if (path === `repos/${REPO}/issues` && r.method === "POST") { const n = next++; return { status: 201, body: { number: n, html_url: `https://github.com/${REPO}/issues/${n}` } }; }
    const comment = new RegExp(`^repos/${REPO}/issues/(\\d+)/comments$`).exec(path);
    if (comment && r.method === "POST") return { status: 201, body: { html_url: `https://github.com/${REPO}/issues/${comment[1]}#issuecomment-1` } };
    return { status: 404, body: { message: `unhandled ${r.method} ${path}` } };
  };
  return { handle, log, files, writes: () => log.filter(r => r.method !== "GET") };
}

async function setup(gh: ReturnType<typeof memoryGithub>, extra: Partial<ReportPluginConfig> & { noAuth?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "report-issue-"));
  const fake = await fakeGithub({ dir, gh: "/bin/false", owners: ["tomgrin10"], handle: gh.handle });
  const api = httpApi({ base: fake.url, tokens: async () => { if (extra.noAuth) throw new GithubAuthError("no token"); return "fixture-token-tomgrin10"; } });
  const shot = join(dir, "toast.png"); await writeFile(shot, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
  const reporter = new Reporter({
    name: "Follow-up", repo: REPO, toolName: "follow_report_issue", assetsFolder: "follow-up",
    github: { request: (m, p, b) => api.send(REPO, m, p, b) },
    diagnostics: async () => ({
      sections: [
        { title: "Versions and install", level: "versions", rows: [["Follow-up", "2.0.1-beta.2 (beta)"], ["Paseo", "daemon 0.15.4"]] },
        { title: "Environment", level: "environment", rows: [["OS", "Linux 7.0.0, x64"]] },
        { title: "Follow-up state", level: "state", rows: [["Tracked workspaces", "14"], ["Data", `${process.env.HOME}/.paseo/plugin-data/follow-up`]] },
      ],
      logs: ["10:42:07 warn  delivery  send failed for acme/billing#12: GitHub HTTP 502", `10:43:00 error token ghp_${"a".repeat(36)} leaked into a log`],
    }),
    redaction: async () => ({ privateRepos: ["acme/billing"], publicRepos: ["samlee/blog"], privateTitles: ["Retry declined cards with backoff"] }),
    now: () => Date.parse("2026-11-12T10:00:00Z"),
    ...extra,
  });
  return { reporter, shot, dir, fake, close: async () => { await fake.close(); await rm(dir, { recursive: true, force: true }); } };
}

const bug = {
  kind: "bug", title: "Send repairs stays queued after GitHub returns 502",
  what_happened: "Send on acme/billing shows \"didn't work\" every time; mail me at sam@acme.io.",
  steps: ["Track a workspace with a failed check", "Click Send"], expected: "The batch goes to the agent.", actual: "Error toast, batch stays queued.",
  findings: "send_repairs gave HTTP 502 on 'Retry declined cards with backoff' twice.",
};

test("report-issue-costs-no-standing-context: the tool's description is one short line and nothing else is always on", () => {
  const d = reportToolDescription("Follow-up");
  assert.ok(d.length <= MAX_DESCRIPTION, `${d.length} chars: ${d}`);
  assert.ok(!d.includes("\n"));
  // The longest plugin name the shared module is meant for still fits.
  assert.ok(reportToolDescription("Smart Session Guard").length <= MAX_DESCRIPTION);
});

test("the JSON schema agents see lists exactly the zod input's fields", () => {
  assert.deepEqual(Object.keys(reportToolProperties).sort(), Object.keys(reportInputSchema.shape).sort());
});

test("call 1 (kind + summary) returns the procedure, reads nothing and writes nothing", async () => {
  const gh = memoryGithub(); const s = await setup(gh);
  try {
    const out = await s.reporter.run("agent-1", { kind: "bug", summary: "Send repairs fails" });
    assert.equal(out.stage, "procedure");
    assert.deepEqual(Object.keys(out.required as object), ["title", "what_happened", "steps", "expected", "actual"]);
    const steps = (out.procedure as string[]).join("\n");
    for (const must of ["Interview", "reproduce", "exactly", "explicit yes", "screenshot_consent", "Never file without that yes", "drag"]) assert.ok(steps.includes(must), must);
    assert.equal(gh.log.length, 0);
  } finally { await s.close(); }
});

test("missing required fields are refused with the list, per kind", async () => {
  const gh = memoryGithub(); const s = await setup(gh);
  try {
    const out = await s.reporter.run("agent-1", { kind: "bug", title: "x", what_happened: "y" });
    assert.equal(out.stage, "missing"); assert.deepEqual(out.missing, ["steps", "expected", "actual"]); assert.equal(out.planId, undefined);
    const f = await s.reporter.run("agent-1", { kind: "feature", title: "Dark pills" });
    assert.deepEqual(f.missing, ["problem", "proposal"]);
    const fb = await s.reporter.run("agent-1", { kind: "feedback", title: "Love it", feedback: "The pill is great" });
    assert.equal(fb.stage, "dry_run");
  } finally { await s.close(); }
});

test("report-issue-files-only-after-confirm: the dry run only reads; confirm without the plan or as another agent files nothing", async () => {
  const gh = memoryGithub({ issues: [{ number: 131, title: "Send repairs fails with HTTP 502 on large stacks" }] }); const s = await setup(gh);
  try {
    const dry = await s.reporter.run("agent-1", bug);
    assert.equal(dry.stage, "dry_run"); assert.equal(typeof dry.planId, "string");
    assert.equal(gh.writes().length, 0, "the dry run wrote to GitHub");
    assert.match((dry.duplicates as string[])[0], /^#131 /);
    assert.deepEqual(dry.labels, ["bug", "via-agent"]);
    await assert.rejects(s.reporter.run("agent-1", { confirm: true }), /planId/);
    await assert.rejects(s.reporter.run("agent-2", { confirm: true, planId: dry.planId }), /another agent/);
    assert.equal(gh.writes().length, 0);
    const filed = await s.reporter.run("agent-1", { confirm: true, planId: dry.planId });
    assert.equal(filed.filed, true); assert.equal(filed.url, `https://github.com/${REPO}/issues/200`);
    const post = gh.writes().find(r => r.path === `repos/${REPO}/issues`)!;
    assert.equal(post.body.title, bug.title); assert.deepEqual(post.body.labels, ["bug", "via-agent"]);
    await assert.rejects(s.reporter.run("agent-1", { confirm: true, planId: dry.planId }), /expired or was already used/);
  } finally { await s.close(); }
});

test("report-issue-never-carries-secrets: what the dry run shows and what GitHub receives are redacted", async () => {
  const gh = memoryGithub(); const s = await setup(gh);
  try {
    const dry = await s.reporter.run("agent-1", bug);
    const filed = await s.reporter.run("agent-1", { confirm: true, planId: dry.planId });
    assert.equal(filed.filed, true);
    const sent = JSON.stringify(gh.writes().map(r => r.body));
    for (const body of [String(dry.body), sent]) {
      for (const leak of ["acme/billing", "sam@acme.io", "Retry declined cards", "ghp_", process.env.HOME!]) assert.ok(!body.includes(leak), `${leak} leaked`);
      assert.ok(body.includes("repo-1"), "the private repo becomes repo-1");
    }
    assert.match(String(dry.redacted), /1 private repository/);
    assert.match(String(dry.body), /<details>\n<summary>Diagnostics/);
  } finally { await s.close(); }
});

test("comment_on adds the details to an existing issue instead", async () => {
  const gh = memoryGithub({ issues: [{ number: 131, title: "Send repairs fails" }] }); const s = await setup(gh);
  try {
    const dry = await s.reporter.run("agent-1", { ...bug, comment_on: 131 });
    assert.match(String(dry.action), /^comment on #131/);
    const out = await s.reporter.run("agent-1", { confirm: true, planId: dry.planId });
    assert.equal(out.action, "commented");
    assert.ok(gh.writes().every(r => r.path !== `repos/${REPO}/issues`));
    await assert.rejects(s.reporter.run("agent-1", { ...bug, comment_on: 999 }), /isn't an issue/);
  } finally { await s.close(); }
});

test("screenshots: no upload without consent, and confirm asks for an explicit choice", async () => {
  const gh = memoryGithub(); const s = await setup(gh);
  try {
    const dry = await s.reporter.run("agent-1", { ...bug, screenshots: [{ path: s.shot, description: "The error toast" }] });
    const shots = dry.screenshots as { consent: string; files: string[]; ask: string };
    assert.equal(shots.consent, "required"); assert.match(shots.ask, /check them/);
    assert.deepEqual(shots.files, [`${s.shot} → follow-up/2026-11-12-send-repairs-stays-queued-after-github-returns-502/1.png`]);
    await assert.rejects(s.reporter.run("agent-1", { confirm: true, planId: dry.planId }), /screenshot_consent/);
    const out = await s.reporter.run("agent-1", { confirm: true, planId: dry.planId, screenshot_consent: false });
    assert.equal(out.filed, true);
    assert.equal(gh.writes().filter(r => r.path.includes("paseo-issue-assets") || r.path === "user/repos").length, 0, "uploaded without consent");
    assert.match(String(out.next), /drag the 1 screenshot/);
    const body = gh.writes().find(r => r.path === `repos/${REPO}/issues`)!.body.body as string;
    assert.match(body, /1\. The error toast\n {3}_\(image to be attached by the reporter\)_/);
  } finally { await s.close(); }
});

test("screenshots: with consent they upload to a new public assets repo with a README and embed raw URLs", async () => {
  const gh = memoryGithub({ assetsRepo: "missing" }); const s = await setup(gh);
  try {
    const dry = await s.reporter.run("agent-1", { ...bug, screenshots: [{ path: s.shot, description: "The error toast" }] });
    const out = await s.reporter.run("agent-1", { confirm: true, planId: dry.planId, screenshot_consent: true });
    const path = "follow-up/2026-11-12-send-repairs-stays-queued-after-github-returns-502/1.png";
    assert.deepEqual([...gh.files.keys()], ["README.md", path]);
    assert.equal(gh.writes().find(r => r.path === "user/repos")!.body.private, false);
    const body = gh.writes().find(r => r.path === `repos/${REPO}/issues`)!.body.body as string;
    assert.ok(body.includes(`![The error toast](https://raw.githubusercontent.com/reporter/paseo-issue-assets/main/${path})`), body);
    assert.equal((out.screenshots as { uploaded: number }).uploaded, 1);
  } finally { await s.close(); }
});

test("screenshots: an upload failure or a private assets repo files text-only and asks for drag-in", async () => {
  for (const o of [{ failUpload: true, assetsRepo: "public" as const }, { assetsRepo: "private" as const }]) {
    const gh = memoryGithub(o); const s = await setup(gh);
    try {
      const dry = await s.reporter.run("agent-1", { ...bug, screenshots: [{ path: s.shot, description: "The error toast" }] });
      const out = await s.reporter.run("agent-1", { confirm: true, planId: dry.planId, screenshot_consent: true });
      assert.equal(out.filed, true);
      assert.match(String((out.screenshots as { reason: string }).reason), /Upload failed/);
      assert.match(String(out.next), /drag/);
    } finally { await s.close(); }
  }
});

test("upload paths are stable for the same report", () => {
  assert.deepEqual(assetPaths("follow-up", "2026-11-12", slug("Send repairs: stays queued (502)!"), [{ ext: "png" }, { ext: "jpg" }]),
    ["follow-up/2026-11-12-send-repairs-stays-queued-502/1.png", "follow-up/2026-11-12-send-repairs-stays-queued-502/2.jpg"]);
  assert.equal(slug("x".repeat(100)).length, 60);
  assert.equal(slug("!!!"), "report");
});

test("without GitHub auth, confirm returns a prefilled new-issue link and the markdown, and posts nothing", async () => {
  const gh = memoryGithub(); const s = await setup(gh, { noAuth: true });
  try {
    const dry = await s.reporter.run("agent-1", bug);
    const out = await s.reporter.run("agent-1", { confirm: true, planId: dry.planId });
    assert.equal(out.filed, false);
    assert.ok(String(out.url).startsWith(`https://github.com/${REPO}/issues/new?`));
    assert.ok(String(out.url).length <= URL_LIMIT);
    assert.match(String(out.markdown), /^# Send repairs stays queued/);
    assert.equal(gh.writes().length, 0);
  } finally { await s.close(); }
});

test("a long body is cut to fit the link, with a note to paste the full text", () => {
  const { url, trimmed } = newIssueUrl(REPO, "t", "word ".repeat(5000), ["bug"]);
  assert.equal(trimmed, true); assert.ok(url.length <= URL_LIMIT);
  assert.ok(decodeURIComponent(url.replace(/\+/g, " ")).includes("Cut to fit the link"));
});

test("a screenshot that isn't an image or doesn't exist is refused at the dry run", async () => {
  const gh = memoryGithub(); const s = await setup(gh);
  try {
    await assert.rejects(s.reporter.run("agent-1", { ...bug, screenshots: [{ path: join(s.dir, "notes.txt"), description: "x" }] }), /not an image/);
    await assert.rejects(s.reporter.run("agent-1", { ...bug, screenshots: [{ path: join(s.dir, "gone.png"), description: "x" }] }), /no such file/);
  } finally { await s.close(); }
});

test("manualIssueLink (no agent to send to) carries the redacted versions block", async () => {
  const link = await manualIssueLink({
    name: "Follow-up", repo: REPO,
    diagnostics: async () => ({ sections: [{ title: "Versions and install", level: "versions", rows: [["Follow-up", "2.0.1-beta.2"], ["Data", `${process.env.HOME}/x`]] }, { title: "Follow-up state", level: "state", rows: [["Tracked", "14"]] }] }),
    redaction: async () => ({ privateRepos: ["acme/billing"] }),
  }, "bug", "acme/billing breaks on Send");
  const body = new URL(link.url).searchParams.get("body")!;
  assert.match(body, /\| Follow-up \| 2\.0\.1-beta\.2 \|/);
  assert.ok(!body.includes("Tracked"), "only the versions block");
  assert.ok(!body.includes("acme/billing") && !body.includes(process.env.HOME!));
  assert.equal(new URL(link.url).searchParams.get("title"), "repo-1 breaks on Send");
});

test("server/report-issue/ imports nothing from the host plugin, so it can move into its own package", async () => {
  const dir = join(import.meta.dirname, "../server/report-issue");
  for (const f of await readdir(dir)) {
    const src = await read(join(dir, f), "utf8");
    for (const m of src.matchAll(/from\s+"([^"]+)"/g)) assert.ok(m[1].startsWith("./") || m[1].startsWith("node:") || m[1] === "zod", `${f} imports ${m[1]}`);
  }
});
