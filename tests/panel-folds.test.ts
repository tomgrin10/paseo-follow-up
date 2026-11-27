// panel-sections-fold: every section of the workspace panel folds through the one shared fold (client/fold.tsx),
// remembered per device and per section, never per workspace. 2026-11-27, the developer: "Make sure all panels on the
// right sidebar are collapsable, like the agent's tasks one, also the needs you panel."
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { PANEL_FOLDS, collapseKey, readOpen, writeOpen, type KeyValue } from "../shared/settings-nav";

const root = join(import.meta.dirname, "..");
const source = (f: string) => readFile(join(root, f), "utf8");

/** Every element WorkspaceView lays out, by its local name: the section it is and where its fold lives. */
const SECTIONS: Record<string, { fold: keyof typeof PANEL_FOLDS; file: string; mark: RegExp } | { exempt: string }> = {
  needs: { fold: "needs", file: "client/needs-you.tsx", mark: /fold=\{fold \? \{ id: "needs"/ },
  questions: { fold: "questions", file: "client/your-questions.tsx", mark: /useFold\(fold \? PANEL_FOLDS\.questions/ },
  messages: { fold: "messages", file: "client/messages.tsx", mark: /fold=\{\{ id: "messages"/ },
  stacks: { fold: "prs", file: "client/stacks.tsx", mark: /fold=\{\{ id: "prs"/ },
  tasks: { fold: "tasks", file: "client/tasks.tsx", mark: /fold=\{\{ id: "tasks"/ },
  log: { fold: "activity", file: "client/questions.tsx", mark: /fold=\{\{ id: "activity"/ },
  extras: { fold: "workspace", file: "client/panel.tsx", mark: /fold=\{\{ id: "workspace"/ },
  agents: { exempt: "each agent's one line (invariant the-line-takes-its-first-source): a status line, not a section with a body" },
  shipped: { exempt: "the Shipped notice once the work is done: one moment, not a list to fold" },
  history: { exempt: "itself a fold, once shipped: it brings back the Pull requests and tasks sections, which fold on their own" },
};

test("panel-sections-fold: every element the panel lays out is a folded section or exempt with a reason", async () => {
  const panel = await source("client/panel.tsx");
  const view = panel.slice(panel.indexOf("export function WorkspaceView"));
  const layout = view.slice(view.indexOf("{header}"), view.indexOf("</ScrollView>"));
  const names = [...new Set([...layout.matchAll(/\{(\w+)\}/g)].map(m => m[1]).filter(n => n !== "header"))];
  assert.ok(names.length >= 8, `the layout lines were found (${names.join(", ")})`);
  for (const name of names) assert.ok(SECTIONS[name], `${name} is drawn in the panel: give it a fold (client/fold.tsx PANEL_FOLDS) or an exemption with a reason here`);
  for (const [name, s] of Object.entries(SECTIONS)) {
    assert.ok(names.includes(name), `${name} is still in the layout (or drop it here)`);
    if ("exempt" in s) continue;
    assert.match(await source(s.file), s.mark, `${name} folds through the shared fold as "${s.fold}"`);
  }
  // The panel turns the fold on for the components Home's detail pane also draws (there they stay open).
  assert.match(view, /<NeedsYouBlock [^\n]*\bfold \/>;/);
  assert.match(view, /<YourQuestionsCard [^\n]*\bfold \/>;/);
  assert.deepEqual(Object.keys(PANEL_FOLDS).sort(), Object.values(SECTIONS).flatMap(s => "fold" in s ? [s.fold] : []).sort(), "every fold id has its section");
});

test("panel-sections-fold: every Card in the client is a folded section or an error or empty state", async () => {
  const notSections = new Set(["Can't reach Follow-up", "Nothing to show here"]);
  for (const file of (await readdir(join(root, "client"))).filter(f => f.endsWith(".tsx"))) {
    const src = await source(`client/${file}`);
    for (const m of src.matchAll(/<Card\s[^]*?>/g)) {
      const title = /title=(?:"([^"]*)"|\{)/.exec(m[0])?.[1];
      if (title && notSections.has(title)) continue;
      assert.match(m[0], /\bfold=\{/, `client/${file}: a new panel card folds (Card's fold prop), ${m[0].slice(0, 120)}`);
    }
  }
});

test("panel-sections-fold: one fold: only client/fold.tsx reads or writes fold state, and it is a button with its state", async () => {
  for (const dir of ["client", "shared"]) for (const file of (await readdir(join(root, dir))).filter(f => /\.tsx?$/.test(f))) {
    if (`${dir}/${file}` === "client/fold.tsx" || `${dir}/${file}` === "shared/settings-nav.ts") continue;
    assert.doesNotMatch(await source(`${dir}/${file}`), /\breadOpen\(|\bwriteOpen\(/, `${dir}/${file} goes through useFold`);
  }
  const fold = await source("client/fold.tsx");
  assert.match(fold, /accessibilityRole="button" accessibilityState=\{\{ expanded: open \}\} aria-expanded=\{open\}/, "a button with expanded state");
  const kit = await source("client/kit.tsx");
  assert.match(kit, /\{open && children\}/, "a folded card unmounts its body");
  const settings = await source("client/settings-shell.tsx");
  assert.match(settings, /useFold\(id, defaultOpen\)/, "settings' Disclosure is the same fold");
});

test("panel-sections-fold: per device and per section, never per workspace; open by default except tasks and extras", () => {
  for (const id of Object.values(PANEL_FOLDS)) assert.match(id, /^panel\.[a-z]+$/, "a constant id: the same choice in every workspace");
  const mem = new Map<string, string>();
  const store: KeyValue = { get: k => mem.get(k) ?? null, set: (k, v) => { mem.set(k, v); } };
  assert.equal(readOpen(PANEL_FOLDS.needs, true, store), true, "open until the developer folds it");
  writeOpen(PANEL_FOLDS.needs, false, store);
  assert.equal(readOpen(PANEL_FOLDS.needs, true, store), false);
  assert.equal(readOpen(PANEL_FOLDS.prs, true, store), true, "one section's choice is its own");
  assert.equal(mem.get(collapseKey(PANEL_FOLDS.needs)), "0");
});
