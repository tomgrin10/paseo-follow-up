import { useEffect } from "react";
import { Platform, Text, View } from "react-native";
import { useRpc, type PluginScreenProps } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { getRpc } from "../shared/contracts";
import { Button, Card, CardRow, errorText, text } from "./kit";
import { Skeleton } from "./motion";
import { WorkspaceView, useSessionFolds, workspaceKey, type PanelLinks } from "./panel";

export const LARGE_SCREEN = "follow-through-workspace";

/**
 * The panel opened as a Paseo screen: the host supplies the page, header and close button, and the
 * layout switches to two columns. Collapse (or Esc) returns to the workspace, where the panel still is.
 */
export function FollowLarge(props: PluginScreenProps & PanelLinks) {
  const { theme, layout, params, navigation } = props;
  const workspaceId = params.workspaceId ?? "";
  const c = theme.colors;
  const read = useRpc(getRpc);
  const query = useQuery({ queryKey: workspaceKey(workspaceId), queryFn: () => read({ workspaceId }), refetchInterval: 5000, enabled: !!workspaceId });
  const folds = useSessionFolds(workspaceId);
  const back = () => navigation?.openWorkspace({ workspaceId });

  // Esc goes back, unless a sheet or menu has focus or the user is typing. Web only: native has its own back.
  useEffect(() => {
    type Key = { key: string; defaultPrevented: boolean; metaKey: boolean; ctrlKey: boolean; altKey: boolean; target: { isContentEditable?: boolean; tagName?: string } | null; preventDefault(): void };
    type Doc = { addEventListener(type: "keydown", fn: (event: Key) => void): void; removeEventListener(type: "keydown", fn: (event: Key) => void): void; querySelector(selector: string): unknown };
    const doc = (globalThis as { document?: Doc }).document;
    if (Platform.OS !== "web" || !doc || !navigation) return;
    const onKey = (event: Key) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.target && (event.target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(event.target.tagName ?? ""))) return;
      if (doc.querySelector('[role="dialog"], [aria-modal="true"]')) return;
      event.preventDefault();
      navigation.openWorkspace({ workspaceId });
    };
    doc.addEventListener("keydown", onKey);
    return () => doc.removeEventListener("keydown", onKey);
  }, [navigation, workspaceId]);

  if (query.isPending && workspaceId) return <View accessibilityLabel="Loading Follow-up" style={{ flex: 1, backgroundColor: c.surface0, padding: 24, gap: 12, maxWidth: 1240, width: "100%", alignSelf: "center" }}>
    <Skeleton width="30%" height={16} color={c.surface2} /><Skeleton width="60%" height={10} color={c.surface2} /><Skeleton width="100%" height={6} color={c.surface2} radius={3} />
  </View>;
  const w = query.data?.workspace;
  if (!w) return <View style={{ flex: 1, backgroundColor: c.surface0, padding: layout.compact ? 16 : 24 }}>
    <Card theme={theme} compact={layout.compact} icon="GitPullRequest" title="Nothing to show here" style={{ marginHorizontal: 0, marginTop: 0, maxWidth: 520 }}>
      <CardRow theme={theme}>
        <Text style={[text(c).meta, { marginBottom: 10 }]}>{query.error ? `Couldn't read Follow-up: ${errorText(query.error)}` : "This workspace isn't tracked by Follow-up, or it no longer exists."}</Text>
        {navigation && workspaceId ? <Button theme={theme} icon="ArrowLeft" title="Back to the workspace" onPress={back} /> : null}
      </CardRow>
    </Card>
  </View>;
  return <WorkspaceView theme={theme} layout={layout} host={props.host} navigation={navigation} workspace={w} large
    loadError={query.error ? "Refresh failed. Showing the last saved state." : query.data?.error ?? null}
    openSettings={props.openSettings} openOverview={props.openOverview} folds={folds}
    resize={navigation ? { icon: "Minimize2", label: "Back to the workspace (Esc)", onPress: back } : null} />;
}
