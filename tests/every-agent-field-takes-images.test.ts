// every-agent-field-takes-images (AGENTS.md invariant 97): every field whose words reach an agent takes pasted images
// through the one component (client/image-attach.tsx). Every TextInput in client/ is classified here: an agent-bound
// field (its file draws it inside ImageField) or a field whose words never reach an agent, with why.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

/** `<file>|<label>`: the field's accessibilityLabel (or placeholder) as written in the source. */
const AGENT_BOUND: Record<string, string> = {
  "new.tsx|\"Task\"": "New's task: the new agent's first message",
  "new.tsx|\"Note for the agent\"": "New's note: added to the first message",
  "questions.tsx|{draft.label}": "QuestionBody's answer or note (every question surface and Catch up)",
  "brief.tsx|{`Your answer${numbered ? ` to question ${i + 1}": "the brief card's own answer",
  "brief.tsx|{`Note for the agent${numbered ? ` on decision ${i + 1}": "the brief card's note",
  "more-context.tsx|\"What do you want to know?\"": "More context's ask (Catch up and every question card)",
  "catch-up.tsx|\"Tell the agent something\"": "Catch up's note to the card's agent",
  "home.tsx|{`Reply to ${agentName}`}": "Home's reply box: an agent's, and the Overseer's pane",
  "home-chrome.tsx|{placeholder}": "QueryField: Home's search asks the Overseer (SearchField wraps it); the sidebar filter reuses it",
};
const NOT_AGENT_BOUND: Record<string, string> = {
  "new.tsx|{label}": "EditLine: a branch or title value in New's preview, not words to the agent",
  "linked.tsx|\"Filter, or paste a link or key\"": "a filter and link field for linked items",
  "compass-settings.tsx|\"How to read this source\"": "a setting (the ranker's standing text, not a message)",
  "compass-settings.tsx|\"Source name\"": "a setting",
  "compass-settings.tsx|{copy.label}": "a setting's search (people, channels, docs, a file path, trackers)",
  "compass-settings.tsx|\"How to read your Compass\"": "a setting (the ranker's standing text, not a message)",
  "compass-settings.tsx|\"Word\"": "a setting",
  "compass-settings.tsx|\"Issue key\"": "a setting",
  "why-it-matters.tsx|\"Search workspaces\"": "a search (picks the workspace a note moves to)",
  "morning-brief-settings.tsx|\"The plan's link\"": "a setting",
  "morning-brief-settings.tsx|\"Time zone\"": "a setting",
  "new-settings.tsx|\"Team key\"": "a setting",
  "new-settings.tsx|{`Base for ${name}`}": "a setting",
  "pr-stats-settings.tsx|\"Another repository, owner/repo\"": "a setting",
  "pr-stats-settings.tsx|{teamKind === \"people\" ? \"Team logins\" : \"GitHub team, org/slug\"}": "a setting",
  "pr-stats-settings.tsx|\"Hidden from stats, logins\"": "a setting",
  "rename.tsx|\"New name\"": "a workspace title",
  "report-issue.tsx|\"Describe it\"": "Report an issue files a redacted report (GitHub or an agent): pasted images would skip its Redactor and screenshot consent (invariant 11)",
  "reviewers.tsx|{repo ? `Add a reviewer for ${repo}": "reviewer names",
  "settings.tsx|\"Search workspaces\"": "a settings filter",
  "shipping.tsx|\"Skill or command for review comments\"": "a setting",
  "spec.tsx|\"Spec link\"": "a link",
  "spec.tsx|\"Spec name, optional\"": "a title",
  "tasks.tsx|\"Delay in days\"": "a number",
  "tasks.tsx|\"Send at, date and time\"": "a date and time",
};

function fields(): { file: string; key: string }[] {
  const out: { file: string; key: string }[] = [];
  for (const file of readdirSync("client").filter(f => f.endsWith(".tsx"))) {
    const s = readFileSync(`client/${file}`, "utf8");
    for (const m of s.matchAll(/<TextInput\s(?!\|)/g)) {
      const chunk = s.slice(m.index!, m.index! + 800);
      const label = chunk.match(/accessibilityLabel=(\{`[^`]*`\}|"[^"]*"|\{[^}]*\})/) ?? chunk.match(/placeholder=("[^"]*"|\{[^}]*\})/);
      out.push({ file, key: `${file}|${label?.[1] ?? "?"}` });
    }
  }
  return out;
}

test("every client TextInput is classified: agent-bound, or why its words never reach an agent", () => {
  const unknown = fields().filter(f => !(f.key in AGENT_BOUND) && !(f.key in NOT_AGENT_BOUND)).map(f => f.key);
  assert.deepEqual(unknown, [], "a new field: if its words reach an agent, draw it inside ImageField and add it to AGENT_BOUND; else add it to NOT_AGENT_BOUND with why");
  const gone = [...Object.keys(AGENT_BOUND), ...Object.keys(NOT_AGENT_BOUND)].filter(k => !fields().some(f => f.key === k));
  assert.deepEqual(gone, [], "a classified field no longer exists: drop it from the list");
});

test("every agent-bound field is drawn inside the one ImageField", () => {
  const byFile = new Map<string, number>();
  for (const f of fields()) if (f.key in AGENT_BOUND) byFile.set(f.file, (byFile.get(f.file) ?? 0) + 1);
  for (const [file, n] of byFile) {
    const s = readFileSync(`client/${file}`, "utf8");
    assert.match(s, /from "\.\/image-attach"/, `${file} draws an agent-bound field without client/image-attach.tsx`);
    const wraps = (s.match(/<ImageField\b/g) ?? []).length + (s.match(/<WithImages\b/g) ?? []).length;
    assert.ok(wraps >= n, `${file}: ${n} agent-bound fields, ${wraps} ImageField wrappers`);
    assert.match(s, /useImageAttachments\(/, `${file} has no image model`);
  }
  // No surface builds its own: only image-attach.tsx reads clipboard or drop files.
  for (const file of readdirSync("client").filter(f => /\.tsx?$/.test(f) && f !== "image-attach.tsx")) {
    const s = readFileSync(`client/${file}`, "utf8");
    assert.doesNotMatch(s, /clipboardData|dataTransfer/, `${file} reads pasted or dropped files itself; use client/image-attach.tsx`);
  }
});

test("every field that takes images shows Add image: below the field, or among its own controls", () => {
  const files = new Set(fields().filter(f => f.key in AGENT_BOUND).map(f => f.file));
  for (const file of files) {
    const s = readFileSync(`client/${file}`, "utf8");
    const inline = (s.match(/<ImageField\b[^>]*attach="inline"/g) ?? []).length;
    const buttons = (s.match(/<AttachImageButton\b/g) ?? []).length;
    assert.ok(buttons >= inline, `${file}: ${inline} ImageField with attach="inline" but ${buttons} AttachImageButton: an inline field draws the button itself`);
  }
  // The one picker: only image-attach.tsx opens a file input.
  for (const file of readdirSync("client").filter(f => /\.tsx?$/.test(f) && f !== "image-attach.tsx")) {
    assert.doesNotMatch(readFileSync(`client/${file}`, "utf8"), /type\s*=\s*"file"|\.type = "file"/, `${file} opens a file picker itself; use AttachImageButton`);
  }
});

test("every agent-bound RPC takes images, and every tool behind one takes image paths", () => {
  const contracts = readFileSync("shared/contracts.ts", "utf8");
  for (const name of ["answerQuestionRpc", "briefActionRpc", "overseerAskRpc", "contextAskRpc"]) {
    const line = contracts.slice(contracts.indexOf(`export const ${name}`)).split(/\nexport const /)[0]!;
    assert.match(line, /images: imageUploadsSchema/, `${name} takes no images`);
  }
  assert.match(readFileSync("shared/dispatch.ts", "utf8"), /images: imageUploadsSchema\.optional\(\)/);
  const mcp = readFileSync("server/mcp.mjs", "utf8");
  for (const tool of ["dispatch", "overseer_ask", "ask_context", "brief_action", "answer_question"]) {
    const tuple = mcp.split("\n").find(l => l.startsWith(`  ["${tool}",`));
    assert.ok(tuple && /\bimages,/.test(tuple), `${tool} takes no images`);
  }
});
