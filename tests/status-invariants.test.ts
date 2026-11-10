import test from "node:test";
import assert from "node:assert/strict";
import { INVARIANTS, violations } from "../shared/status-invariants";
import { askQuestion, needsYouQuestions } from "../server/questions";
import { questionSchema } from "../shared/questions";
import { clock, workspace } from "./fixtures";

// Every status invariant over a grid of workspaces, plus one named fixture per reported bug. Extend the grid's axes
// and add invariants to shared/status-invariants.ts; a fixture stays once its bug is fixed.

const opts = (...labels: string[]) => labels.map((label, i) => ({ letter: String.fromCharCode(65 + i), label }));
const archive = { title: "Archive the 26 dormant workspaces whose PRs are all merged or closed?", question: "Archive them?", options: opts("Show me the list first", "Archive all 26 now", "Don't archive"), recommend: "A" };

test("invariants: ids are unique kebab-case and each says why", () => {
  const ids = INVARIANTS.map(i => i.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const i of INVARIANTS) { assert.match(i.id, /^[a-z]+(-[a-z]+)*$/); assert.ok(i.why.length > 20, i.id); }
});

test("grid: questions asked through every path never leave two open cards for one question", () => {
  const paths = ["ask", "needs_you", "ask-then-needs_you", "needs_you-every-turn", "reworded", "changed-options"] as const;
  for (const path of paths) {
    const w = workspace();
    const d = { question: archive.title, options: archive.options.map(o => ({ label: o.label })), recommend: 0 };
    if (path === "ask") { askQuestion(w, "main-agent", archive, "work-around", clock); askQuestion(w, "main-agent", archive, "work-around", clock); }
    if (path === "needs_you") needsYouQuestions(w, "main-agent", { decisions: [d, d] }, "work-around", clock, null);
    if (path === "ask-then-needs_you") { askQuestion(w, "main-agent", archive, "work-around", clock, { via: "ask" }); needsYouQuestions(w, "main-agent", { decisions: [d] }, "work-around", clock, null); }
    if (path === "needs_you-every-turn") for (let t = 0; t < 5; t++) needsYouQuestions(w, "main-agent", { decisions: [d] }, "work-around", clock + t * 600_000, null);
    if (path === "reworded") { askQuestion(w, "main-agent", archive, "work-around", clock); askQuestion(w, "main-agent", { ...archive, title: "Archive the 26 dormant workspaces (all PRs merged or closed)?" }, "work-around", clock); }
    if (path === "changed-options") { askQuestion(w, "main-agent", archive, "work-around", clock); askQuestion(w, "main-agent", { ...archive, options: opts("Archive 8 clean ones", "Keep all") }, "work-around", clock); }
    assert.deepEqual(violations(w, clock), [], path);
  }
});

test("fixture (2026-11-10, Q18/Q19): the check catches two open versions of one question", () => {
  const q = (id: string, title: string, labels: string[]) => questionSchema.parse({ id, title, question: title, options: opts(...labels), recommend: "A", askedBy: "main-agent", askedAt: new Date(clock).toISOString(), mode: "work-around" });
  const w = workspace({ questions: [q("Q18", "Linked items: build it with the six recommendations?", ["Build it as recommended", "Build it, with changes", "Rethink the design"]), q("Q19", "Build Linked items with the six recommended choices?", ["Build as recommended", "Build with changes", "Rethink the design"])] });
  assert.deepEqual(violations(w, clock), [{ id: "no-duplicate-open-question", detail: "Q19 repeats Q18" }]);
});
