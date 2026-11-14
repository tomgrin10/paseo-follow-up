import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { detailFailure, openRowCopy } from "../client/live-copies";
import { listEntry, type ListWorkspace } from "../shared/list";
import { stackBar } from "../shared/attention";
import { clock, pr, snapshot, workspace } from "./fixtures";

// 2.0.1 slim list (#187): Home's open row and the pill's popover hold two copies of their workspace, the list form
// (live store) and the full read (follow.get). They drew `full ?? listed`, so once the full read existed, a newer list
// change (a merge, a turn) drew the OLDER full copy until the re-read landed: the lag class #177 fixed. They draw the
// newer of the two now; the sheets keep the full read.

const at = (minutes: number) => new Date(clock + minutes * 60_000).toISOString();

test("a list change newer than the full read draws on the open row before the re-read answers", () => {
  const full = workspace({ updatedAt: at(0), prs: [pr()] });
  const merged = workspace({ updatedAt: at(1), prs: [pr({ snapshot: snapshot({ state: "MERGED", mergedAt: at(1) }) })] });
  const listed = listEntry(merged) as ListWorkspace;
  const drawn = openRowCopy<ListWorkspace>(listed, full)!;
  assert.equal(stackBar(drawn).merged, 1, "the row draws the merge the list copy carries");
  assert.equal(drawn, listed);
});

test("the full read draws once it is as new as the list copy, and either copy draws alone", () => {
  const full = workspace({ updatedAt: at(1) });
  const listed = listEntry(workspace({ updatedAt: at(0) })) as ListWorkspace;
  assert.equal(openRowCopy<ListWorkspace>(listed, full), full);
  assert.equal(openRowCopy<ListWorkspace>(listEntry(full) as ListWorkspace, full), full, "a tie keeps the full read");
  assert.equal(openRowCopy<ListWorkspace>(listed, null), listed);
  assert.equal(openRowCopy<ListWorkspace>(undefined, full), full);
  assert.equal(openRowCopy<ListWorkspace>(undefined, null), undefined);
});

test("Home's open row and the pill's popover draw through openRowCopy, never `full ?? list`", () => {
  for (const file of ["client/home.tsx", "client/pill.tsx"]) {
    const source = readFileSync(file, "utf8");
    assert.match(source, /openRowCopy<ListWorkspace>\(/, `${file} draws the newer copy`);
    assert.doesNotMatch(source, /full \?\? (listed|target\.workspace)/, `${file} still prefers an older full read`);
  }
});

// A sheet that waits for the full read (PR sheet, question sheet) did nothing when follow.get failed: "Add reviewers"
// or a Merge that opens the sheet set state the `full &&` gate never drew. The read's failure now closes the request
// with Follow-up's error toast (useDetailGate); while it reads, the sheet still appears when it answers.
test("detailFailure: a failed or empty read is a failure; reading, read, or disabled is not", () => {
  const w = workspace();
  assert.equal(detailFailure({ enabled: true, workspace: null, error: new Error("worker restarting"), reply: undefined }), "worker restarting");
  assert.equal(detailFailure({ enabled: true, workspace: null, error: null, reply: { workspace: null, error: "state unreadable" } }), "state unreadable");
  assert.match(detailFailure({ enabled: true, workspace: null, error: null, reply: { workspace: null, error: null } }) ?? "", /no record/);
  assert.equal(detailFailure({ enabled: true, workspace: null, error: null, reply: undefined }), null, "still reading: the sheet waits");
  assert.equal(detailFailure({ enabled: true, workspace: w, error: null, reply: { workspace: w, error: null } }), null);
  assert.equal(detailFailure({ enabled: false, workspace: null, error: null, reply: undefined }), null);
});

test("every sheet gated on the full read closes with the error toast when the read fails", () => {
  for (const [file, gates] of [["client/home.tsx", 2], ["client/pill.tsx", 2], ["client/brief.tsx", 1]] as const) {
    const source = readFileSync(file, "utf8");
    const found = source.match(/useDetailGate\(/g)?.length ?? 0;
    assert.equal(found, gates, `${file}: one useDetailGate per sheet that waits for follow.get`);
  }
  const hook = readFileSync("client/workspace-data.ts", "utf8");
  assert.match(hook, /toast\.error\(/, "the failure says so with Follow-up's error toast");
});
