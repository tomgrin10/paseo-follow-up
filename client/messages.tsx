import { useState } from "react";
import { View } from "react-native";
import { Pressable, Text } from "./text";
import { Icon, Modal, useToast } from "@getpaseo/plugin/client/ui";
import { useRpc } from "@getpaseo/plugin/client";
import { useQueryClient } from "@tanstack/react-query";
import type { Workspace } from "../shared/model";
import { controlRpc, sendRpc } from "../shared/contracts";
import { messageStrip, repairRows, shortTitle, type MessageStrip, type RepairRow } from "../shared/task-rows";
import { SETTLE_REASON } from "../shared/send-decision";
import { Button, Card, Chip, Switch, text, type Theme } from "./kit";
import { usePagedList } from "./paged-list";
import { tint } from "./theme";
import type { Colors } from "./theme";
import { RichText } from "./rich-text";

// The send queue: what Follow-up sends the main agent next, or just sent, and the PR repairs it carries (invariant
// tasks-are-the-agent-s). It used to be the first rows of Tasks; it is Follow-up's message, not the agent's to-do list,
// so it has its own card, shown only while a message is queued or out, or a repair waits.

/** The one-line hint under a repair's Auto-send switch (the approved mock). */
const AUTO_OFF_HINT = "Off: it stays here for you";
/** "14:32": a time on this device's clock. */
const clock = (iso: string | null | undefined) => iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";

/** The status column reads one way for every task: dashed ring = queued, send glyph = sent (accent while the agent works on it). Never Running's spinner (Q51). */
export function DeliveryGlyph({ state, w, colors }: { state: "queued" | "sent"; w: Workspace; colors: Colors }) {
  if (state === "sent") return <Icon name="Send" size={13} color={w.runtimeBusy ? colors.accent : colors.foregroundMuted} />;
  return <Icon name="CircleDashed" size={14} color={colors.foregroundMuted} />;
}

/** The strip's one line: who, how many, and when and why (Queued), or when it went out and what Follow-up waits for (Sent). */
export function stripLine(s: MessageStrip): { lead: string; rest: string } {
  if (s.phase === "sent") return { lead: `Sent to ${s.to}`, rest: `${s.at ? ` at ${clock(s.at)}` : ""} · ${s.what} · ${s.reason}` };
  return { lead: `Next message to ${s.to}`, rest: ` · ${s.what} · ${s.reason === SETTLE_REASON && s.at ? `sends at ${clock(s.at)} · ` : ""}${s.reason}` };
}

/** Always the first row of Tasks while a message is queued or out. Preview and Send now are quiet; the normal case needs no click. */
function StripRow({ strip, w, theme, compact, onPreview, openAgent }: { strip: MessageStrip; w: Workspace; theme: Theme; compact: boolean; onPreview: () => void; openAgent?: (agentId: string) => void }) {
  const c = theme.colors; const t = text(c, compact);
  const send = useRpc(sendRpc); const cache = useQueryClient(); const toast = useToast();
  const [busy, setBusy] = useState(false);
  const line = stripLine(strip);
  const sendNow = async () => {
    setBusy(true);
    try {
      const result = await send({ workspaceId: w.id, batchId: strip.batchId });
      const b = result.batches.find(x => x.id === strip.batchId);
      toast.show(!b || ["sent", "sending", "completed"].includes(b.state) ? `Sent to ${strip.to}` : b.state === "pending" ? "Queued. It goes out when the main agent is free." : b.result || "The message couldn't be sent.", { variant: !b || ["sent", "sending", "completed"].includes(b.state) ? "success" : "info" });
    } catch (error) { toast.error(error instanceof Error ? error.message : "The message couldn't be sent."); }
    finally { setBusy(false); void cache.invalidateQueries(); }
  };
  // The why is the point of the row (a-repair-goes-to-a-free-main-agent): it keeps a readable width, and the buttons
  // wrap under it in a narrow panel instead of squeezing it into a column.
  return <View accessibilityRole="summary" style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8, rowGap: 8, paddingHorizontal: compact ? 14 : 12, paddingVertical: compact ? 12 : 8, borderTopWidth: 1, borderTopColor: c.border, backgroundColor: c.surface1 }}>
    <Text style={[t.meta, { flexGrow: 1, flexShrink: 1, flexBasis: compact ? "80%" : 240, minWidth: 0 }]}><Text style={{ color: c.foreground, fontWeight: "500" }}>{line.lead}</Text>{line.rest}</Text>
    <View style={{ flexDirection: "row", gap: 8, marginLeft: "auto" }}>
      {strip.phase === "queued" && <Button theme={theme} compact={compact} title="Preview" accessibilityLabel={`Preview the next message to ${strip.to}`} onPress={onPreview} />}
      {strip.phase === "queued" && strip.sendNow && <Button theme={theme} compact={compact} title="Send now" accessibilityLabel={`Send ${strip.what} to ${strip.to} now`} loading={busy} disabled={busy} onPress={() => void sendNow()} />}
      {strip.phase === "sent" && openAgent && <Button theme={theme} compact={compact} title="Open agent" accessibilityLabel={`Open ${strip.to}`} onPress={() => openAgent(strip.recipientId)} />}
    </View>
  </View>;
}

/** The message's exact text, with this task's line marked when there is one. */
function MessageText({ text: body, highlight, theme }: { text: string; highlight?: string; theme: Theme }) {
  const c = theme.colors;
  return <View style={{ borderRadius: 8, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface1, paddingHorizontal: 12, paddingVertical: 10, gap: 2 }}>
    {body.split("\n").map((line, i) => <Text key={i} selectable style={{ fontFamily: "monospace", fontSize: 12, lineHeight: 17, color: c.foreground, borderRadius: 3, ...(highlight && line.endsWith(highlight) ? { backgroundColor: tint(c.accent, c) } : {}) }}>{line}</Text>)}
  </View>;
}

function PreviewSheet({ open, w, strip, theme, compact, onClose }: { open: boolean; w: Workspace; strip: MessageStrip | null; theme: Theme; compact: boolean; onClose: () => void }) {
  const t = text(theme.colors, compact);
  return <Modal title="Next message" icon={<Icon name="Send" size={18} color={theme.colors.foreground} />} open={open} onOpenChange={next => { if (!next) onClose(); }}>
    <Modal.Content contentContainerStyle={{ padding: compact ? 16 : 20, gap: 12 }}>
      {strip && <Text style={t.meta}>{stripLine(strip).lead}{stripLine(strip).rest}</Text>}
      <MessageText text={w.nextMessage ?? ""} theme={theme} />
    </Modal.Content>
  </Modal>;
}

const chipColor = (r: RepairRow, c: Colors) => r.state === "done" ? c.foregroundMuted : r.task.kind === "review" ? c.statusWarning : r.task.kind === "restack" ? c.foregroundMuted : c.statusDanger;

function RepairGlyph({ row, w, colors }: { row: RepairRow; w: Workspace; colors: Colors }) {
  if (row.state === "done") return <Icon name="Check" size={14} color={colors.statusSuccess} />;
  if (row.state === "capped") return <Icon name="CircleAlert" size={14} color={colors.statusWarning} />;
  if (row.state === "person") return <Icon name="UserRound" size={14} color={colors.statusWarning} />;
  if (row.state === "manual") return <View style={{ width: 14, height: 14, alignItems: "center", justifyContent: "center" }}><View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: colors.foregroundMuted, opacity: 0.6 }} /></View>;
  return <DeliveryGlyph state={row.state} w={w} colors={colors} />;
}

/** A repair Follow-up found on a PR: status glyph, title, PR chip and one state. */
function RepairTaskRow({ row, w, theme, compact, onOpen }: { row: RepairRow; w: Workspace; theme: Theme; compact: boolean; onOpen: () => void }) {
  const c = theme.colors; const t = text(c);
  const label = row.state === "done" && row.at ? `${row.text} ${clock(row.at)}` : row.text;
  return <Pressable accessibilityRole="button" accessibilityLabel={`Repair: ${row.task.title}. ${label}. Open details`} onPress={onOpen}
    style={state => ({ flexDirection: "row", gap: 10, paddingHorizontal: 12, paddingVertical: 9, minHeight: compact ? 52 : 44, borderTopWidth: 1, borderTopColor: c.border, backgroundColor: state.pressed ? c.surface2 : (state as { hovered?: boolean }).hovered ? c.surface1 : "transparent" })}>
    <View style={{ width: 16, paddingTop: 2, alignItems: "center" }}><RepairGlyph row={row} w={w} colors={c} /></View>
    <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
      <RichText plain numberOfLines={3} style={[t.body, row.state === "done" ? { color: c.foregroundMuted } : null]}>{repairTitle(row)}</RichText>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
        <Chip theme={theme} label={row.pr} color={chipColor(row, c)} />
        <Text style={[t.meta, row.state === "capped" || row.state === "person" ? { color: c.statusWarning } : null, { fontVariant: ["tabular-nums"] }]}>{label}</Text>
      </View>
    </View>
    <View style={{ paddingTop: 2 }}><Icon name="ChevronRight" size={14} color={c.foregroundMuted} /></View>
  </Pressable>;
}

/** The task's title without the PR it names: the chip carries the PR. */
const repairTitle = (row: RepairRow) => shortTitle(row.task);

function RepairSheet({ row, w, strip, theme, compact, onClose }: { row: RepairRow | null; w: Workspace; strip: MessageStrip | null; theme: Theme; compact: boolean; onClose: () => void }) {
  const c = theme.colors; const t = text(c, compact);
  const control = useRpc(controlRpc); const cache = useQueryClient(); const toast = useToast();
  const [saving, setSaving] = useState(false);
  const manual = !!row && (w.manualTasks ?? []).includes(row.task.key);
  const setAuto = async (auto: boolean) => {
    if (!row) return;
    setSaving(true);
    try { await control({ workspaceId: w.id, taskAuto: { key: row.task.key, auto } }); toast.show(auto ? "Follow-up sends this repair" : "This repair stays with you"); }
    catch (error) { toast.error(error instanceof Error ? error.message : "Couldn't change Auto-send for this repair."); }
    finally { setSaving(false); void cache.invalidateQueries(); }
  };
  const where = row?.state === "queued" && strip?.phase === "queued" ? ` · in the next message to ${strip.to}${strip.reason === SETTLE_REASON && strip.at ? `, at ${clock(strip.at)}` : ""}` : row?.state === "sent" && strip?.phase === "sent" ? ` · ${stripLine(strip).lead.toLowerCase()}${strip.at ? ` at ${clock(strip.at)}` : ""}` : "";
  return <Modal title="Repair" icon={<Icon name="Wrench" size={18} color={c.foreground} />} open={!!row} onOpenChange={next => { if (!next) onClose(); }}>
    <Modal.Content contentContainerStyle={{ padding: compact ? 16 : 20, gap: 14 }}>
      {row && <>
        <View style={{ gap: 6 }}>
          <RichText selectable style={[t.title, { fontSize: 16, lineHeight: 22 }]}>{repairTitle(row)}</RichText>
          <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
            <Chip theme={theme} label={row.pr} color={chipColor(row, c)} />
            <Text style={t.meta}>{row.text}{where}</Text>
          </View>
        </View>
        {row.state !== "done" && row.state !== "sent" && <View style={{ paddingTop: 12, gap: 4, borderTopWidth: 1, borderTopColor: c.border }}>
          <Switch theme={theme} compact={compact} label="Auto-send" value={!manual} disabled={saving} accessibilityLabel={`Auto-send ${row.task.title}`}
            hint={`Follow-up sends this to ${strip?.to ?? w.mainAgentTitle ?? "the main agent"}. ${AUTO_OFF_HINT}.`} onChange={next => void setAuto(next)} />
          <Text style={t.meta}>{AUTO_OFF_HINT}</Text>
        </View>}
        {row.state === "queued" && !!w.nextMessage && <View style={{ gap: 6 }}>
          <Text style={t.label}>Next message</Text>
          <MessageText text={w.nextMessage} highlight={row.task.title} theme={theme} />
        </View>}
      </>}
    </Modal.Content>
  </Modal>;
}

/** The Messages to the agent card: the strip (who, how many, when and why; Preview, Send now, Open agent) and the open repairs. */
export function MessagesCard({ workspace: w, theme, compact, openAgent, now = Date.now() }: { workspace: Workspace; theme: Theme; compact: boolean; openAgent?: (agentId: string) => void; now?: number }) {
  const [repair, setRepair] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);
  const strip = messageStrip(w, now);
  const repairs = repairRows(w);
  // A broken stack can hold hundreds of repairs: page them (client/paged-list.tsx), the strip stays on top.
  const page = usePagedList({ items: repairs.open, theme, compact, noun: "repairs" });
  if (!strip && !repairs.open.length) return null;
  const repairRow = repairs.open.find(r => r.task.key === repair) ?? null;
  // The card's title and icon say what it is; the strip under it says to whom, how many, when and why.
  return <Card theme={theme} compact={compact} icon="Send" title="Messages to the agent">
    {strip && <StripRow strip={strip} w={w} theme={theme} compact={compact} onPreview={() => setPreview(true)} openAgent={openAgent} />}
    {page.shown.map(r => <RepairTaskRow key={r.task.key} row={r} w={w} theme={theme} compact={compact} onOpen={() => setRepair(r.task.key)} />)}
    {page.footer}
    <RepairSheet row={repairRow} w={w} strip={strip} theme={theme} compact={compact} onClose={() => setRepair(null)} />
    <PreviewSheet open={preview} w={w} strip={strip} theme={theme} compact={compact} onClose={() => setPreview(false)} />
  </Card>;
}
