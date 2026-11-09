import { Text, View } from "react-native";
import { Icon, useToast } from "@getpaseo/plugin/client/ui";
import { useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { checkPrActionRpc, controlRpc, sendRpc } from "../shared/contracts";
import { needsYou, shortRefs, type NeedItem } from "../shared/attention";
import { sameText } from "../shared/home";
import type { Workspace } from "../shared/model";
import { Button, Card, CardRow, errorText, text, type Theme } from "./kit";
import { withAlpha, type Colors } from "./theme";
import { meanwhile } from "./questions";
import { useReviewerSettings } from "./reviewers";

import { overviewKey, workspaceKey } from "./keys";
export { overviewKey, workspaceKey };

function glyph(item: NeedItem, colors: Colors): { name: string; color: string } {
  switch (item.kind) {
    case "hold": return { name: "CirclePause", color: colors.statusWarning };
    case "retry": return { name: "OctagonAlert", color: colors.statusDanger };
    case "check": return { name: "CircleHelp", color: colors.statusWarning };
    case "decision": return { name: "MessageCircleQuestion", color: colors.statusWarning };
    case "question": return { name: item.state === "stopped" ? "CirclePause" : "MessageCircleQuestion", color: colors.statusWarning };
    case "answer": return { name: "TriangleAlert", color: colors.statusWarning };
    case "send": return { name: "Send", color: colors.statusWarning };
    case "merge": return { name: "GitMerge", color: colors.statusSuccess };
    case "reviewers": return { name: "UserPlus", color: colors.foregroundMuted };
  }
}

export type NeedActions = {
  openAgent?: (agentId: string) => void;
  openPr?: (prKey: string, intent: "merge" | "reviewers") => void;
  openQuestion?: (questionId: string) => void;
  after?: () => void;
};

/** The developer's queue: one row per decision, each with its single action inline. */
export function NeedsYouList({ workspace: w, theme, compact, actions, now = Date.now(), flush = false, skip = [], feature = false }: { workspace: Workspace; theme: Theme; compact: boolean; actions: NeedActions; now?: number; flush?: boolean; skip?: NeedItem["kind"][]; /** Phones' detail pane: the first question is the screen's ask, an attention card with a full-width Answer. */ feature?: boolean }) {
  const c = theme.colors; const t = text(c, compact);
  useReviewerSettings();
  const toast = useToast();
  const cache = useQueryClient();
  const control = useRpc(controlRpc); const send = useRpc(sendRpc); const check = useRpc(checkPrActionRpc);
  const refresh = () => { void cache.invalidateQueries({ queryKey: workspaceKey(w.id) }); void cache.invalidateQueries({ queryKey: overviewKey }); };
  const fail = (error: Error) => { toast.error(errorText(error)); refresh(); };
  const resume = useMutation({ mutationFn: () => control({ workspaceId: w.id, clearHold: true }), onSuccess: () => { toast.show("Follow-up resumed", { variant: "success" }); refresh(); actions.after?.(); }, onError: fail });
  const retry = useMutation({ mutationFn: (batchId: string) => control({ workspaceId: w.id, retryBatchId: batchId }), onSuccess: () => { toast.show("Repairs queued again"); refresh(); actions.after?.(); }, onError: fail });
  // Say what actually happened to the batch: delivery can be deferred or unconfirmed without an error.
  const deliver = useMutation({ mutationFn: (batchId: string) => send({ workspaceId: w.id, batchId }), onSuccess: (result, batchId) => {
    const b = result.batches.find(x => x.id === batchId);
    if (!b || ["sent", "sending", "completed"].includes(b.state)) toast.show("Sent to the main agent", { variant: "success" });
    else if (b.state === "uncertain") toast.show("Delivery wasn't confirmed. Check the agent before retrying.", { variant: "warning" });
    else if (b.state === "pending") toast.show("Queued. It goes out when the agent is free.", { variant: "info" });
    else toast.error(b.result || "The repairs couldn't be sent.");
    refresh(); actions.after?.();
  }, onError: fail });
  const inspect = useMutation({ mutationFn: (actionId: string) => check({ workspaceId: w.id, actionId }), onSuccess: reply => { toast.show(reply.result, { variant: reply.state === "failed" ? "warning" : "info" }); refresh(); }, onError: fail });
  const items = needsYou(w, now).filter(item => !skip.includes(item.kind));
  if (!items.length) return null;
  const busy = resume.isPending || retry.isPending || deliver.isPending || inspect.isPending;
  const openMain = actions.openAgent ? () => actions.openAgent!(w.mainAgentId) : undefined;
  const action = (item: NeedItem) => {
    switch (item.kind) {
      case "hold": return <Button theme={theme} compact={compact} kind="primary" icon="Play" title="Resume follow-up" loading={resume.isPending} disabled={busy} onPress={() => resume.mutate()} />;
      case "retry": return item.exhausted
        ? openMain && <Button theme={theme} compact={compact} icon="MessageSquare" title="Open main agent" onPress={openMain} />
        : <>
          <Button theme={theme} compact={compact} icon="RotateCcw" title="Retry" accessibilityLabel="Queue the repairs again" loading={retry.isPending} disabled={busy} onPress={() => retry.mutate(item.batchId)} />
          {openMain && <Button theme={theme} compact={compact} kind="ghost" icon="MessageSquare" title="Open agent" accessibilityLabel="Open main agent" onPress={openMain} />}
        </>;
      case "check": return <Button theme={theme} compact={compact} icon="RefreshCw" title="Check state" loading={inspect.isPending} disabled={busy} onPress={() => inspect.mutate(item.actionId)} />;
      case "decision": return openMain && <Button theme={theme} compact={compact} icon="MessageSquare" title="Answer in chat" onPress={openMain} />;
      case "question": return actions.openQuestion && <Button theme={theme} compact={compact} icon="MessageCircleReply" title="Answer" accessibilityLabel={`Answer ${item.title}`} onPress={() => actions.openQuestion!(item.questionId)} />;
      case "answer": return actions.openQuestion && <Button theme={theme} compact={compact} icon="Eye" title="Check" accessibilityLabel={`Check the ${item.questionId} answer`} onPress={() => actions.openQuestion!(item.questionId)} />;
      case "send": return <Button theme={theme} compact={compact} kind="primary" icon="Send" title="Send to main agent" accessibilityLabel={`Send ${item.tasks.length} repairs to the main agent`} loading={deliver.isPending} disabled={busy || !!item.blocker} onPress={() => deliver.mutate(item.batchId)} />;
      case "merge": return actions.openPr && <Button theme={theme} compact={compact} icon="GitMerge" title={`Merge #${item.number}`} accessibilityLabel={`Review and merge pull request ${item.number}`} onPress={() => actions.openPr!(item.prKey, "merge")} />;
      case "reviewers": return actions.openPr && <Button theme={theme} compact={compact} icon="UserPlus" title="Add reviewers" onPress={() => actions.openPr!(item.prKey, "reviewers")} />;
    }
  };
  const featured = feature && items[0]?.kind === "question" ? items[0] as Extract<NeedItem, { kind: "question" }> : null;
  return <View style={featured ? { gap: 12 } : undefined}>
    {featured && <View accessibilityRole="summary" style={{ borderRadius: 10, borderWidth: 1, borderColor: withAlpha(c.statusWarning, 0.7), padding: 14, gap: 6 }}>
      <View style={{ flexDirection: "row", gap: 10 }}>
        <View style={{ paddingTop: 3 }}><Icon name={glyph(featured, c).name} size={16} color={c.statusWarning} /></View>
        <View style={{ flex: 1, minWidth: 0, gap: 6 }}>
          <Text accessibilityRole="header" style={t.ask}>{featured.title}</Text>
          {!!featured.detail && !sameText(featured.detail, featured.title.replace(/^Q\d+ · /, "")) && <Text numberOfLines={2} style={[t.body, { color: c.foregroundMuted }]}>{featured.detail}</Text>}
          <QuestionState workspace={w} questionId={featured.questionId} theme={theme} />
        </View>
      </View>
      {actions.openQuestion && <View style={{ marginTop: 6 }}><Button theme={theme} compact grow kind="primary" icon="MessageCircleReply" title={`Answer ${featured.questionId}`} accessibilityLabel={`Answer ${featured.title}`} onPress={() => actions.openQuestion!(featured.questionId)} /></View>}
    </View>}
    <View>
    {items.filter(item => item !== featured).map((item, index) => {
      const g = glyph(item, c);
      const button = action(item);
      // Phones: the action sits at the row's right edge so rows never grow a second line of controls. A send batch
      // (the primary, with its task list) and Retry's pair keep their buttons full width under the row.
      const inline = compact && button && item.kind !== "send" && !(item.kind === "retry" && !item.exhausted);
      if (inline) return <CardRow key={item.key} theme={theme} compact first={index === 0 && flush} style={flush ? { paddingHorizontal: 0 } : undefined}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <Icon name={g.name} size={16} color={g.color} />
          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
            <Text numberOfLines={2} style={t.label}>{item.title}</Text>
            {"detail" in item && !!item.detail && !sameText(item.detail, item.title.replace(/^Q\d+ · /, "")) && <Text numberOfLines={1} style={t.meta}>{item.detail}</Text>}
          </View>
          {button}
        </View>
      </CardRow>;
      return <CardRow key={item.key} theme={theme} compact={compact} first={index === 0 && flush} style={flush ? { paddingHorizontal: 0 } : undefined}>
        <View style={{ flexDirection: "row", gap: 9 }}>
          <View style={{ paddingTop: 2 }}><Icon name={g.name} size={14} color={g.color} /></View>
          <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
            <Text style={compact ? t.label : t.body}>{item.title}</Text>
            {"detail" in item && !!item.detail && !sameText(item.detail, item.title.replace(/^Q\d+ · /, "")) && <Text numberOfLines={item.kind === "question" ? 2 : 3} style={t.meta}>{item.detail}</Text>}
            {item.kind === "question" && <QuestionState workspace={w} questionId={item.questionId} theme={theme} />}
            {item.kind === "send" && <View style={{ gap: 2 }}>
              {item.tasks.slice(0, 4).map((task, i) => <Text key={i} numberOfLines={2} style={t.meta}><Text style={{ fontVariant: ["tabular-nums"] }}>{`${i + 1}. `}</Text>{shortRefs(task, w)}</Text>)}
              {item.tasks.length > 4 && <Text style={t.meta}>{`and ${item.tasks.length - 4} more`}</Text>}
            </View>}
            {(button || (item.kind === "send" && item.blocker)) && <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8, marginTop: 5 }}>
              {button}
              {item.kind === "send" && item.blocker && <Text style={[t.small, { flexShrink: 1 }]}>{item.blocker}</Text>}
            </View>}
          </View>
        </View>
      </CardRow>;
    })}
    </View>
  </View>;
}

function QuestionState({ workspace: w, questionId, theme }: { workspace: Workspace; questionId: string; theme: Theme }) {
  const c = theme.colors;
  const q = w.questions.find(x => x.id === questionId);
  if (!q) return null;
  const state = meanwhile(w, q);
  return <View style={{ flexDirection: "row", gap: 5 }}>
    <View style={{ paddingTop: 2 }}><Icon name={state.icon} size={11} color={state.color(c)} /></View>
    <Text numberOfLines={4} style={[text(c).small, { flex: 1, color: state.color(c) }]}>{state.text}</Text>
  </View>;
}

export function NeedsYouCard({ workspace, theme, compact, actions, now }: { workspace: Workspace; theme: Theme; compact: boolean; actions: NeedActions; now: number }) {
  const count = needsYou(workspace, now).length;
  if (!count) return null;
  return <Card theme={theme} compact={compact} icon="CircleAlert" title="Needs you" tone="attention" count={count}>
    <NeedsYouList workspace={workspace} theme={theme} compact={compact} actions={actions} now={now} />
  </Card>;
}
