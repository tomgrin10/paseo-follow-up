import { createContext, useContext, useEffect, useRef } from "react";
import { Animated, Image, Modal as RNModal, Platform, ScrollView, View, useWindowDimensions, type ViewStyle } from "react-native";
import { Icon } from "@getpaseo/plugin/client/ui";
import { Pressable } from "./text";
import { useReducedMotion } from "./motion";
import { fitImage, type ViewedImage } from "../shared/image-fit";
export type { ViewedImage };

/**
 * Seeing a release-notes screenshot larger, inside Paseo: never a browser tab. Paseo's SDK (0.15, 0.16) has no image
 * viewer for plugins, so this one follows the app's own chat lightbox (attachment-lightbox.tsx): a 90% black
 * backdrop, the image fitted to the window, an X in the corner, and a click, Esc or the X closes it.
 */


/**
 * Who shows the viewer. A notes dialog provides it so one viewer sits inside the dialog's own focus scope, and its
 * close (Esc, the backdrop) shuts the viewer first; anywhere else NoteImage shows its own.
 */
export const ImageViewerContext = createContext<((image: ViewedImage, from: unknown) => void) | null>(null);
export const useImageViewer = () => useContext(ImageViewerContext);

/**
 * The viewer. `inline`: drawn in place with fixed positioning (desktop web, inside a dialog whose focus trap and Esc
 * handling must keep working); otherwise in a React Native Modal of its own (phones and the native app).
 */
export function ImageViewer({ image, onClose, inline }: { image: ViewedImage; onClose: () => void; inline: boolean }) {
  const win = useWindowDimensions();
  const { width, height, phone } = fitImage(image, win);
  const close = useRef<View>(null);
  const reduced = useReducedMotion();
  const fade = useRef(new Animated.Value(reduced || !inline ? 1 : 0)).current;
  useEffect(() => {
    if (inline && !reduced) Animated.timing(fade, { toValue: 1, duration: 160, useNativeDriver: Platform.OS !== "web" }).start();
    // Focus lands on the X, so Tab, Enter and screen readers start in the viewer.
    (close.current as unknown as { focus?: () => void } | null)?.focus?.();
  }, [fade, inline, reduced]);
  const zoomable = Platform.OS === "ios";
  const picture = <Image source={{ uri: image.url }} accessibilityLabel={image.label} accessibilityIgnoresInvertColors resizeMode="contain" style={{ width, height, borderRadius: phone ? 0 : 6 }} />;
  const layer = <Animated.View role="dialog" aria-modal aria-label={image.label} accessibilityViewIsModal
    style={[{ position: (inline ? "fixed" : "absolute") as ViewStyle["position"], top: 0, left: 0, right: 0, bottom: 0, zIndex: 1000, alignItems: "center", justifyContent: "center", opacity: fade }]}>
    {/* The backdrop closes on a click anywhere, the image included; it is not a second button for screen readers. */}
    <Pressable accessible={false} focusable={false} importantForAccessibility="no" onPress={onClose} style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: "rgba(0,0,0,0.9)" }} />
    {zoomable
      ? <ScrollView style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }} contentContainerStyle={{ flexGrow: 1, alignItems: "center", justifyContent: "center" }} maximumZoomScale={4} minimumZoomScale={1} centerContent showsHorizontalScrollIndicator={false} showsVerticalScrollIndicator={false}>
        <Pressable accessible={false} onPress={onClose}>{picture}</Pressable>
      </ScrollView>
      : <View pointerEvents="none" style={{ marginTop: phone ? 36 : 0 }}>{picture}</View>}
    <Pressable ref={close} accessibilityRole="button" accessibilityLabel="Close image" onPress={onClose} hitSlop={8}
      style={state => ({ position: "absolute", top: phone ? 8 : 12, right: phone ? 8 : 12, width: phone ? 44 : 36, height: phone ? 44 : 36, borderRadius: 8, alignItems: "center", justifyContent: "center",
        backgroundColor: state.pressed ? "rgba(255,255,255,0.18)" : (state as { hovered?: boolean }).hovered ? "rgba(255,255,255,0.1)" : "transparent" })}>
      <Icon name="X" size={phone ? 22 : 18} color="#ffffff" />
    </Pressable>
  </Animated.View>;
  if (inline) return layer;
  return <RNModal transparent visible animationType={reduced ? "none" : "fade"} statusBarTranslucent onRequestClose={onClose}>{layer}</RNModal>;
}

/** Inline (fixed in place) on desktop web; a Modal of its own on phones, where the host's bottom sheet moves. */
export const viewerInline = (compact: boolean) => Platform.OS === "web" && !compact;

/** Keeps the opener so focus goes back to the screenshot the viewer was opened from. */
export function refocus(from: unknown) {
  (from as { focus?: () => void } | null)?.focus?.();
}
