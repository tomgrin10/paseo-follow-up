import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stateSchema } from "../../shared/model";
import { emptyInbox, newEntry } from "../../shared/inbox";
import { briefSchema } from "../../shared/brief";
import { workspace } from "../fixtures";
import { FIXTURE } from "./sample-input";

/** A tracked workspace with an open question, and its main agent with an open decision brief: what the developer answers. */
export async function seed(directory: string): Promise<void> {
  const now = new Date().toISOString();
  const question = { id: FIXTURE.questionId, title: "Ship the export fix now?", question: "Ship it?", options: [{ letter: "A", label: "Now" }, { letter: "B", label: "Wait for CI" }], recommend: "A", big: null, background: null, links: [], prKey: null, taskId: null, taskRevision: null, askedBy: "main-agent", askedAt: now, mode: "work-around", answer: null, closed: null };
  const state = stateSchema.parse({ version: 1, workspaces: [workspace({ id: FIXTURE.workspaceId, mainAgentId: FIXTURE.agentId, questions: [question] as never, updatedAt: now })] });
  await writeFile(join(directory, "state.json"), JSON.stringify(state), { mode: 0o600 });
  const brief = briefSchema.parse({ id: FIXTURE.briefId, turnId: "turn-1", source: "agent", kind: "decision", ask: "Which encoding?", sourceLine: "From the agent", at: now,
    decisions: [{ id: "D1", question: "Which encoding?", options: [{ letter: "A", label: "UTF-8" }, { letter: "B", label: "UTF-8 with BOM" }] }] });
  const inbox = emptyInbox();
  inbox.importedAt = now; inbox.primedAt = now;
  inbox.entries[FIXTURE.agentId] = { ...newEntry(FIXTURE.agentId), brief };
  await writeFile(join(directory, "inbox.json"), JSON.stringify(inbox), { mode: 0o600 });
}
