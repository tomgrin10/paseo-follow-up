import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { filterItems, highlightRuns, type ItemField } from "../shared/search";
import { activityFields, matchCount, noMatchLine, prFields, queryFor, questionFields, SECTION_PLACEHOLDER, taskFields } from "../shared/section-search";
import { questionSchema } from "../shared/questions";
import { pr, snapshot } from "./fixtures";

// Section search (the workspace panel's Pull requests, Tasks and Activity): the same matcher as every workspace
// search, as a filter. It never re-ranks; folds are ignored; the query is the panel's view state.

const plain = (text: string): ItemField[] => [{ label: "Title", text, shown: true }];
const titles = ["Stream the PDF to storage", "Retry the S3 upload on timeout", "Add the invoice footer", "Upload size limit", "Uploads dashboard"];

test("filterItems keeps the list's own order: a filter, never a ranking", () => {
  const out = filterItems(titles, plain, "upload")!;
  // A whole-word hit ("Upload size limit") doesn't jump ahead of an earlier mid-list one.
  assert.deepEqual(out.map(r => r.item), ["Retry the S3 upload on timeout", "Upload size limit", "Uploads dashboard"]);
});

test("filterItems is the shared matcher: prefix, typo, mid-word; numbers exact or prefix only", () => {
  assert.deepEqual(filterItems(titles, plain, "uplaod")!.map(r => r.item), ["Retry the S3 upload on timeout", "Upload size limit", "Uploads dashboard"], "one typo from four letters");
  assert.deepEqual(filterItems(titles, plain, "voic")!.map(r => r.item), ["Add the invoice footer"], "inside a word from three letters");
  const prs = ["#188", "#189", "#18", "#1890"].map(n => [{ label: "PR", text: n, shown: true }]);
  assert.deepEqual(filterItems(prs, f => f, "189")!.map(r => r.item[0].text), ["#189", "#1890"], "a number never matches fuzzily");
  // Every token must match.
  assert.deepEqual(filterItems(titles, plain, "upload zebra"), []);
});

test("filterItems: an empty query means not searching", () => {
  assert.equal(filterItems(titles, plain, ""), null);
  assert.equal(filterItems(titles, plain, "  · "), null);
});

test("filterItems highlights matched words in the shown fields", () => {
  const [hit] = filterItems(["Retry the S3 upload on timeout"], plain, "retry upload")!;
  const runs = highlightRuns(hit.item, hit.hit.ranges[0]).filter(r => r.hit).map(r => r.text);
  assert.deepEqual(runs, ["Retry", "upload"]);
  assert.equal(hit.hit.via, null);
});

test("a hit only in a hidden field comes back as line 2: '<Key> · excerpt'", () => {
  const tasks = [
    { title: "Stream the PDF to storage", evidence: "Large invoices failed the upload over 10 MB, so it streams now." },
    { title: "Retry the S3 upload on timeout", evidence: "" },
  ];
  const out = filterItems(tasks, taskFields, "upload")!;
  assert.deepEqual(out.map(r => r.item.title), tasks.map(t => t.title), "both kept, in order");
  assert.equal(out[0].hit.via?.label, "Evidence");
  assert.ok(out[0].hit.via!.ranges.length);
  assert.equal(out[1].hit.via, null, "a title hit needs no line 2");
  // A query covered by the title and the evidence together still shows the hidden part.
  const both = filterItems(tasks, taskFields, "stream invoices")!;
  assert.equal(both[0].hit.via?.label, "Evidence");
});

test("Pull requests search the number, title, branch and check names", () => {
  const one = pr({ number: 188, key: "example/app#188", snapshot: snapshot({ title: "Invoice PDF renderer", headBranch: "invoice-pdf-render", failedChecks: ["lint", "unit-tests"] }) });
  const fields = prFields(one);
  assert.deepEqual(fields.filter(f => f.shown).map(f => f.text), ["Invoice PDF renderer", "#188"]);
  assert.deepEqual(fields.filter(f => !f.shown).map(f => `${f.label}:${f.text}`), ["Branch:invoice-pdf-render", "Check:lint", "Check:unit-tests"]);
  assert.equal(filterItems([one], prFields, "188")!.length, 1);
  assert.equal(filterItems([one], prFields, "lint")![0].hit.via?.label, "Check");
  assert.equal(filterItems([one], prFields, "render")![0].hit.via, null, "the title explains it");
});

test("Activity searches the timeline's text and detail, and the questions' ref, title and status", () => {
  assert.deepEqual(activityFields({ text: "#187 merged", detail: "Add the invoice footer" }).map(f => f.text), ["#187 merged", "Add the invoice footer"]);
  const q = questionSchema.parse({ id: "Q2", title: "Page size for invoices", question: "A4 or Letter?", askedBy: null, askedAt: "2026-11-15T10:00:00.000Z", mode: "stop",
    options: [{ letter: "A", label: "A4" }, { letter: "B", label: "Letter" }], answer: { choice: "A", at: "2026-11-15T10:05:00.000Z", by: "developer", delivery: { state: "sent", to: "agent-a", messageId: null, at: "2026-11-15T10:05:00.000Z" } } });
  const fields = questionFields(q);
  assert.equal(fields[0].text, "Q2 · Page size for invoices");
  assert.match(fields[1].text, /A4/);
  assert.equal(filterItems([q], questionFields, "q2")!.length, 1);
  assert.equal(filterItems([q], questionFields, "a4")!.length, 1);
});

test("the words: placeholders, 'n of N' and the no-match line", () => {
  assert.deepEqual(SECTION_PLACEHOLDER, { prs: "Search pull requests", tasks: "Search tasks", activity: "Search activity" });
  assert.equal(matchCount(2, 12), "2 of 12");
  assert.equal(noMatchLine("tasks", " zebra "), "No tasks match ‘zebra’");
  assert.equal(noMatchLine("prs", "x"), "No pull requests match ‘x’");
  assert.equal(noMatchLine("activity", "x"), "No activity matches ‘x’");
});

test("the query clears when the workspace changes", () => {
  const state = { workspaceId: "ws-a", query: "upload" };
  assert.equal(queryFor(state, "ws-a"), "upload");
  assert.equal(queryFor(state, "ws-b"), null);
  assert.equal(queryFor(null, "ws-a"), null);
});

const src = (f: string) => readFile(new URL(`../client/${f}`, import.meta.url), "utf8");

test("each list section has the search icon and its own placeholder, through the one shared field", async () => {
  // Not Tasks: it is the agent's list, collapsed to one line, a handful of rows when open (tasks-are-the-agent-s).
  assert.doesNotMatch(await src("tasks.tsx"), /useSectionSearch/, "Agent's tasks has no search icon");
  for (const [file, id] of [["stacks.tsx", "prs"], ["questions.tsx", "activity"]] as const) {
    const s = await src(file);
    assert.match(s, new RegExp(`useSectionSearch(<[^>]*>)?\\(w\\.id, "${id}",`), `${file} searches as "${id}"`);
    assert.match(s, /search=\{search\.header\}/, `${file} hands the field to its Card header`);
    assert.match(s, /search\.button/, `${file} always shows the icon`);
  }
  const shared = await src("section-search.tsx");
  assert.match(shared, /<QueryField\b/, "the shared QueryField, not a second field");
  assert.match(shared, /SECTION_PLACEHOLDER\[section\]/);
  assert.match(shared, /filterItems\b/, "the shared matcher");
});

test("folds are ignored while searching", async () => {
  const stacks = await src("stacks.tsx"), log = await src("questions.tsx");
  assert.match(stacks, /\{!hits && settled\.length > 0/, "PRs: no settled-stacks fold while searching");
  assert.match(stacks, /const fold = !hits && !settled && done\.length > 0/, "PRs: no merged fold while searching");
  // Activity pages its hits instead (client/paged-list.tsx): a search is paged, so its Show all fold is gone.
  assert.match(log, /const paged = all \|\| searching;/, "Activity: a search is paged");
  assert.match(log, /!paged\s*\? d\.total > PAGE\.preview && <FoldRow/, "Activity: no 'Show all' while searching");
});

test("no global key and no React Native scroll views: Esc in the field only, Ctrl/Cmd+F stays the browser's", async () => {
  const s = await src("section-search.tsx");
  assert.doesNotMatch(s, /addEventListener\(\s*["']keydown/);
  assert.doesNotMatch(s, /import\s*\{[^}]*\b(ScrollView|FlatList)\b[^}]*\}\s*from\s*"react-native"/);
});

test("invariant 28 covers item lists, and the PARITY note names the agent tools that read these lists", async () => {
  const agents = await readFile(new URL("../AGENTS.md", import.meta.url), "utf8");
  const inv = agents.slice(agents.indexOf("28. **"), agents.indexOf("\n\n", agents.indexOf("28. **")));
  assert.match(inv, /filterItems/);
  assert.match(inv, /keep(s)? (their|its) (own )?order/);
  const { VIEW_PARITY } = await import("../server/agent-parity");
  const note = VIEW_PARITY["section-search"];
  assert.ok(note, "a PARITY note for section search");
  assert.deepEqual([...note.tools].sort(), ["list_prs", "workspace_status"]);
});

test("a narrow row keeps the match on screen: line 2's excerpt leads with a few words, not twenty characters", async () => {
  const { excerpt } = await import("../shared/search");
  const text = "Retries stop after the fourth charge attempt, and the dunning email goes out after it.";
  const at = text.indexOf("dunning");
  const cut = excerpt(text, [[at, at + 7]], 48, 12);
  assert.ok(cut.ranges[0][1] <= 32, `the match ends inside the first 32 characters: ${cut.text}`);
  assert.equal(cut.text.slice(cut.ranges[0][0], cut.ranges[0][1]), "dunning");
});
