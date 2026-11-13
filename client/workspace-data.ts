import { useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRpc } from "@getpaseo/plugin/client";
import { getRpc } from "../shared/contracts";
import type { Workspace } from "../shared/model";
import type { LiveStore } from "./live";
import { acceptWorkspace } from "./live-copies";
import { workspaceKey } from "./keys";

const none = () => () => {};
const newer = (a: Workspace | null | undefined, b: Workspace | null | undefined): Workspace | null => {
  if (!a) return b ?? null; if (!b) return a;
  return Date.parse(b.updatedAt) > Date.parse(a.updatedAt) ? b : a;
};

/**
 * One workspace for the panel, the larger view and the pill (1.4.0). The client's shared live store already holds
 * every followed workspace and keeps it current (one diff poll for the whole client, nudged by agent changes), so a
 * surface paints from it at once. On open it makes one small read of its own workspace, never a poll; a mutation's
 * invalidation re-reads it once. Whichever copy is newer wins.
 */
type GetReply = { workspace: Workspace | null; error: string | null };
/** One read of a workspace; its copy also reaches every live store (acceptWorkspace), so no surface keeps an older one. */
export async function readWorkspace(read: (input: { workspaceId: string }) => Promise<GetReply>, workspaceId: string): Promise<GetReply> {
  const reply = await read({ workspaceId });
  if (reply.workspace) acceptWorkspace(reply.workspace);
  return reply;
}

export function useWorkspace(live: LiveStore | undefined, workspaceId: string, options: { enabled?: boolean; read?: boolean } = {}) {
  const enabled = (options.enabled ?? true) && !!workspaceId;
  const read = useRpc(getRpc);
  useSyncExternalStore(live?.subscribe ?? none, live?.version ?? (() => 0), live?.version ?? (() => 0));
  const cached = enabled ? live?.get(workspaceId) : undefined;
  const query = useQuery({ queryKey: workspaceKey(workspaceId), queryFn: () => readWorkspace(read, workspaceId), enabled: enabled && (options.read ?? true), staleTime: 15_000, refetchOnWindowFocus: false });
  const workspace = enabled ? newer(cached, query.data?.workspace) : null;
  return {
    workspace,
    /** Nothing to show yet: no live copy and the read hasn't answered. */
    pending: !workspace && query.isPending && enabled && (options.read ?? true),
    error: query.error,
    loadError: query.data?.error ?? null,
    refetching: query.isRefetching,
    refetch: () => { live?.refresh(); return query.refetch(); },
  };
}
