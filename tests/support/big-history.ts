import { workspace } from "../fixtures";
import type { Workspace } from "../../shared/model";

/**
 * A busy workspace's history (fictional): `questions` asked and answered, `batches` sent and finished, a few still
 * open. 2026-11-26 live shape: ~175 questions and a long activity log in one workspace.
 */
export function bigHistory({ questions = 175, batches = 400, open = 3, needle = "zanzibar" }: { questions?: number; batches?: number; open?: number; needle?: string } = {}): Workspace {
  const t0 = Date.parse("2026-01-01T10:00:00Z");
  const iso = (m: number) => new Date(t0 + m * 60_000).toISOString();
  const qs = Array.from({ length: questions }, (_, i) => ({
    id: `Q${i + 1}`, title: i === 0 ? `Pick the ${needle} retry policy` : `Pick the retry policy for job ${i + 1}`,
    question: "Which retry policy should the invoice job use when the provider times out? ".repeat(6),
    options: [{ letter: "A", label: "Retry three times" }, { letter: "B", label: "Fail fast" }], recommend: "A", big: null,
    background: "The provider times out about once a day under load, and a retry usually succeeds. ".repeat(8), links: [],
    prKey: null, taskId: null, taskRevision: null, askedBy: "main-agent", askedAt: iso(i * 10), mode: "keep-building" as const,
    answer: i < questions - open ? { choice: "A", words: "Go with A and log each retry.", at: iso(i * 10 + 5), by: "developer" as const, delivery: { state: "sent" as const, to: "main-agent", messageId: `a${i}`, at: iso(i * 10 + 6) } } : null,
    closed: null,
  }));
  const bs = Array.from({ length: batches }, (_, i) => ({
    id: `b${i}`, tasks: [{ key: `checks:example/app#1:${i}`, kind: "checks", target: "example/app#1", title: `Fix the failing check run ${i}`, fingerprint: `f${i}` }],
    state: "completed" as const, createdAt: iso(i * 4), sentAt: iso(i * 4), settledAt: iso(i * 4 + 2), messageId: `m${i}`, attempts: 1,
    result: "Fixed the flaky test and pushed a new head. ".repeat(3), recipientAgentId: "main-agent", contextPath: null, activityAt: null, acknowledgmentError: null, recoveryHandoffs: [],
  }));
  return workspace({ questions: qs as never, batches: bs as never, updatedAt: iso(questions * 10 + 10) });
}
