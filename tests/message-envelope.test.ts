import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { ENVELOPE_SEPARATOR, PART_HEADERS, envelopeParts, envelopeText } from "../shared/queue";
import { answerMessage, parseAnswerMessage } from "../shared/questions";
import { parseBatchPrompt } from "../shared/chat";
import { messageSender } from "../shared/message-sender";
import { answerLine } from "../shared/overseer";
import { BATCH_PREFIX, RECOVERY_TITLE } from "../shared/legacy";

/**
 * One Follow-up message can carry several parts (an answer and the repair batch that rode along with it). What the
 * agent is told (the hook's SessionStart text, the batch instructions) and what the queue sends must agree, and every
 * reader of a user message must still see each part.
 */
const answer = answerMessage({ id: "Q3", title: "Retry policy", mode: "work-around", big: null, recommend: "A", taskId: null, answer: null, options: [{ letter: "A", label: "Exponential backoff" }, { letter: "B", label: "Fixed delay" }] } as never, "B", "cap it at 5 minutes");
const batch = `${BATCH_PREFIX} 6f1c2a9e-0000-4000-8000-000000000001\n\n1. Fix the failing lint check on #12.\n\n---\n\nThat rule is noisy; keep it.`;

// The hook runs as its own script (importing it would start it), so its text is read from the source.
const hookSource = readFile(new URL("../shared/agent-text.mjs", import.meta.url), "utf8");
const guidance = async () => JSON.parse(/export const ENVELOPE_GUIDANCE = ("(?:[^"\\]|\\.)*");/.exec(await hookSource)![1]!) as string;

test("the hook's guidance names the separator and the headers the queue sends", async () => {
  const ENVELOPE_GUIDANCE = await guidance();
  assert.equal(ENVELOPE_SEPARATOR, "\n\n---\n\n");
  assert.match(ENVELOPE_GUIDANCE, /a line holding only ---/);
  for (const header of ["Follow-up answer", "Follow-up batch"]) {
    assert.ok(ENVELOPE_GUIDANCE.includes(header), `the guidance names ${header}`);
    assert.ok(PART_HEADERS.some(h => h.startsWith(header)), `the queue splits on ${header}`);
  }
  assert.ok(PART_HEADERS.includes(`${BATCH_PREFIX} `) && PART_HEADERS.includes(`${RECOVERY_TITLE} `), "the queue's headers are the senders' own");
});

test("the guidance reaches the agent: SessionStart text and the batch instructions", async () => {
  const hook = await hookSource;
  assert.match(hook, /Withdraw questions that stop mattering\. " \+ ENVELOPE_GUIDANCE/);
  assert.match(hook, /A batch can arrive as one part of a message, after an answer, separated by a line holding only ---/);
});

test("an envelope splits back into its parts, and a part's own --- stays in it", () => {
  const text = envelopeText([answer, batch]);
  assert.deepEqual(envelopeParts(text), [answer, batch]);
  assert.deepEqual(envelopeParts(batch), [batch], "a batch body's own --- is not a part boundary");
  assert.deepEqual(envelopeParts("plain words\n\n---\n\nmore"), ["plain words\n\n---\n\nmore"]);
});

test("every reader still sees each part: the answer card, the batch card, the sender, the Overseer's preview", () => {
  const text = envelopeText([answer, batch]);
  const [first, second] = envelopeParts(text);
  assert.equal(parseAnswerMessage(first!)?.choice, "B");
  assert.equal(parseAnswerMessage(first!)?.words, "cap it at 5 minutes", "the note isn't swallowed into the next part");
  assert.ok(parseBatchPrompt(second!), "the batch part parses as a batch card");
  assert.equal(messageSender(text).kind, "follow-up", "the whole message is still Follow-up's own");
  assert.equal(answerLine(text), "Answered: B · Fixed delay");
  assert.ok(text.includes("Follow-up answer Q3 ("), "the answer marker the turn-end check reads survives");
});
