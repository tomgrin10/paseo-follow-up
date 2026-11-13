import { useEffect, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRpc } from "@getpaseo/plugin/client";
import { getRpc } from "../shared/contracts";
import type { LiveStore } from "./live";
import { acceptWorkspace } from "./live-copies";
import { workspaceKey } from "./keys";
import type { Workspace } from "../shared/model";

const none = () => () => {};

/**
 * One workspace in full for the panel, the larger view, the pill's popover and Home's open row (1.4.0; full since
 * 2.0.1). The client's shared live store holds every followed workspace in its LIST form only (shared/list.ts,
 * a-list-carries-only-what-lists-draw): what Home, the pill and the sidebar draw, without deployment evidence, task
 * evidence or question background. A surface that draws detail makes one small read of its own workspace on open,
 * never a poll; when the list copy changes after that read, it reads once more; a mutation's invalidation re-reads it.
 */
type GetReply = { workspace: Workspace | null; error: string | null };
/** One read of a workspace; its list form also reaches every live store (acceptWorkspace), so no surface keeps an older one. */
export async function readWorkspace(read: (input: { workspaceId: string }) => Promise<GetReply>, workspaceId: string): Promise<GetReply> {
  const reply = await read({ workspaceId });
  if (reply.workspace) acceptWorkspace(reply.workspace);
  return reply;
}

export function useWorkspace(live: LiveStore | undefined, workspaceId: string, options: { enabled?: boolean } = {}) {
  const enabled = (options.enabled ?? true) && !!workspaceId;
  const read = useRpc(getRpc);
  // The list copy only says when to read again: a change listed after this read (updatedAt) re-reads once.
  const listedAt = useSyncExternalStore(live?.subscribe ?? none, () => enabled ? live?.get(workspaceId)?.updatedAt ?? null : null, () => null);
  const query = useQuery({ queryKey: workspaceKey(workspaceId), queryFn: () => readWorkspace(read, workspaceId), enabled, staleTime: 15_000, refetchOnWindowFocus: false });
  const readAt = query.data?.workspace?.updatedAt ?? null;
  const { refetch, isFetching } = query;
  useEffect(() => {
    if (enabled && listedAt && readAt && !isFetching && Date.parse(listedAt) > Date.parse(readAt)) void refetch();
  }, [enabled, listedAt, readAt, isFetching, refetch]);
  const workspace = enabled ? query.data?.workspace ?? null : null;
  return {
    workspace,
    /** Nothing to show yet: the read hasn't answered. */
    pending: !workspace && query.isPending && enabled,
    error: query.error,
    loadError: query.data?.error ?? null,
    refetching: query.isRefetching,
    refetch: () => { live?.refresh(); return query.refetch(); },
  };
}
