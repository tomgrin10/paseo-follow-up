import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { Text, View } from "react-native";
import { useRpc, type PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { Icon, useToast } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { activateRpc, browserStatusRpc } from "../shared/contracts";
import { followUpObligations, recoveryBatch } from "../shared/follow-up";
import type { Workstream } from "../shared/home";
import { Button, errorText, IconButton, text, type Theme } from "./kit";
import { HomeList } from "./home-list";
import { useHomeModel, type HomeSources } from "./home-data";
import { NeedsYouList, overviewKey, workspaceKey } from "./needs-you";
import { StacksCard } from "./stacks";
import { TasksCard } from "./tasks";
import { ActivityCard, QuestionSheet } from "./questions";
import { PrSheet } from "./pr-sheet";
import { useSessionFolds } from "./panel";
import type { Workspace } from "../shared/model";

export type NavigatorDeps = {
  sources: HomeSources;
  openHome(): void;
  openLarge(workspaceId: string): void;
  openSettings(): void;
  /** Re-docks the navigator in another workspace's explorer, so it follows the developer through it. */
  openPanel(workspaceId: string): void;
};

/**
 * The navigator (design §2 B): Home's list, compact, docked in a workspace's explorer column. This workspace's row
 * is expanded with what the chat doesn't show: decisions, the PR stack, tasks left, the repair budget and Details.
 * It replaces the old Follow-up workspace panel.
 */
export function FollowNavigator(props: PluginWorkspacePanelProps & { deps: NavigatorDeps }) {
  const { theme, layout, navigation, workspaceId, deps } = props;
  const c = theme.colors;
  const touch = layout.compact;
  const model = useHomeModel(deps.sources);
  // The open workspace's row: its flagged agent first, else its workspace row.
  const own = useMemo(() => {
    for (const g of model.groups) for (const s of g.items) if (s.workspaceId === workspaceId) return s.key;
    return null;
  }, [model, workspaceId]);
  const [picked, setPicked] = useState<string | null>(null);
  const selectedKey = picked && model.byKey.get(picked)?.workspaceId === workspaceId ? picked : own;
  const onSelect = useCallback((key: string) => {
    const s = model.byKey.get(key);
    if (!s) return;
    if (s.workspaceId === workspaceId) { setPicked(key); return; }
    // Another workstream: open it and bring the navigator along.
    if (s.agentId) navigation?.openAgent({ agentId: s.agentId }); else if (s.workspaceId) navigation?.openWorkspace({ workspaceId: s.workspaceId });
    if (s.workspaceId && !touch) { const id = s.workspaceId; setTimeout(() => deps.openPanel(id), 600); }
  }, [model, workspaceId, navigation, deps, touch]);
  const renderExpanded = useCallback((s: Workstream) => <Expanded s={s} theme={theme} touch={touch} deps={deps} openAgent={id => navigation?.openAgent({ agentId: id })} />, [theme, touch, deps, navigation]);

  const header = <View style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 8, paddingTop: 8, paddingBottom: 4 }}>
    <Button theme={theme} compact={touch} icon="House" title="Home" onPress={deps.openHome} />
    <View style={{ flex: 1 }} />
    {model.needs > 0 && <Text accessibilityLabel={`${model.needs} need you`} style={{ color: c.statusWarning, fontSize: 12, fontWeight: "600", fontVariant: ["tabular-nums"] }}>{model.needs} need you</Text>}
    <IconButton theme={theme} compact={touch} icon="Settings" label="Follow-up settings" onPress={deps.openSettings} />
  </View>;
  return <View style={{ flex: 1, backgroundColor: c.surface0 }}>
    <HomeList model={model} theme={theme} dense touch={touch} selectedKey={selectedKey} onSelect={onSelect} renderExpanded={renderExpanded} header={header} />
  </View>;
}

function Expanded({ s, theme, touch, deps, openAgent }: { s: Workstream; theme: Theme; touch: boolean; deps: NavigatorDeps; openAgent: (id: string) => void }) {
  const c = theme.colors;
  const w = useSyncExternalStore(deps.sources.live.subscribe, () => s.workspaceId ? deps.sources.live.get(s.workspaceId) : undefined, () => undefined);
  return <View style={{ marginLeft: 10, marginRight: 6, marginBottom: 8, paddingLeft: 14, borderLeftWidth: 2, borderLeftColor: c.border, gap: 4 }}>
    {w ? <TrackedDetail w={w} theme={theme} touch={touch} deps={deps} openAgent={openAgent} /> : s.workspaceId ? <TrackButton workspaceId={s.workspaceId} theme={theme} touch={touch} refresh={deps.sources.live.refresh} /> : null}
  </View>;
}

function TrackedDetail({ w, theme, touch, deps, openAgent }: { w: Workspace; theme: Theme; touch: boolean; deps: NavigatorDeps; openAgent: (id: string) => void }) {
  const c = theme.colors; const t = text(c);
  const folds = useSessionFolds(w.id);
  const [sheet, setSheet] = useState<{ key: string; intent: "merge" | "reviewers" | null } | null>(null);
  const [question, setQuestion] = useState<string | null>(null);
  const browserRead = useRpc(browserStatusRpc);
  const browser = useQuery({ queryKey: ["follow-through", "browser"], queryFn: () => browserRead({}), refetchInterval: 5000, enabled: !!sheet });
  const left = followUpObligations(w).filter(o => !["done", "waived"].includes(o.status)).length;
  const batch = [...w.batches].reverse().find(b => !recoveryBatch(b));
  const budget = `${w.enable_auto_sends ? "Auto repairs on" : "Auto repairs off"}${batch && batch.attempts ? ` · round ${batch.attempts} of 3` : ""}`;
  const now = Date.now();
  return <View style={{ gap: 4, marginHorizontal: -12 }}>
    <NeedsYouList workspace={w} theme={theme} compact={touch} now={now} flush actions={{ openPr: (key, intent) => setSheet({ key, intent }), openQuestion: setQuestion, openAgent }} />
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 12, paddingTop: 4 }}>
      <Icon name="Wrench" size={12} color={c.foregroundMuted} /><Text style={t.small}>{budget}{left ? ` · ${left} task${left === 1 ? "" : "s"} left` : ""}</Text>
    </View>
    {w.prs.length > 0 && <StacksCard workspace={w} theme={theme} compact={touch} open={folds.isOpen} toggle={folds.toggle} onOpen={key => setSheet({ key, intent: null })} />}
    {left > 0 && <TasksCard workspace={w} theme={theme} compact={touch} open={folds.isOpen} toggle={folds.toggle} onOpenQuestion={setQuestion} />}
    <ActivityCard workspace={w} theme={theme} compact={touch} now={now} open={folds.isOpen} toggle={folds.toggle} onOpenQuestion={setQuestion} />
    <View style={{ flexDirection: "row", gap: 8, paddingHorizontal: 12, paddingTop: 8 }}>
      <Button theme={theme} compact={touch} icon="Maximize2" title="Details" accessibilityHint="Opens the large view with the stack, tasks and settings" onPress={() => deps.openLarge(w.id)} />
    </View>
    {sheet && <PrSheet workspace={w} prKey={sheet.key} intent={sheet.intent} theme={theme} compact={touch} browserReady={browser.data?.ready ?? false} onClose={() => setSheet(null)} />}
    <QuestionSheet workspace={w} questionId={question} theme={theme} compact={touch} onClose={() => setQuestion(null)} openAgent={openAgent} />
  </View>;
}

function TrackButton({ workspaceId, theme, touch, refresh }: { workspaceId: string; theme: Theme; touch: boolean; refresh: () => void }) {
  const c = theme.colors;
  const activate = useRpc(activateRpc); const cache = useQueryClient(); const toast = useToast();
  const start = useMutation({ mutationFn: () => activate({ workspaceId }), onSuccess: () => {
    toast.show("Tracking this workspace", { variant: "success" }); refresh();
    void cache.invalidateQueries({ queryKey: workspaceKey(workspaceId) }); void cache.invalidateQueries({ queryKey: overviewKey });
  }, onError: e => toast.error(errorText(e)) });
  return <View style={{ gap: 6, paddingVertical: 4 }}>
    <Text style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 17 }}>Not tracked. Tracking follows this workspace's PR stack and gathers repairs for its main agent.</Text>
    <Button theme={theme} compact={touch} icon="Plus" title="Track this workspace" loading={start.isPending} onPress={() => start.mutate()} />
  </View>;
}
