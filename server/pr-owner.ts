import type { State } from "../shared/model";

/** Duplicate claims are ambiguous. Never route by recency or by PR title. */
export function prOwner(state: State, repo: string, number: number) {
  const claims = state.workspaces.filter(w => w.enable_tracking && !w.archived)
    .flatMap(w => w.prs.filter(p => p.repo.toLowerCase() === repo.toLowerCase() && p.number === number)
      .map(p => ({ workspaceId: w.id, agentId: p.registeredAgentId ?? w.mainAgentId })));
  return claims.length === 1 ? claims[0] : null;
}
