import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cardStore } from "../client/card-store";
import { cardPicks, notedCount } from "../shared/brief";

/**
 * Task 32deeb27, the decision card's note ("A, but…"): one tap still sends; "Add note" opens a field below the options,
 * and with text in it a tap sends the letter with the note. What must hold however the card re-renders.
 */
const source = readFileSync(new URL("../client/brief.tsx", import.meta.url), "utf8");
// kit.tsx imports react-native, so its pure submitKey is evaluated from source (as in tests/keyboard-send.test.ts).
const kit = readFileSync(new URL("../client/kit.tsx", import.meta.url), "utf8");
const body = /export function submitKey\(([\s\S]*?)\): boolean \{([\s\S]*?)\n\}/.exec(kit)!;
const submitKey = new Function(...body[1].replace(/:\s*Pick<[^>]*>/, "").replace(/:\s*\{[^}]*\}/, "").replace(/:\s*boolean/, "").split(",").map(p => p.trim()), body[2]) as (e: object, target: object, mac: boolean) => boolean;
const key = (k: Record<string, unknown>) => ({ key: "Enter", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, repeat: false, isComposing: false, ...k });

test("a re-render, an inbox tick or a remount keeps the note: it lives in a module store, not component state", () => {
  const notes = cardStore(false);
  let calls = 0;
  const off = notes.subscribe(() => { calls++; });
  notes.set("brief:t1", "D1", "keep the BOM off");
  off(); // the card unmounts (a refetch replaced the list) …
  notes.subscribe(() => undefined); // … and mounts again
  assert.equal(notes.get("brief:t1").D1, "keep the BOM off");
  assert.equal(calls, 1);
  assert.equal(notes.get("brief:t1"), notes.get("brief:t1"), "a stable snapshot, so useSyncExternalStore doesn't loop");
  notes.set("brief:t1", "D1", "");
  assert.equal(notes.get("brief:t1").D1, undefined, "clearing the text clears the note");
  // The card reads the notes through that store and never keeps them in useState.
  assert.match(source, /const useNotes = \(briefId: string\) => useSyncExternalStore\(noteStore\.subscribe/);
  assert.doesNotMatch(source, /useState<Record<string, string>>\(\{\}\)[^\n]*note/i);
});

test("focus never jumps: only the copy whose Add note was pressed focuses the field", () => {
  assert.match(source, /autoFocus=\{focusNote === d\.id\}/, "the note field focuses only where it was opened");
  assert.doesNotMatch(source, /<TextInput[^>]*key=\{[^}]*notes/, "the field is never re-keyed by its text (a remount would drop the caret)");
});

test("Enter in the note field never sends; Ctrl+Enter (Cmd+Enter on a Mac) still does", () => {
  assert.equal(submitKey(key({}), { tag: "TEXTAREA" }, false), false, "plain Enter in the multiline note adds a line");
  assert.equal(submitKey(key({ ctrlKey: true }), { tag: "TEXTAREA" }, false), true);
  assert.equal(submitKey(key({ metaKey: true }), { tag: "TEXTAREA" }, true), true);
  assert.match(source, /<TextInput accessibilityLabel=\{`Note for the agent[^]*?multiline/, "the note field is multiline");
  // Multi: the keyboard's Send is Send all, carrying the notes; a single card's keyboard Send stays Something else's.
  assert.match(source, /const keySend = multi \? \(sendBar\(b, sendable\)\.ready \? \(\) => sendAll\(\)/);
  assert.match(source, /const sendAll = \(\) => void run\("answers", async answerId => \{ await answer\(cardPicks\(sendable, words, openNotes\), answerId\); clearCard\(b\.id\); \}\);/);
});

test("the picks carry the note with a letter and Something else's words, never one for the other", () => {
  assert.deepEqual(cardPicks({ D1: "A", D2: "other", D3: "B" }, { D2: "Neither" }, { D1: " keep the BOM off ", D2: "ignored", D3: "  " }), [
    { decisionId: "D1", choice: "A", words: "keep the BOM off" },
    { decisionId: "D2", choice: "other", words: "Neither" },
    { decisionId: "D3", choice: "B" },
  ]);
  assert.equal(notedCount({ D1: "A", D2: "other", D3: "B" }, { D1: "x", D2: "y" }), 1, "Something else's words aren't a note");
});

test("a sent answer clears that card's note: every send path ends in clearCard", () => {
  assert.match(source, /const clearCard = \(briefId: string\) => \{ pickStore\.clear\(briefId\); wordStore\.clear\(briefId\); noteStore\.clear\(briefId\); noteOpenStore\.clear\(briefId\); \};/);
  for (const path of ["const sendOne", "const sendAll", "const sendOther"]) {
    const line = source.split("\n").find(l => l.trimStart().startsWith(path)) ?? "";
    assert.match(line, /clearCard\(b\.id\)/, `${path} clears the card after the answer lands`);
  }
  const store = cardStore(false);
  store.set("brief:t1", "D1", "note"); store.clear("brief:t1");
  assert.deepEqual(store.get("brief:t1"), {});
});

test("the copy: a labelled field, a placeholder that says what it does, and only Remove note under it", () => {
  assert.match(source, />Note<\/Text>/);
  assert.match(source, /"Sent with your pick for this decision" : "Sent with the option you tap"/);
  assert.match(source, /label="Remove note"/);
  assert.match(source, /a11y=\{numbered \? `Add note to decision \$\{i \+ 1\}` : "Add note"\}/);
  assert.match(source, /`Send \$\{option\.letter\} with note`/);
  assert.doesNotMatch(source, /Tap an option to send it with this note|Sent with your pick for \d/);
});
