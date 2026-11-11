import test from "node:test";
import assert from "node:assert/strict";
import { fakeServer, hanging, hangingHost, settleTime, type Registered } from "./support/hanging-host";
import { clientRpcs } from "./support/client-rpcs";
import { FIXTURE, sample } from "./support/sample-input";
import { seed } from "./support/seed";

/**
 * Invariant (2026-11-11, "Your answer wasn't sent. Plugin RPC timed out: follow-up.invoke"): every RPC the client
 * calls replies within ACK_MS even when everything slow hangs: the Paseo API never answers, the daemon socket accepts
 * and stays silent, and gh, gt, mcpproxy, claude and codex never exit. Paseo gives a plugin RPC 30 s and then shows the
 * developer an error, whatever the handler later does; an answer that arrived 88 s later still read "wasn't sent".
 *
 * Slow side effects (sending to an agent, GitHub, the daemon) run after the reply, or are queued durably; a handler
 * only records and returns. The methods are not a hand-picked list: every handler contribute() registers that the
 * client calls (tests/support/client-rpcs.ts) runs against the real worker in a temp PASEO_HOME.
 *
 * EXEMPT holds the client RPCs that still wait on Paseo or GitHub before replying, each with why that is acceptable
 * for now. The list only shrinks: an exempt method that starts replying in time fails the test until it's removed.
 * Nothing here may lose the developer's input: none of them carries words the developer typed.
 */
const ACK_MS = 500;

/** Inputs a schema can't spell out: which decision a card answers, the answer's id. Everything else is sample(). */
const INPUT: Record<string, unknown> = {
  "follow.brief-action": { agentId: FIXTURE.agentId, briefId: FIXTURE.briefId, decisionId: "D1", choice: "A", answerId: "rpc-ack-answer-1" },
  "follow.answer-question": { workspaceId: FIXTURE.workspaceId, questionId: FIXTURE.questionId, choice: "A", action: "send" },
};
/** The developer's answers: these must succeed in time, not just fail fast. */
const MUST_SUCCEED = new Set(Object.keys(INPUT));

const EXEMPT: Record<string, string> = {
  // Needs you. Reads and row moves; no typed input. Follow-up: serve the last directory snapshot instead of waiting.
  "follow.inbox-list": "The Needs-you list refreshes Paseo's agent directory (cached 3 s) before it answers; read-only, the panel keeps its last list.",
  "follow.inbox-act": "Sign-off, Later and Undo clear Paseo's attention flag before replying; a timeout leaves the row as it was, one click redoes it.",
  // Workspaces and PRs. Nothing changes until the developer confirms, or the change is GitHub's own request.
  "follow.send": "Sending a repair batch first asks Paseo whether the agents are busy, then dispatches; the batch stays queued on a timeout.",
  "follow.prepare-pr-action": "A merge or reviewer plan reads the PR's live state from GitHub; nothing changes until confirm.",
  "follow.check-pr-action": "Re-checks a PR action against GitHub; read-only.",
  "follow.request-reviewers": "Requests reviewers on GitHub; with Remember on, the list is saved before the request.",
  "follow.reviewer-suggestions": "Suggestions are the repository's collaborators, from GitHub; read-only.",
  "follow.pr-workflow": "Settings → PR workflow resolves each repository's workflow (Graphite or GitHub); read-only.",
  "follow.set-pr-workflow": "Saves the setting, then re-resolves the workflow for the view it returns.",
  // Settings screens: reads, or a toggle saved before the slow part.
  "follow.project-settings": "The project list comes from Paseo; read-only.",
  "follow.set-project-tracking": "Checks the project against Paseo's list before saving the toggle.",
  "follow.agent-settings": "Settings → Agents reads Paseo's provider catalog (cached ten minutes); read-only.",
  "follow.set-agent-setting": "Saves the role's agent, then returns the view with Paseo's provider catalog.",
  "follow.set-wait": "Saves the switch, then returns the Agents view with Paseo's provider catalog.",
  "follow.onboarding-checks": "Getting started's readiness checks run gh and ask Paseo; read-only.",
  "follow.usage": "The usage meters read the providers' usage when the governor allows extras; read-only.",
  "follow.updates": "Settings → General asks Paseo for this install's source and npm for a newer version; read-only.",
  "follow.set-updates": "Saves the update mode, then returns the view above.",
  "follow.dismiss-update-notice": "Dismisses the notice, then returns the view above.",
  "follow.install-update": "Checks the install's source with Paseo before the detached install.",
  "follow.release-notes": "What's new asks Paseo for this install's version and source; read-only.",
  "follow.whats-new-seen": "Marks What's new seen, then returns the view above.",
  // The Overseer. Follow-up: queue the developer's question like brief answers (overseer-ask carries their words).
  "follow.overseer-start": "Starts the Overseer agent through Paseo; its status says starting until it's up.",
  "follow.overseer-restart": "Restarts the Overseer agent through Paseo.",
  "follow.overseer-ask": "Sends the developer's question to the Overseer agent through Paseo. The search box keeps the words unless it succeeds (client/home.tsx).",
};

test("rpc ack: every RPC the client calls replies within ACK_MS while Paseo, the daemon and GitHub hang", { timeout: 180_000 }, async t => {
  const host = await hangingHost();
  t.after(() => host.close());
  await seed(host.directory);
  const { default: contribute } = await import("../index.server");
  const { server, handlers } = fakeServer();
  const stop = contribute(server as never) as unknown as () => Promise<void>;
  t.after(() => stop());
  const paseo = hanging();
  const client = await clientRpcs();
  const run = (h: Registered, input: unknown) => async () => h.run(await h.input.parseAsync(input), { paseo });
  // Worker start is its own budget (it may wait on the daemon's connect timeout); the methods are timed after it.
  const started = await settleTime(run(handlers.get("follow.list")!, {}), 60_000);
  assert.ok(started.ms !== null, "the worker never finished starting under a hanging daemon");

  const late: string[] = []; const failed: string[] = []; const stale: string[] = []; const timings: string[] = [];
  const names = [...handlers.keys()].filter(name => client.has(name)).sort();
  assert.ok(names.length >= 40, `found only ${names.length} client RPCs registered; the scan or the harness is broken`);
  for (const name of names) {
    const h = handlers.get(name)!;
    const r = await settleTime(run(h, INPUT[name] ?? sample(h.input)), ACK_MS);
    timings.push(`${name} ${r.ms === null ? `>${ACK_MS}` : Math.round(r.ms)} ms${r.error ? ` (${r.error.slice(0, 60)})` : ""}`);
    if (MUST_SUCCEED.has(name) && r.ms !== null && r.error) failed.push(`${name}: ${r.error}`);
    if (r.ms === null && !EXEMPT[name]) late.push(name);
    if (r.ms !== null && EXEMPT[name]) stale.push(name);
  }
  t.diagnostic(timings.join("\n"));
  assert.deepEqual(Object.keys(EXEMPT).filter(name => !client.has(name) || !handlers.has(name)), [], "EXEMPT lists RPCs the client no longer calls: remove them");
  assert.deepEqual(late, [], `these client RPCs wait on Paseo, the daemon or GitHub before replying. Reply once the work is recorded and run the slow part after (see Inbox.briefAction), or add an EXEMPT entry with the reason`);
  assert.deepEqual(stale, [], "these exempt RPCs now reply in time: remove them from EXEMPT");
  assert.deepEqual(failed, [], "the developer's answers must be recorded, not refused");
});
