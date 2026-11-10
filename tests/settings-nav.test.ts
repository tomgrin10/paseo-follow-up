import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  SETTINGS_CATEGORIES, followingSummary, hasSavedCategory, isException, projectsOpenByDefault, reposSummary, workspacesOpenByDefault, projectsSummary, readCategory, readOpen, repoSummary, reviewersConfigured, reviewersSummary,
  workspaceRows, workspaceState, workspacesSummary, writeCategory, writeOpen, type KeyValue, type WorkspaceSetting,
} from "../shared/settings-nav";

const store = (): KeyValue & { data: Map<string, string> } => { const data = new Map<string, string>(); return { data, get: k => data.get(k) ?? null, set: (k, v) => { data.set(k, v); } }; };

test("categories: five, General first, in order; every setting the old page had is still rendered (moved, not dropped)", async () => {
  assert.deepEqual(SETTINGS_CATEGORIES.map(c => c.id), ["general", "following", "reviewers", "agents", "display"]);
  const source = (await Promise.all(["client/settings.tsx", "client/display.tsx", "client/reviewers.tsx", "client/agents.tsx"].map(f => readFile(f, "utf8")))).join("\n");
  for (const label of ["Follow every workspace", "Send repairs automatically", "Rest workspaces after", "Follow this workspace", "While a question is open", "Sidebar item", "Workspace header button", "Composer pill",
    "Needs-you inbox", "Flag merged and closed PRs", "Ask agents to state what they need", "Default for all repos", "Add reviewer", "Trust bypass agents"]) assert.ok(source.includes(label), label);
  assert.ok(/<PermissionsSection theme=\{theme\} \/>[\s\S]*<ProjectsFold/.test(source), "Permissions sits in Following, after Defaults");
  assert.ok(!/title="Permissions"[\s\S]{0,400}title="Needs-you inbox"|DisplaySections[\s\S]*<PermissionsSection/.test(source.slice(source.indexOf("export function DisplaySections"))), "and not under Inbox & display");
  for (const field of ["enable_overseer", "enable_ranker"]) assert.ok(source.includes(`field="${field}"`), `${field} switch moved onto its agent card`);
  // Same RPCs as before: UI only.
  for (const rpc of ["followSettingsRpc", "setFollowSettingsRpc", "projectSettingsRpc", "setProjectTrackingRpc", "reviewerSettingsRpc", "saveReviewersRpc", "agentSettingsRpc", "setAgentSettingRpc"]) assert.ok(source.includes(rpc), rpc);
  assert.ok(!/SettingsSelect label="Workspace"/.test(source), "the 100-option workspace select is gone");
});

test("category and open state persist per device; unknown or missing values fall back", () => {
  const s = store();
  assert.equal(readCategory(s), "general", "a device that never picked opens on General"); assert.equal(hasSavedCategory(s), false);
  writeCategory("reviewers", s); assert.equal(readCategory(s), "reviewers"); assert.equal(hasSavedCategory(s), true);
  s.set("follow-up.settings.category", "nonsense"); assert.equal(readCategory(s), "general");
  s.set("follow-up.settings.category", "following"); assert.equal(readCategory(s), "following", "an existing device keeps its stored category");
  assert.equal(readOpen("reviewers", false, s), false); assert.equal(readOpen("reviewers", true, s), true, "no saved choice: the section's default");
  writeOpen("reviewers", true, s); assert.equal(readOpen("reviewers", false, s), true, "the developer's choice wins over the default");
  writeOpen("reviewers", false, s); assert.equal(readOpen("reviewers", true, s), false);
  const broken: KeyValue = { get() { throw new Error("blocked"); }, set() { throw new Error("blocked"); } };
  assert.throws(() => readCategory(broken), "custom stores may throw; deviceStorage itself never does");
});

test("Reviewers summary: collapsed by default once anything is set, with a one-line summary", () => {
  const uri = { login: "uri-h", name: "Uri" }, yuval = { login: "yuval-g", name: "Yuval" }, team = { login: "acme/backend", name: null };
  const empty = { defaults: [], repos: {} };
  assert.equal(reviewersConfigured(empty), false); assert.equal(reviewersSummary(empty), "No lists yet; Add reviewers opens a picker");
  const set = { defaults: [uri, yuval], repos: { "acme/app": [uri], "acme/api": [team], "acme/web": [yuval], "acme/old": [] } };
  assert.equal(reviewersConfigured(set), true);
  assert.equal(reviewersSummary(set), "3 own lists · default: Uri, Yuval");
  assert.equal(reviewersSummary({ defaults: [], repos: { "a/b": [uri] } }), "1 own list");
  assert.equal(reviewersSummary({ defaults: [uri, yuval, team, { login: "dana", name: null }], repos: {} }), "default: Uri, Yuval, acme/backend +1");
  assert.equal(repoSummary([team, uri], [yuval]), "acme/backend, Uri");
  assert.equal(repoSummary([], [uri, yuval, team]), "Uses the default (Uri, Yuval +1)");
  assert.equal(repoSummary([], []), "Nobody; opens the picker");
  assert.equal(reposSummary(["acme/app", "acme/api", "acme/web", "acme/old", "acme/docs"], set), "3 own lists · 2 on the default");
  assert.equal(reposSummary(["a/b"], { repos: {} }), "1 on the default");
});

test("Workspaces: search by title words, exceptions first, capped with the rest counted", () => {
  const w = (title: string, over: Partial<WorkspaceSetting> = {}): WorkspaceSetting => ({ id: title, title, enable_tracking: true, enable_auto_sends: true, optedOut: false, ...over });
  const all = [w("Billing seat sync"), w("Okta SCIM sync", { optedOut: true }), w("Alert routing", { enable_auto_sends: false }), w("Audit export", { enable_auto_sends: false, parked: true }), ...Array.from({ length: 60 }, (_, i) => w(`Synthetic ${String(i).padStart(2, "0")}`))];
  assert.equal(isException(all[3], true), false, "a resting pause isn't an exception");
  const r = workspaceRows(all, true, "", 10);
  assert.deepEqual(r.rows.slice(0, 2).map(x => x.title), ["Alert routing", "Okta SCIM sync"]);
  assert.equal(r.rows.length, 10); assert.equal(r.hidden, 54); assert.equal(r.total, 64); assert.equal(r.exceptions, 2);
  assert.equal(workspaceRows(all, true, "").rows.length, 25, "25 rows by default");
  assert.equal(workspaceRows(all, true, "synthetic").rows.length, 60, "while searching, every match shows"); assert.equal(workspaceRows(all, true, "synthetic").hidden, 0);
  assert.deepEqual(workspaceRows([w("B"), w("A", { dormant: true }), w("C")], true, "").rows.map(x => x.title), ["B", "C", "A"], "resting ones last");
  assert.deepEqual(workspaceRows(all, true, "sync").rows.map(x => x.title), ["Okta SCIM sync", "Billing seat sync"]);
  assert.deepEqual(workspaceRows(all, true, "seat BILLING").rows.map(x => x.title), ["Billing seat sync"]);
  assert.equal(workspacesSummary(all, true), "64 workspaces · 2 exceptions");
  assert.equal(workspacesSummary([w("x")], true), "1 workspace · no exceptions");
  assert.equal(workspaceState(all[1]), "Not followed"); assert.equal(workspaceState(all[3]), "Followed · repairs wait for you · paused while resting");
  assert.equal(projectsSummary([{ enable_default_tracking: true }, { enable_default_tracking: false }]), "1 of 2 followed");
  assert.equal(projectsSummary([{ enable_default_tracking: true }]), "All 1 followed");
  assert.equal(projectsOpenByDefault(6), true); assert.equal(projectsOpenByDefault(7), false);
  assert.equal(workspacesOpenByDefault(0), false); assert.equal(workspacesOpenByDefault(2), true);
  assert.equal(followingSummary({ enable_follow_every: true, enable_auto_sends_default: true, workspaces: all }), "Following every workspace · 2 exceptions · auto-send on");
  assert.equal(followingSummary({ enable_follow_every: false, enable_auto_sends_default: false, workspaces: [] }), "Following chosen projects · no exceptions · auto-send off");
});
