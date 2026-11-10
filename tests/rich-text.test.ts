import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { linkify, hasLinks } from "../shared/links";

// ---------- linkify ----------

test("bare http(s) URLs become links and the text round-trips", () => {
  const text = "Published at https://claude.ai/artifact/VjyHQ6jQbRhCTq6qMoXeCX for review";
  const runs = linkify(text);
  assert.equal(runs.map(r => r.text).join(""), text);
  assert.deepEqual(runs.filter(r => r.url).map(r => r.url), ["https://claude.ai/artifact/VjyHQ6jQbRhCTq6qMoXeCX"]);
});

test("sentence punctuation and an unbalanced bracket stay outside the link", () => {
  assert.deepEqual(linkify("See https://example.com/a.").filter(r => r.url).map(r => r.url), ["https://example.com/a"]);
  assert.deepEqual(linkify("(see https://example.com/a)").filter(r => r.url).map(r => r.url), ["https://example.com/a"]);
  assert.deepEqual(linkify("https://en.wikipedia.org/wiki/Foo_(bar), ok").filter(r => r.url).map(r => r.url), ["https://en.wikipedia.org/wiki/Foo_(bar)"]);
  assert.deepEqual(linkify("two: http://a.dev/x, https://b.dev/y?z=1!").filter(r => r.url).map(r => r.url), ["http://a.dev/x", "https://b.dev/y?z=1"]);
});

test("owner/repo#123 links to the PR; paths, URL fragments and plain #123 don't", () => {
  assert.deepEqual(linkify("Fixed in tomgrin10/paseo-follow-up#56.").filter(r => r.url).map(r => r.url), ["https://github.com/tomgrin10/paseo-follow-up/pull/56"]);
  assert.deepEqual(linkify("https://github.com/a/b#12 and src/a/b#3 and #45").filter(r => r.url).map(r => r.url), ["https://github.com/a/b#12"]);
});

test("text without links is one plain run, including empty text", () => {
  assert.deepEqual(linkify("No links here: example.com, ftp://x"), [{ text: "No links here: example.com, ftp://x" }]);
  assert.deepEqual(linkify(""), [{ text: "" }]);
  assert.equal(hasLinks("nope"), false);
  assert.equal(hasLinks("https://x.dev"), true);
});

// ---------- invariant: agent-written text goes through RichText ----------
//
// Root cause of "the artifact link is not a clickable url": every surface put agent-written text straight into a plain
// <Text>, and nothing made a new surface do otherwise. This scan fails when a field that holds text an agent or the
// developer wrote is rendered inside <Text>…</Text> instead of <RichText>. A one-line title inside a pressable row
// uses <RichText plain>, which says so in the code.

/** Fields whose values are written by an agent (or typed by the developer) rather than by Follow-up. */
const AGENT_FIELDS = [
  /\b(?:q|question|featured|item|task|o|obligation)\.title\b/, // question and task titles
  /\.question\b/, /\.background\b/, /\.consequence\b/, /\.words\b/, // questions, options, answers
  /\b(?:o|option|chosen)\.label\b/, // option labels
  /\.ask\b/, /\.context\b/, /\b(?:b|brief)\.mono\b/, // briefs
  /\.evidence\b/, /\.summary\b/, /\.result\b/, // tasks, Done, batches
  /\bfeatured\.detail\b/, /\bitem\.detail\b/, // Needs-you rows (a question's body)
  /\bstep\.text\b/, // the Overseer's replies
  /\b(?:r|l)\.detail\b/, // activity rows: answers, results
];

async function clientFiles(): Promise<string[]> {
  const dir = join(import.meta.dirname, "..", "client");
  return (await readdir(dir)).filter(f => f.endsWith(".tsx")).map(f => join(dir, f));
}

/** Every <Text …>children</Text> whose own children (not nested <Text> props) mention an agent-written field. */
function plainTextViolations(source: string): { line: number; snippet: string }[] {
  const out: { line: number; snippet: string }[] = [];
  const open = /<Text\b(?:[^>{]|\{(?:[^{}]|\{[^{}]*\})*\})*>/g;
  for (const m of source.matchAll(open)) {
    if (m[0].endsWith("/>")) continue;
    const start = m.index! + m[0].length;
    const end = source.indexOf("</Text>", start);
    if (end < 0) continue;
    // Only this element's own children up to its first nested <Text, so a nested RichText-free child is checked on its own.
    const nested = source.indexOf("<Text", start);
    const body = source.slice(start, nested >= 0 && nested < end ? nested : end);
    const expressions = body.match(/\{[\s\S]*?\}/g) ?? [];
    if (expressions.some(e => AGENT_FIELDS.some(f => f.test(e)))) {
      out.push({ line: source.slice(0, m.index).split("\n").length, snippet: body.trim().slice(0, 120) });
    }
  }
  return out;
}

test("the scan catches a plain <Text> around an agent-written field and allows RichText", () => {
  assert.equal(plainTextViolations(`<Text selectable style={[t.body, { fontSize: 15 }]}>{q.question}</Text>`).length, 1);
  assert.equal(plainTextViolations(`<Text style={t.meta}>Task: {task.title}</Text>`).length, 1);
  assert.equal(plainTextViolations(`<Text>{\`\${q.id} · \${q.title}\`}</Text>`).length, 1);
  assert.equal(plainTextViolations(`<RichText selectable style={t.body}>{q.question}</RichText>`).length, 0);
  assert.equal(plainTextViolations(`<Text style={t.meta}>{state.text}</Text>`).length, 0);
});

test("every agent-written field in the client renders through RichText", async () => {
  const found: string[] = [];
  for (const file of await clientFiles()) {
    if (file.endsWith("rich-text.tsx")) continue;
    for (const v of plainTextViolations(await readFile(file, "utf8"))) found.push(`${file.split("/client/")[1]}:${v.line} ${v.snippet}`);
  }
  assert.deepEqual(found, [], `Render these with <RichText> (or <RichText plain> inside a pressable row):\n${found.join("\n")}`);
});
