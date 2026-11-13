import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { needsYou } from "../shared/attention";
import { BRIEF_KINDS, briefCardShown, type BriefKind } from "../shared/brief";
import { developerAnswer } from "../server/questions";
import { questionSchema } from "../shared/questions";
import { clock, workspace } from "./fixtures";

/**
 * Invariant a-brief-without-an-ask-never-sits-beside-needs-you (shared/brief.ts briefCardShown). 2026-11-13 render:
 * Home's detail pane drew "Finished · No ask stated. Its last paragraph is right above; nothing is guessed." above
 * "Needs you 1 · Your Q1 answer isn't sent yet".
 */
const flagged = { needs: { since: new Date(clock).toISOString(), reasons: [] } };
const brief = (kind: BriefKind, source: "agent" | "none") => ({ kind, source, state: "open" as const });

test("the reported case: a copied answer waiting in Needs you hides the No ask stated card", () => {
  const w = workspace({ questions: [questionSchema.parse({ id: "Q1", title: "Duplicate contacts?", question: "Update or skip?", askedBy: "main-agent", askedAt: new Date(clock).toISOString(), mode: "stop", options: [{ letter: "A", label: "Update" }] })] });
  developerAnswer(w, "Q1", "A", undefined, "copy", clock);
  const drawn = needsYou(w, clock).length;
  assert.ok(drawn >= 1);
  assert.equal(briefCardShown(brief("done", "none"), flagged, drawn), false);
});

test("a-brief-without-an-ask-never-sits-beside-needs-you holds for every kind and source", () => {
  for (const kind of BRIEF_KINDS) for (const source of ["agent", "none"] as const) {
    const b = brief(kind, source);
    const ask = source !== "none" && kind !== "done";
    for (const drawn of [0, 1, 3]) {
      const shown = briefCardShown(b, flagged, drawn);
      if (drawn >= 1 && !ask) assert.equal(shown, false, `${kind}/${source} beside ${drawn} item(s) says "nothing to do"`);
      if (ask) assert.equal(shown, true, `a real ask (${kind}) always draws`);
      if (drawn === 0) assert.equal(shown, true, `${kind}/${source} alone is the row's only word`);
    }
  }
  assert.equal(briefCardShown({ kind: "decision", source: "agent", state: "answered" }, flagged, 0), false, "only an open brief draws");
});

test("Home's detail pane draws its brief card through briefCardShown", async () => {
  const home = await readFile(join(import.meta.dirname, "..", "client", "home.tsx"), "utf8");
  assert.match(home, /const showBrief = [^\n]*briefCardShown\(b, row, asks\.length\)/);
});
