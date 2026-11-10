import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolveRole, roleSummary, type AgentRole, type CatalogProvider, type RoleConfig, type SavedRole } from "../shared/agent-settings";
import { SETTINGS_ORDER, SETUP_ORDER, isReset, jobRow, jobsHeader, preselect, recommendedEntry, resetEntry } from "../shared/job-rows";

// Setup's Helper agents step and Settings → Agents show the same job rows (Tom, 2026-11-10: "can't the settings page
// look more like the onboarding?"). One component renders both; these tests fail if either surface grows its own.

const source = (f: string) => readFile(f, "utf8");

test("both surfaces render the shared JobRows and nothing row-like of their own", async () => {
  const setup = await source("client/onboarding.tsx");
  const settings = await source("client/agents.tsx");
  const shared = await source("client/job-rows.tsx");
  for (const [name, s] of [["setup", setup], ["settings", settings]] as const) {
    const uses = [...s.matchAll(/<JobRows\b([^>]*)\/>/g)];
    assert.equal(uses.length, 1, `${name} renders JobRows once`);
    // Only placement props may differ: which order, Settings' More, setup's preselect.
    const props = [...uses[0][1].matchAll(/(\w+)=/g)].map(m => m[1]).filter(p => !["theme", "compact", "order", "extra", "preselect"].includes(p));
    assert.deepEqual(props, [], `${name} passes no row content of its own`);
    assert.doesNotMatch(s, /label="Provider"|label="Model"|label="Effort"|"Recommended"|ROLE_NEED|function RoleCard|function JobRow\b/, `${name} builds no pickers, chip or need line itself`);
  }
  assert.match(setup, /order=\{SETUP_ORDER\}/); assert.match(settings, /order=\{SETTINGS_ORDER\}/);
  for (const piece of ['label="Provider"', 'label="Model"', 'label="Effort"', '"Recommended"', "Use recommended", "row.need", "row.notice"]) assert.ok(shared.includes(piece), piece);
});

const p = (id: string, models: { id: string; label?: string; description?: string; isDefault?: boolean; thinking?: string[] }[], available = true): CatalogProvider =>
  ({ id, label: id === "claude" ? "Claude" : id === "codex" ? "Codex" : id, available, reason: available ? null : "Not installed", defaultMode: null, modes: [],
    models: models.map(m => ({ id: m.id, label: m.label ?? m.id, isDefault: !!m.isDefault, ...(m.description ? { description: m.description } : {}), thinking: (m.thinking ?? []).map(t => ({ id: t, label: t[0].toUpperCase() + t.slice(1), isDefault: false })) })) });
const CLAUDE = p("claude", [{ id: "haiku", label: "Haiku" }, { id: "sonnet", label: "Sonnet", isDefault: true }]);
const CODEX = p("codex", [{ id: "gpt-6-luna", label: "GPT-6-Luna", isDefault: true }, { id: "gpt-6-luna-mini", label: "GPT-6-Luna-Mini", thinking: ["minimal", "low"] }, { id: "gpt-6-luna-max", label: "GPT-6-Luna-Max" }]);
const catalog = (...providers: CatalogProvider[]) => ({ providers, error: null, fetchedAt: null });
const view = (role: AgentRole, saved: SavedRole | undefined = undefined) => {
  const r: RoleConfig = resolveRole({ version: 1, roles: saved ? { [role]: saved } : {} }, role);
  return { ...r, summary: roleSummary(r) };
};

test("the same job reads the same on both surfaces: order is the only difference", () => {
  assert.deepEqual([...SETUP_ORDER].sort(), [...SETTINGS_ORDER].sort());
  const cat = catalog(CODEX);
  for (const role of SETUP_ORDER) assert.deepEqual(jobRow(view(role), cat), jobRow(view(role), cat));
});

test("Claude host: every job Recommended, no notices, nothing to fill in, header says all set", () => {
  const cat = catalog(CLAUDE, CODEX);
  const rows = SETUP_ORDER.map(role => jobRow(view(role), cat));
  assert.ok(rows.every(r => r.recommended && !r.notice), JSON.stringify(rows.map(r => [r.role, r.recommended, r.notice])));
  assert.deepEqual(rows.map(r => r.title), ["Summaries", "AI priority", "Overseer", "Recovery"]);
  assert.equal(jobsHeader(rows, cat, false).action, null);
  assert.deepEqual(preselect(SETUP_ORDER.map(r => view(r)), cat), []);
});

test("Codex only: unsaved jobs are filled in quietly; a saved Claude choice is flagged, never changed", () => {
  const cat = catalog(p("claude", [], false), CODEX);
  const fresh = SETUP_ORDER.map(r => view(r));
  assert.deepEqual(preselect(fresh, cat).map(x => [x.role, x.entry.provider, x.entry.model]), [["about", "codex", "gpt-6-luna-mini"], ["ranker", "codex", "gpt-6-luna"], ["overseer", "codex", "gpt-6-luna-max"]]);
  const saved = view("about", { provider: "claude", model: "haiku", dailyCap: 20 });
  assert.deepEqual(preselect([saved], cat), [], "a saved choice is the developer's");
  const row = jobRow(saved, cat);
  assert.equal(row.recommended, false);
  assert.equal(row.notice?.tone, "warning");
  assert.equal(row.notice?.text, "Claude isn't available here, so this won't run. Recommended: Codex · GPT-6-Luna-Mini · Minimal.");
  assert.equal(jobsHeader([row], cat, false).text, "1 job differs from the recommendation.");
  assert.equal(jobsHeader([row], cat, false).action, null, "one job: the row's own Use recommended, no second button in the header");
  const other = jobRow(view("ranker", { provider: "claude" }), cat);
  assert.deepEqual([jobsHeader([row, other], cat, false).text, jobsHeader([row, other], cat, false).action], ["2 jobs differ from the recommendation.", "use"]);
});

test("Use recommended changes provider, model and effort only; limits stay; the Overseer's mode follows a new provider", () => {
  const cat = catalog(p("claude", [], false), CODEX);
  const about = view("about", { provider: "claude", model: "haiku", dailyCap: 20 });
  assert.deepEqual(recommendedEntry(about, jobRow(about, cat).rec!), { dailyCap: 20, maxPromptChars: 40_000, provider: "codex", model: "gpt-6-luna-mini", thinking: "minimal" });
  const ranker = view("ranker", { provider: "claude", cadenceMinutes: 120 });
  assert.equal(recommendedEntry(ranker, jobRow(ranker, cat).rec!).cadenceMinutes, 120);
  const overseer = view("overseer");
  assert.equal(recommendedEntry(overseer, jobRow(overseer, cat).rec!).mode, "full-access");
});

test("header: loading, a catalog error and no provider each say so; a fallback pick carries its hint", () => {
  assert.equal(jobsHeader([], null, true).text, "Reading your providers…");
  assert.equal(jobsHeader([], { providers: [], error: "Paseo isn't connected yet", fetchedAt: null }, false).action, "retry");
  const none = catalog(p("claude", [], false));
  assert.equal(jobsHeader(SETUP_ORDER.map(r => jobRow(view(r), none)), none, false).action, "check");
  const pi = catalog(p("pi", [{ id: "pi-1", isDefault: true }]));
  const overseer = view("overseer", { provider: "pi" });
  const row = jobRow(overseer, pi);
  assert.equal(row.recommended, true); assert.equal(row.hint, "None of its models says which is strongest, so this is its default.");
});

test("no label says Opus for a provider other than Claude; a default model is named when the catalog knows it", () => {
  const pi = catalog(p("pi", [{ id: "pi-1", label: "Pi One", isDefault: true }]));
  for (const role of SETUP_ORDER) {
    const row = jobRow(view(role, { provider: "pi", model: null }), pi);
    assert.doesNotMatch(row.pick, /Opus/, `${role} pick`);
    assert.doesNotMatch(row.recPick ?? "", /Opus/, `${role} recommendation`);
  }
  const fresh = jobRow(view("overseer"), catalog(p("claude", [], false), pi.providers[0]));
  assert.equal(fresh.recPick, "pi · Default (Pi One)");
  assert.equal(jobRow(view("overseer"), catalog(CLAUDE)).pick, "Claude · Newest Opus");
});

test("Reset to defaults never leaves a job that won't run: without Claude it resets to the recommendation, limits back to default", () => {
  assert.deepEqual(resetEntry("about", catalog(CLAUDE, CODEX)), { entry: null, label: null }, "Claude here: the declared defaults");
  const noClaude = catalog(p("claude", [], false), CODEX);
  const about = resetEntry("about", noClaude);
  assert.deepEqual(about.entry, { provider: "codex", model: "gpt-6-luna-mini", thinking: "minimal" });
  assert.equal(about.label, "Codex · GPT-6-Luna-Mini · Minimal");
  assert.equal(resetEntry("overseer", noClaude).entry?.mode, "full-access", "the Overseer gets Codex's no-prompt mode");
  assert.deepEqual(resetEntry("recovery", noClaude), { entry: null, label: null }, "recovery copies the main agent, so its default always runs");
  assert.equal(isReset(view("about", about.entry!), noClaude), true, "after the reset there's nothing left to reset");
  assert.equal(isReset(view("about", { ...about.entry!, dailyCap: 20 }), noClaude), false, "a changed limit still resets");
  assert.equal(isReset(view("about"), catalog(CLAUDE)), true);
});
