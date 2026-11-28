import { useEffect, useMemo, useRef } from "react";
import { usePaseo, useRpc } from "@getpaseo/plugin/client";
import { copyText, useToast } from "@getpaseo/plugin/client/ui";
import { useQueryClient } from "@tanstack/react-query";
import { controlRpc, sendRpc, setFollowSettingsRpc, workspaceAboutRpc } from "../shared/contracts";
import { needsYou, workspaceSnoozed } from "../shared/attention";
import { snoozeUntil, wakeLabel } from "../shared/inbox";
import { rowMenu, type LaterChoice, type RowMenuItem } from "../shared/row-menu";
import type { Workstream } from "../shared/home";
import { aboutKey } from "./about";
import { openRename } from "./rename";
import { openReportSheet } from "./report-issue";
import { bindToast, runAction } from "./toast-store";
import type { HomeSources } from "./home-data";

/** What the surface showing the menu does for the moves that leave the list (open, answer, ask). */
export type RowMenuHost = {
  sources: HomeSources;
  openFull: (s: Workstream) => void;
  openQuestion: (s: Workstream, questionId: string) => void;
  /** Pre-fills an Overseer ask; absent where there's no omnibox. */
  prefillAsk?: (text: string) => void;
  /** The Overseer is on, so an ask has somewhere to go. */
  overseerOn: boolean;
};

/**
 * The row menu for a Home list: `build` lists what applies to a row, `pick` runs one move. Every move goes through
 * `runAction` (the menu is already closed; the result shows as a toast) and reuses the RPC its usual button calls.
 */
export function useRowMenu(host: RowMenuHost) {
  const toast = useToast();
  useEffect(() => { bindToast(toast); }, [toast]);
  const cache = useQueryClient();
  // Archive is Paseo's own request (archive_workspace_request, what Paseo's Archive sends), on the host's API when it has it.
  const paseoApi = usePaseo() as { workspaces?: { archive?: (id: string) => Promise<{ error: string | null; canceled?: boolean }>; ref?: (id: string) => { setPinned?: (pinned: boolean) => Promise<{ pinnedAt: string | null }> } } } | null;
  const send = useRpc(sendRpc); const control = useRpc(controlRpc); const about = useRpc(workspaceAboutRpc); const setFollow = useRpc(setFollowSettingsRpc);
  // Read through a ref so build and pick stay one stable pair: the list's memoised rows compare them by identity.
  const archiveWorkspace = typeof paseoApi?.workspaces?.archive === "function" ? (id: string) => paseoApi.workspaces!.archive!(id) : null;
  // Pin to top / Unpin: Paseo's own setWorkspacePinned, on hosts whose workspace handle has it.
  const setPinned = typeof paseoApi?.workspaces?.ref === "function" ? (id: string, pinned: boolean) => {
    const ref = paseoApi.workspaces!.ref!(id);
    if (typeof ref?.setPinned !== "function") throw new Error("This Paseo can't pin workspaces.");
    return ref.setPinned(pinned);
  } : null;
  const current = useRef({ host, send, control, about, setFollow, cache, archiveWorkspace, setPinned });
  current.current = { host, send, control, about, setFollow, cache, archiveWorkspace, setPinned };
  return useMemo(() => {
    const deps = () => current.current;
    const build = (s: Workstream) => {
      const { sources: { inbox, live, paseo }, prefillAsk, overseerOn } = deps().host;
      const row = s.agentId ? inbox.rows().find(r => r.agentId === s.agentId) ?? null : null;
      const w = s.workspaceId ? live.get(s.workspaceId) ?? null : null;
      const needs = w ? needsYou(w) : [];
      // A workspace-only Needs-you row: Home's own row for the workspace, with needs and no agent flag behind it.
      const wsOnly = !!w && s.key === `ws:${w.id}` && needs.length > 0 && !row?.needs;
      const wsSnooze = wsOnly && w!.snooze && workspaceSnoozed(w!, needs, Date.now()) ? w!.snooze : null;
      const workspaceLater = wsOnly ? { snoozedUntil: wsSnooze ? wakeLabel({ until: wsSnooze.until, at: wsSnooze.at }, Date.now()) || null : null } : null;
      const listed = s.workspaceId ? paseo.get(s.workspaceId) : undefined;
      return rowMenu({ s, workspaceLater, flagged: !!row?.needs, snoozedUntil: row?.needs && row.snooze ? wakeLabel(row.snooze, Date.now()) || null : null, w, needs, branch: listed?.branch ?? null, canAsk: !!prefillAsk && overseerOn,
        archive: deps().archiveWorkspace ? listed?.archive ?? null : null, ...(deps().setPinned && listed && "pinnedAt" in listed ? { pinnedAt: listed.pinnedAt ?? null } : {}) });
    };
    const pick = (s: Workstream, item: RowMenuItem): Promise<boolean> => {
      const { host: { sources: { inbox, live }, openFull, openQuestion, prefillAsk }, send, control, about, setFollow, cache, archiveWorkspace } = deps();
      const after = () => { live.refresh(); inbox.refresh(); };
      const w0 = (id: string) => id ? live.get(id) ?? null : null;
      const workspaceId = s.workspaceId ?? "";
      const arg = item.arg ?? "";
      switch (item.action) {
        // Later and Sign off: the Undo bar already says it and offers Undo; no toast on top.
        case "later": return runAction({ label: "Later", run: () => inbox.snooze([s.agentId!], snoozeUntil(arg as LaterChoice, new Date())), success: null }, `later:${s.key}`);
        case "bring_back": return runAction({ label: "Bring back now", run: () => inbox.unsnooze([s.agentId!]), success: "Back in Needs you" }, `bring_back:${s.key}`);
        // Workspace Later: the same Undo bar as an agent's Later; Undo puts back whatever workspace snooze this replaced.
        case "later_ws": {
          const prev = w0(workspaceId)?.snooze ?? null;
          const until = snoozeUntil(arg as LaterChoice, new Date());
          return runAction({ label: "Later", run: async () => {
            await control({ workspaceId, snooze: { until } }); after();
            inbox.noteLater(s.title, until, async () => { await control({ workspaceId, snooze: prev && Date.parse(prev.until) > Date.now() || prev?.until === "next-event" ? { until: prev.until } : null }); after(); }, s.key);
          }, success: null }, `later_ws:${workspaceId}`);
        }
        case "bring_back_ws": return runAction({ label: "Bring back now", run: async () => { await control({ workspaceId, snooze: null }); after(); }, success: "Back in Needs you" }, `bring_back_ws:${workspaceId}`);
        case "sign_off": return runAction({ label: "Sign off", run: () => inbox.signOff([s.agentId!]), success: null }, `sign_off:${s.key}`);
        case "answer": return runAction({ label: "Answer", run: async () => openQuestion(s, arg), success: null });
        case "send_repairs": return runAction({ label: "Send repairs", run: async () => { const r = await send({ workspaceId, batchId: arg }); after(); return r; },
          success: r => {
            const b = r.batches.find(x => x.id === arg);
            if (!b || ["sent", "sending", "completed"].includes(b.state)) return "Sent to the main agent";
            if (b.state === "pending") return "Queued. It goes out when the agent is free.";
            if (b.state === "uncertain") return "Delivery wasn't confirmed. Check the agent before retrying.";
            throw new Error(b.result || "The repairs couldn't be sent.");
          } }, `send:${workspaceId}`);
        case "retry_batch": return runAction({ label: "Retry message", run: async () => { await control({ workspaceId, retryBatchId: arg }); after(); }, success: "Queued to send again" }, `retry:${workspaceId}`);
        case "clear_hold": return runAction({ label: "Resume follow-up", run: async () => { await control({ workspaceId, clearHold: true }); after(); }, success: "Follow-up resumed" }, `hold:${workspaceId}`);
        case "open_chat": return runAction({ label: "Open", run: async () => openFull(s), success: null });
        case "ask_overseer": return runAction({ label: "Ask the Overseer", run: async () => prefillAsk?.(`About ${s.title}: `), success: null });
        case "pin": return runAction({ label: "Pin to top", run: async () => { await deps().setPinned!(workspaceId, true); }, success: `Pinned ${s.title}`, failure: `Couldn't pin ${s.title}` }, `pin:${workspaceId}`);
        case "unpin": return runAction({ label: "Unpin", run: async () => { await deps().setPinned!(workspaceId, false); }, success: `Unpinned ${s.title}`, failure: `Couldn't unpin ${s.title}` }, `pin:${workspaceId}`);
        case "copy_branch": return runAction({ label: "Copy branch", run: () => copyText(arg), success: "Branch name copied", failure: "Couldn't copy here" });
        case "rewrite_summary": return runAction({ label: "Rewrite summary", run: async () => cache.setQueryData(aboutKey(workspaceId), await about({ workspaceId, open: true, refresh: true })), success: "Summary rewritten" }, `about:${workspaceId}`);
        case "report": return runAction({ label: "Report a bug", run: async () => openReportSheet({ kind: "bug", workspaceId, about: workspaceId, aboutTitle: s.title }), success: null });
        case "rename_ai": return runAction({ label: "Rename title with AI", run: async () => openRename({ workspaceId, title: s.title }), success: null });
        case "make_main": return runAction({ label: "Make main agent", run: async () => { await control({ workspaceId, mainAgentId: arg }); after(); }, success: `${s.agent ?? "That agent"} is now the main agent` }, `main:${workspaceId}`);
        case "stop_following": return runAction({ label: "Stop following", run: async () => { await setFollow({ workspace: { workspaceId, follow: false } }); after(); }, success: `Stopped following ${s.title}` }, `follow:${workspaceId}`);
        // Only from the confirm step's button (RowMenu's choose). Paseo's reply carries its reason when it refuses.
        case "archive": return runAction({ label: "Archive", failure: `Couldn't archive ${s.title}`, run: async () => {
          if (!archiveWorkspace) throw new Error("This Paseo can't archive from a plugin.");
          const r = await archiveWorkspace(workspaceId);
          // An Undo from Paseo's own app cancels the archive mid-way: the workspace stays, which is no failure.
          if (r.canceled) { after(); return "undone" as const; }
          if (r.error) throw new Error(r.error);
          after();
          return "archived" as const;
        }, success: r => r === "undone" ? `${s.title} stays: its archive was undone` : `Archived ${s.title}. It's under Archived in search.` }, `archive:${workspaceId}`);
      }
    };
    return { build, pick: (s: Workstream, item: RowMenuItem) => { void pick(s, item); } };
  }, []);
}
