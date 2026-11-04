import { useSyncExternalStore } from "react";
import { Text, View } from "react-native";
import { useRpc, type PluginButtonContentProps, type PluginButtonIconProps, type PluginButtonRegistration, type PluginClientContext, type PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { Icon, SidebarRow } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { getRpc, listRpc, browserStatusRpc } from "../shared/contracts";
import type { Workspace } from "../shared/model";
import { needsYou, pillFor } from "../shared/attention";
import { NeedsYouList, workspaceKey } from "./needs-you";
import { Button, errorText, text } from "./kit";
import { IconSwap } from "./motion";
import { PrSheet } from "./pr-sheet";
import { QuestionSheet, QuestionStepper } from "./questions";
import { SpecChip } from "./spec";
import { isOpen as questionOpen } from "../shared/questions";

const POLL_MS = 8_000;

/** One shared poll of tracked workspaces for the pills, header-button dots and the sidebar count. */
export function createLiveStore(client: PluginClientContext) {
  let workspaces = new Map<string, Workspace>();
  let version = 0;
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const emit = () => { version++; for (const l of listeners) l(); };
  const poll = async () => {
    try {
      const result = await client.rpc(listRpc, {});
      if (stopped) return;
      workspaces = new Map(result.workspaces.filter(w => !w.archived).map(w => [w.id, w]));
      emit();
    } catch { /* Keep the last answer through restarts and disconnects. */ }
    finally { if (!stopped) timer = setTimeout(() => void poll(), POLL_MS); }
  };
  void poll();
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    version: () => version,
    get: (id: string) => workspaces.get(id),
    all: () => [...workspaces.values()],
    refresh: () => { if (timer) clearTimeout(timer); void poll(); },
    stop() { stopped = true; if (timer) clearTimeout(timer); listeners.clear(); },
  };
}
export type LiveStore = ReturnType<typeof createLiveStore>;

function useLive<T>(store: LiveStore, select: () => T): T {
  useSyncExternalStore(store.subscribe, store.version, store.version);
  return select();
}

/** Composer pills appear on a tracked workspace's main agent only while something needs the developer. */
export function contributePills(client: PluginClientContext, store: LiveStore, openPanel: (workspaceId: string) => void) {
  const pills = new Map<string, { workspaceId: string; label: string; urgent: boolean; pill: PluginButtonRegistration }>();

  function PillIcon(props: PluginButtonIconProps) {
    const kind = useLive(store, () => {
      const w = store.get(props.workspaceId);
      if (!w) return "attention";
      const items = needsYou(w);
      if (items.some(i => ["hold", "retry", "check", "answer"].includes(i.kind))) return "urgent";
      if (items.some(i => i.kind === "question" && i.state === "stopped")) return "stopped";
      return items.every(i => i.kind === "question") ? "question" : "attention";
    });
    const c = props.theme.colors;
    return <IconSwap swapKey={kind} size={props.size}>
      <Icon name={kind === "urgent" ? "OctagonAlert" : kind === "stopped" ? "CirclePause" : kind === "question" ? "MessageCircleQuestion" : "CircleAlert"} size={props.size} color={kind === "urgent" ? c.statusDanger : c.statusWarning} />
    </IconSwap>;
  }

  function PillContent(props: PluginButtonContentProps) {
    const c = props.theme.colors; const t = text(c);
    const read = useRpc(getRpc); const browserRead = useRpc(browserStatusRpc);
    const query = useQuery({ queryKey: workspaceKey(props.workspaceId), queryFn: () => read({ workspaceId: props.workspaceId }), refetchInterval: 5000 });
    const browser = useQuery({ queryKey: ["follow-through", "browser"], queryFn: () => browserRead({}), refetchInterval: 5000 });
    const [sheet, setSheet] = useState<{ key: string; intent: "merge" | "reviewers" } | null>(null);
    const [question, setQuestion] = useState<string | null>(null);
    const w = query.data?.workspace ?? store.get(props.workspaceId);
    const touch = props.layout.compact;
    const asking = !!w?.questions.some(questionOpen);
    const others = w ? needsYou(w).filter(i => i.kind !== "question") : [];
    const open = () => { props.close(); openPanel(props.workspaceId); };
    // On phones the host sheet's own header already pads the top; tuck the content up to it.
    return <View style={{ width: 360, maxWidth: "100%", gap: 10, marginTop: touch ? -12 : 0 }}>
      {w ? <>
        {/* Open questions take the whole popover, one at a time; the rest is a line and a click away. */}
        {asking ? <>
          <QuestionStepper workspace={w} theme={props.theme} compact={touch} bodyMaxHeight={touch ? undefined : 220} onDetails={setQuestion} onAnswered={() => store.refresh()} />
          {others.length > 0 && <Text numberOfLines={2} style={[t.small, { paddingTop: 8, borderTopWidth: 1, borderTopColor: c.border }]}>Also needs you: {others.map(i => i.title).join(" · ")}</Text>}
        </> : <>
          {/* On phones the sheet already carries the button's title. */}
          {!touch && <View style={{ gap: 2 }}>
            <Text style={t.label}>{others.length === 1 ? "Follow-up needs you" : `Follow-up · ${others.length} need you`}</Text>
            <Text numberOfLines={1} style={t.meta}>{w.title}</Text>
          </View>}
          <NeedsYouList workspace={w} theme={props.theme} compact={touch} flush
            actions={{ after: () => { store.refresh(); }, openPr: (key, intent) => setSheet({ key, intent }), openQuestion: setQuestion }} />
        </>}
        <PrSheet workspace={w} prKey={sheet?.key ?? null} intent={sheet?.intent ?? null} theme={props.theme} compact={touch} browserReady={browser.data?.ready ?? false} onClose={() => { setSheet(null); store.refresh(); }} />
        <QuestionSheet workspace={w} questionId={question} theme={props.theme} compact={touch} onClose={() => { setQuestion(null); store.refresh(); }} />
      </> : <Text style={t.meta}>{query.error ? `Couldn't read Follow-up: ${errorText(query.error)}` : "Loading…"}</Text>}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingTop: 10, borderTopWidth: 1, borderTopColor: c.border }}>
        <View style={{ flex: 1 }}><Button theme={props.theme} compact={touch} grow icon="PanelRight" title="Open Follow-up" onPress={open} /></View>
        {w?.spec?.url && <SpecChip workspace={w} theme={props.theme} compact={touch} />}
      </View>
    </View>;
  }

  const publish = () => {
    const wanted = new Map<string, { workspaceId: string; label: string; urgent: boolean }>();
    for (const w of store.all()) {
      const pill = pillFor(w);
      if (pill) wanted.set(w.mainAgentId, { workspaceId: w.id, label: pill.label, urgent: pill.urgent });
    }
    for (const [agentId, entry] of pills) {
      const next = wanted.get(agentId);
      if (!next || next.workspaceId !== entry.workspaceId) { entry.pill.remove(); pills.delete(agentId); }
    }
    for (const [agentId, next] of wanted) {
      const entry = pills.get(agentId);
      const asking = /^Question |questions$/.test(next.label);
      const title = asking ? "Follow-up: the agent asked you a question" : next.urgent ? "Follow-up: something is blocked" : "Follow-up needs you";
      if (!entry) {
        const pill = client.addComposerPill({ id: "follow-up-attention", workspaceId: next.workspaceId, agentId, button: { title, label: next.label, icon: PillIcon, behavior: { kind: "popover", Content: PillContent } } });
        pills.set(agentId, { workspaceId: next.workspaceId, label: next.label, urgent: next.urgent, pill });
      } else if (entry.label !== next.label || entry.urgent !== next.urgent) {
        entry.pill.update({ label: next.label, title });
        entry.label = next.label; entry.urgent = next.urgent;
      }
    }
  };
  const unsubscribe = store.subscribe(publish);
  return () => { unsubscribe(); for (const { pill } of pills.values()) pill.remove(); pills.clear(); };
}

/** The header button's icon: a pull-request glyph with a warning dot while the workspace needs you. */
export function headerIcon(store: LiveStore) {
  return function HeaderIcon(props: PluginButtonIconProps) {
    const need = useLive(store, () => { const w = store.get(props.workspaceId); return w ? needsYou(w).length : 0; });
    return <View style={{ width: props.size, height: props.size }}>
      <Icon name="GitPullRequest" size={props.size} color={props.color} />
      {need > 0 && <View accessibilityLabel={`${need} need you`} style={{ position: "absolute", top: -2, right: -3, width: 7, height: 7, borderRadius: 4, backgroundColor: props.theme.colors.statusWarning, borderWidth: 1.5, borderColor: props.theme.colors.surface0 }} />}
    </View>;
  };
}

/** The sidebar row, with a count of workspaces that need you. */
export function sidebarItem(store: LiveStore, screenId: string) {
  return function FollowSidebarItem({ currentScreen, openScreen, theme }: PluginSidebarItemProps) {
    const need = useLive(store, () => store.all().filter(w => needsYou(w).length > 0).length);
    const c = theme.colors;
    return <SidebarRow icon="GitPullRequest" active={currentScreen?.screenId === screenId} onPress={() => openScreen({ screenId })}
      trailing={need > 0 ? <View accessibilityLabel={`${need} workspace${need === 1 ? "" : "s"} need you`} style={{ minWidth: 18, height: 18, paddingHorizontal: 5, borderRadius: 9, alignItems: "center", justifyContent: "center", backgroundColor: c.statusWarning }}>
        <Text style={{ color: c.surface0, fontSize: 11, lineHeight: 14, fontWeight: "700", fontVariant: ["tabular-nums"] }}>{need}</Text>
      </View> : undefined} />;
  };
}
