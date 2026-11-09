import { useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import type { PluginClientContext, PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Icon, ScrollView } from "@getpaseo/plugin/client/ui";
import { answerCardSchema, batchCardSchema, followShellCall, followToolName, parseBatchPrompt, readText, toolRow, toolRowSchema, type AnswerCard, type BatchCard, type ToolRow } from "../shared/chat";
import { parseAnswerMessage, parseAnswersMessage } from "../shared/questions";
import { Reveal } from "./motion";
import { tint, withAlpha } from "./theme";

const mono = () => (Platform.OS === "ios" ? "Menlo" : "monospace");
const TOOL_KIND = "tool-row";
const BATCH_KIND = "batch-card";
const ANSWER_KIND = "answer-card";
const TOOL_ICON: Partial<Record<ToolRow["tool"], string>> = { ask_question: "MessageCircleQuestion", record_answer: "MessageCircleReply", withdraw_question: "MessageCircleOff", set_spec: "FileText" };

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

/** Expandable full text below a row, scrolling on its own so long output never moves the chat. */
function Expanded({ text, color, border }: { text: string; color: string; border: string }) {
  return <View style={{ borderWidth: 1, borderTopWidth: 0, borderColor: border, borderBottomLeftRadius: 8, borderBottomRightRadius: 8, overflow: "hidden" }}>
    <ScrollView style={[{ maxHeight: 300 }, Platform.OS === "web" ? ({ overscrollBehavior: "contain" } as object) : null]} contentContainerStyle={{ paddingHorizontal: 12, paddingVertical: 8 }}>
      <Text selectable style={{ color, fontFamily: mono(), fontSize: 12, lineHeight: 18 }}>{text}</Text>
    </ScrollView>
  </View>;
}

/** Follow-up's own tool calls as one quiet line, sized like Paseo's tool rows; press to read the result. */
function ToolRowView({ item, theme }: PluginTimelineItemProps<ToolRow>) {
  const c = theme.colors;
  const row = item.data;
  const [expanded, setExpanded] = useState(false);
  const [hovered, setHovered] = useState(false);
  if (row.done) return <DoneCard summary={row.done.summary} theme={theme} />;
  const color = row.tone === "danger" ? c.statusDanger : row.tone === "warning" ? c.statusWarning : row.tone === "success" ? c.statusSuccess : c.foregroundMuted;
  const openable = row.more !== null;
  const active = openable && (hovered || expanded);
  const open = expanded && openable;
  return <View style={{ marginHorizontal: -13 }}>
    <Pressable disabled={!openable} onPress={() => setExpanded(v => !v)} onHoverIn={() => setHovered(true)} onHoverOut={() => setHovered(false)}
      accessibilityRole={openable ? "button" : undefined} aria-expanded={openable ? expanded : undefined} aria-busy={row.state === "running"}
      style={{ flexDirection: "row", alignItems: "center", borderRadius: 8, borderWidth: 1, borderColor: open ? c.border : "transparent", borderBottomLeftRadius: open ? 0 : 8, borderBottomRightRadius: open ? 0 : 8, backgroundColor: open ? c.surface1 : "transparent", paddingHorizontal: 8, paddingVertical: 4 }}>
      <View style={{ width: 22, height: 22, marginRight: 4, alignItems: "center", justifyContent: "center" }}>
        {active ? <View style={{ transform: [{ rotate: expanded ? "90deg" : "0deg" }] }}><Icon name="ChevronRight" size={14} color={c.foreground} /></View>
          : <Icon name={row.state === "failed" ? "TriangleAlert" : TOOL_ICON[row.tool] ?? (row.tone === "warning" ? "CircleAlert" : "GitPullRequest")} size={12} color={row.tone === "muted" ? c.foregroundMuted : color} />}
      </View>
      <Text numberOfLines={1} style={{ flexShrink: 1, fontSize: 14, color: row.tone === "muted" ? (active || row.state === "running" ? c.foreground : c.foregroundMuted) : color, opacity: row.state === "running" ? 0.72 : 1 }}>{row.line}</Text>
    </Pressable>
    {open && <Expanded text={row.more!} color={row.state === "failed" ? c.statusDanger : c.foreground} border={c.border} />}
  </View>;
}

/** The agent declared the workspace done: the one row in the chat that is allowed to be a little proud. */
function DoneCard({ summary, theme }: { summary: string; theme: PluginTimelineItemProps["theme"] }) {
  const c = theme.colors;
  return <Reveal>
    <View accessibilityRole="summary" style={{ flexDirection: "row", gap: 12, padding: 12, borderRadius: 10, backgroundColor: tint(c.statusSuccess, c), borderWidth: 1, borderColor: withAlpha(c.statusSuccess, 0.35), marginVertical: 4 }}>
      <View style={{ width: 28, height: 28, borderRadius: 14, alignItems: "center", justifyContent: "center", backgroundColor: c.statusSuccess }}><Icon name="Check" size={16} color={c.surface0} /></View>
      <View style={{ flex: 1, gap: 3 }}>
        <Text style={{ color: c.foreground, fontSize: 14, lineHeight: 19, fontWeight: "600" }}>Workspace done</Text>
        {!!summary && <Text selectable style={{ color: c.foreground, fontSize: 13, lineHeight: 19 }}>{summary}</Text>}
        <Text style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 17 }}>Follow-up checked every PR and task. Archive the workspace when you're ready.</Text>
      </View>
    </View>
  </Reveal>;
}

/** A repair batch Follow-up sent, as a card instead of a raw prompt bubble. */
function BatchCardView({ item, theme }: PluginTimelineItemProps<BatchCard>) {
  const c = theme.colors;
  const card = item.data;
  const [expanded, setExpanded] = useState(false);
  const recovery = card.kind === "recovery";
  return <View style={{ alignSelf: "flex-end", width: "100%", maxWidth: 560, marginVertical: 4 }}>
    <View style={{ borderRadius: 10, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface1, overflow: "hidden" }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingTop: 10, paddingBottom: recovery ? 10 : 6 }}>
        <Icon name={recovery ? "History" : "Wrench"} size={14} color={c.foregroundMuted} />
        <Text style={{ flex: 1, color: c.foreground, fontSize: 13, lineHeight: 18, fontWeight: "600" }}>{recovery ? "Follow-up recovery brief" : `Follow-up sent ${card.tasks.length} repair${card.tasks.length === 1 ? "" : "s"}`}</Text>
        <Pressable accessibilityRole="button" aria-expanded={expanded} accessibilityLabel={expanded ? "Hide the full message" : "Show the full message"} onPress={() => setExpanded(v => !v)} hitSlop={6}
          style={state => ({ paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, backgroundColor: state.pressed ? c.surface2 : "transparent" })}>
          <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{expanded ? "Hide" : "Full message"}</Text>
        </Pressable>
      </View>
      {!recovery && <View style={{ paddingHorizontal: 12, paddingBottom: 10, gap: 3 }}>
        {card.tasks.map((task, i) => <View key={i} style={{ flexDirection: "row", gap: 6 }}>
          <Text style={{ width: 18, color: c.foregroundMuted, fontSize: 13, lineHeight: 19, fontVariant: ["tabular-nums"] }}>{i + 1}.</Text>
          <Text selectable style={{ flex: 1, color: c.foreground, fontSize: 13, lineHeight: 19 }}>{task}</Text>
        </View>)}
      </View>}
      {expanded && <View style={{ borderTopWidth: 1, borderTopColor: c.border }}>
        <ScrollView style={[{ maxHeight: 300 }, Platform.OS === "web" ? ({ overscrollBehavior: "contain" } as object) : null]} contentContainerStyle={{ padding: 12 }}>
          <Text selectable style={{ color: c.foregroundMuted, fontFamily: mono(), fontSize: 12, lineHeight: 18 }}>{card.text}</Text>
        </ScrollView>
      </View>}
    </View>
  </View>;
}

/** The developer's answer, sent from Follow-up: the question, the choice and their note. */
function AnswerCardView({ item, theme }: PluginTimelineItemProps<AnswerCard>) {
  const c = theme.colors;
  const card = item.data;
  const [expanded, setExpanded] = useState(false);
  return <View style={{ alignSelf: "flex-end", width: "100%", maxWidth: 560, marginVertical: 4 }}>
    <View style={{ borderRadius: 10, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface1, overflow: "hidden" }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingTop: 10, paddingBottom: 6 }}>
        <Icon name="MessageCircleReply" size={14} color={c.statusSuccess} />
        <Text numberOfLines={card.answers ? 2 : 1} style={{ flex: 1, color: c.foreground, fontSize: 13, lineHeight: 18, fontWeight: "600" }}>{card.answers ? `Your answers · ${card.title}` : <>Your answer{/^D\d+$/.test(card.id) ? "" : ` to ${card.id}`} · {card.title}</>}</Text>
        <Pressable accessibilityRole="button" aria-expanded={expanded} accessibilityLabel={expanded ? "Hide the full message" : "Show the full message"} onPress={() => setExpanded(v => !v)} hitSlop={6}
          style={state => ({ paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, backgroundColor: state.pressed ? c.surface2 : "transparent" })}>
          <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{expanded ? "Hide" : "Full message"}</Text>
        </Pressable>
      </View>
      {card.answers ? <View style={{ paddingHorizontal: 12, paddingBottom: 10, gap: 8 }}>
        {/* Each answer sits under the question it answers, so the chat says what was decided without scrolling back. */}
        {card.answers.map((a, i) => <View key={a.id} style={{ gap: 1 }}>
          {!!a.question && <Text style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 16 }}>{i + 1}. {a.question}</Text>}
          <Text selectable style={{ color: a.choice ? c.foreground : c.foregroundMuted, fontSize: 13, lineHeight: 19 }}>{a.choice ? <><Text style={{ fontWeight: "600" }}>{a.choice}</Text>{a.label ? ` · ${a.label}` : ""}</> : "Skipped · still open"}</Text>
        </View>)}
      </View> : <View style={{ paddingHorizontal: 12, paddingBottom: 10, gap: 3 }}>
        <Text selectable style={{ color: c.foreground, fontSize: 13, lineHeight: 19 }}><Text style={{ fontWeight: "600", fontVariant: ["tabular-nums"] }}>{card.choice}</Text>{card.label ? ` · ${card.label}` : ""}</Text>
        {!!card.words && <Text selectable style={{ color: c.foregroundMuted, fontSize: 13, lineHeight: 19 }}>{card.words}</Text>}
      </View>}
      {expanded && <View style={{ borderTopWidth: 1, borderTopColor: c.border }}>
        <ScrollView style={[{ maxHeight: 300 }, Platform.OS === "web" ? ({ overscrollBehavior: "contain" } as object) : null]} contentContainerStyle={{ padding: 12 }}>
          <Text selectable style={{ color: c.foregroundMuted, fontFamily: mono(), fontSize: 12, lineHeight: 18 }}>{card.text}</Text>
        </ScrollView>
      </View>}
    </View>
  </View>;
}

export function contributeChat(client: PluginClientContext) {
  const removers = [
    client.addTimelineTransformer({
      id: "follow-tool-calls", query: { itemType: "tool_call" },
      transform({ item }) {
        const detail: unknown = item.detail;
        let tool = followToolName(item.name);
        let input: Record<string, unknown> = {};
        let output: string | undefined;
        if (tool) {
          if (record(detail) && record(detail.input)) input = detail.input;
          output = record(detail) && "output" in detail ? readText(detail.output) : undefined;
        } else if (record(detail) && detail.type === "shell" && typeof detail.command === "string") {
          const call = followShellCall(detail.command);
          if (!call) return undefined;
          tool = call.tool; input = call.input; output = typeof detail.output === "string" ? detail.output : undefined;
        } else return undefined;
        const error = item.status === "failed" ? readText(item.error) ?? "" : undefined;
        if (item.status === "completed" && record(detail) && record(detail.output) && detail.output.isError === true)
          return { items: [{ type: "plugin" as const, kind: TOOL_KIND, version: 1, data: toolRow(tool, "failed", input, undefined, output) }] };
        return { items: [{ type: "plugin" as const, kind: TOOL_KIND, version: 1, data: toolRow(tool, item.status, input, output, error) }] };
      },
    }),
    client.addTimelineTransformer({
      id: "follow-batch-prompts", query: { itemType: "user_message" },
      transform({ item }) {
        const several = parseAnswersMessage(item.text);
        if (several) return { items: [{ type: "plugin" as const, kind: ANSWER_KIND, version: 1, data: { id: several.answers.map(a => a.id).join(", "), title: several.title, choice: "", label: null, words: null, text: item.text, answers: several.answers } }] };
        const answer = parseAnswerMessage(item.text);
        if (answer) return { items: [{ type: "plugin" as const, kind: ANSWER_KIND, version: 1, data: { ...answer, text: item.text } }] };
        const card = parseBatchPrompt(item.text);
        return card ? { items: [{ type: "plugin" as const, kind: BATCH_KIND, version: 1, data: card }] } : undefined;
      },
    }),
    client.addTimelineRenderer({ kind: TOOL_KIND, version: 1, schema: toolRowSchema, Component: ToolRowView }),
    client.addTimelineRenderer({ kind: BATCH_KIND, version: 1, schema: batchCardSchema, Component: BatchCardView }),
    client.addTimelineRenderer({ kind: ANSWER_KIND, version: 1, schema: answerCardSchema, Component: AnswerCardView }),
  ];
  return () => { for (const remove of removers) void remove(); };
}
