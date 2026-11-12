import test from "node:test";
import assert from "node:assert/strict";
import { Redactor, looksSecret } from "../server/report-issue/redact";

/**
 * Invariant `report-issue-never-carries-secrets`: an issue goes to a public repository, and Follow-up's data is full of
 * private repo names, PR titles, branches, hostnames, emails and paths. Everything an issue carries passes one
 * Redactor; nothing that looks like a token survives it.
 */
const ctx = {
  hostnames: ["dev-vm-7.c.acme-internal.internal"],
  home: "/home/sam_lee_acme_io",
  privateRepos: ["acme/storefront", "acme/billing-core", "samlee/dotfiles"],
  publicRepos: ["tomgrin10/paseo-follow-up", "samlee/blog"],
  privateTitles: ["Retry failed charges with exponential backoff"],
};

test("report-issue-never-carries-secrets: tokens of every common shape become <token>", () => {
  const r = new Redactor(ctx);
  const secrets = [
    "ghp_" + "a".repeat(36), "gho_" + "B1".repeat(18), "github_pat_" + "x".repeat(60), "sk-ant-api03-" + "q".repeat(40), "sk-proj-" + "z".repeat(30),
    "xoxb-1234567890-abcdefghij", "xoxp-12345-67890-abcdefghijkl", "AKIAABCDEFGHIJKLMNOP", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
  ];
  for (const s of secrets) { const out = r.text(`token: before ${s} after`); assert.ok(!out.includes(s), out); assert.ok(out.includes("<token>"), out); }
  assert.equal(r.text("Authorization: bearer abcdefghijklmnopqrstuvwxyz0123"), "Authorization: <token>");
  assert.equal(r.text("curl -H 'authorization: Bearer abcdefghijklmnopqrstuvwxyz0123'"), "curl -H 'authorization: <token>'");
  assert.equal(r.text("GH_TOKEN=supersecretvalue123 gh pr list").includes("supersecretvalue123"), true, "a bare env var isn't a token pattern on its own");
  assert.equal(r.text("password=hunter2hunter2"), "password=<token>");
  assert.equal(r.text("https://sam:pa55word@git.acme.io/x"), "https://<token>@git.acme.io/x");
  assert.equal(r.text("-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----"), "<token>");
  for (const s of secrets) assert.equal(looksSecret(r.text(s)), false);
  assert.equal(looksSecret("ghp_" + "a".repeat(36)), true);
});

test("report-issue-never-carries-secrets: emails, IPs, the hostname and the home directory", () => {
  const r = new Redactor(ctx);
  assert.equal(r.text("mail sam.lee@acme.io now"), "mail <email> now");
  assert.equal(r.text("from 10.128.0.42 and fe80:0:0:0:200:f8ff:fe21:67cf"), "from <ip> and <ip>");
  assert.equal(r.text("listening on 127.0.0.1:6767"), "listening on 127.0.0.1:6767");
  assert.equal(r.text("on dev-vm-7.c.acme-internal.internal and dev-vm-7"), "on <host> and <host>");
  assert.equal(r.text("/home/sam_lee_acme_io/.paseo/plugin-data/follow-up/state.json"), "~/.paseo/plugin-data/follow-up/state.json");
  assert.equal(r.text("/Users/other/x and /home/ci/y"), "~/x and ~/y");
});

test("report-issue-never-carries-secrets: private repos, owners and PR titles become stable placeholders", () => {
  const r = new Redactor(ctx);
  const out = r.text("acme/storefront#412 'Retry failed charges with exponential backoff' broke acme/billing-core; acme/storefront again; cd ~/Projects/storefront; ask acme");
  assert.equal(out, "repo-1#412 'PR-1' broke repo-2; repo-1 again; cd ~/Projects/repo-1; ask org-1");
  // The same report keeps the same numbers across fields.
  assert.equal(r.text("billing-core and storefront"), "repo-2 and repo-1");
  // Public repositories and their owners keep their names, even when the owner also has a private repo.
  assert.equal(r.text("tomgrin10/paseo-follow-up and samlee/blog; samlee/dotfiles"), "tomgrin10/paseo-follow-up and samlee/blog; repo-3");
  assert.deepEqual(Object.fromEntries(r.summary().map(s => [s.kind, s.count])), { repo: 3, org: 1, title: 1 });
});

test("report-issue-never-carries-secrets: the developer can allow a name through", () => {
  const r = new Redactor({ ...ctx, allow: ["acme/storefront", "acme"] });
  assert.equal(r.text("acme/storefront and acme/billing-core"), "acme/storefront and repo-1");
});

test("report-issue-never-carries-secrets: deep() cleans every string in nested data", () => {
  const r = new Redactor(ctx);
  const out = r.deep({ a: ["sam.lee@acme.io", { b: "acme/storefront" }], n: 3, ok: true, none: null });
  assert.deepEqual(out, { a: ["<email>", { b: "repo-1" }], n: 3, ok: true, none: null });
});

test("Redactor never throws on odd input", () => {
  const r = new Redactor({ hostnames: ["", "a", "localhost"], home: "/", privateRepos: ["not a repo", "x/y"], privateTitles: ["short"] });
  for (const v of [null, undefined, "", "(.*)[", "x/y z", "\u0000"]) assert.equal(typeof r.text(v as string), "string");
});
