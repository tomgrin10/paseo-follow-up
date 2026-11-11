/** A screenshot shown in the image viewer (client/image-viewer.tsx): its URL, alt text, CSS width and shape. */
export type ViewedImage = { url: string; label: string; width: number | null; aspect: number };

/** Below this window width the viewer is a phone's full screen: smaller margins, a bigger X, pinch-zoom on iOS. */
const PHONE_BELOW = 768;

/**
 * The size an image is drawn at: fitted inside the window less its margins, at its own shape, and never past its CSS
 * width (the 2x/3x PNG stays sharp; the 1:1 rule of the notes holds here too). Exported for the tests.
 */
export function fitImage(image: Pick<ViewedImage, "width" | "aspect">, window: { width: number; height: number }) {
  const phone = window.width < PHONE_BELOW;
  const side = phone ? 12 : 56; const top = phone ? 60 : 56;
  const maxW = Math.max(1, window.width - 2 * side); const maxH = Math.max(1, window.height - top - (phone ? 24 : 56));
  const width = Math.floor(Math.min(image.width ?? Infinity, maxW, maxH * image.aspect));
  return { width, height: Math.floor(width / image.aspect), phone };
}
