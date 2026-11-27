import { useEffect } from "react";
import { View } from "react-native";
import { type PluginScreenProps } from "@getpaseo/plugin/client";
import { Text } from "./text";
import { Card, CardRow, text } from "./kit";
import { FOLLOW_UP_ICON } from "./follow-up-icon";

/**
 * The retired larger view's screen id (2.x before the workspace view). The main area's `follow-up-view` tab is the
 * large view now (invariant 135), so a saved link or restored route to this screen opens the workspace and its tab.
 * Kept one release, like the `follow-up` panel's two locations.
 */
export const LARGE_SCREEN = "follow-up-workspace";

export function LargeRedirect({ params, navigation, theme, layout, openView }: PluginScreenProps & { openView: (workspaceId: string) => void }) {
  const c = theme.colors;
  const workspaceId = params.workspaceId ?? "";
  useEffect(() => {
    if (!workspaceId) return;
    navigation?.openWorkspace({ workspaceId });
    openView(workspaceId);
  }, [workspaceId]); // eslint-disable-line react-hooks/exhaustive-deps
  return <View style={{ flex: 1, backgroundColor: c.surface0, padding: layout.compact ? 16 : 24 }}>
    {!workspaceId && <Card theme={theme} compact={layout.compact} icon={FOLLOW_UP_ICON} title="Nothing to show here" style={{ marginHorizontal: 0, marginTop: 0, maxWidth: 520 }}>
      <CardRow theme={theme}><Text style={text(c).meta}>This link names no workspace. Open one from Home or the sidebar.</Text></CardRow>
    </Card>}
  </View>;
}
