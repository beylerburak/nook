/**
 * Detects whether the page the toast is shown on looks light or dark, so the
 * "system" appearance can blend in with the site (e.g. X's dark / dim / light
 * themes) instead of following the OS setting.
 *
 * The page's painted background is the most reliable signal: sites implement
 * their own theme switchers in many ways, but they all end up coloring body/html.
 */

export type SiteColorScheme = "light" | "dark";

type Rgba = { r: number; g: number; b: number; a: number };

export function parseCssColor(value: string): Rgba | null {
  // Browsers compute "transparent" as rgba(0, 0, 0, 0), but don't rely on it.
  if (value === "" || value.toLowerCase() === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
  const match = value.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i);
  if (!match) return null;
  const [, r, g, b, alpha] = match;
  const a = alpha === undefined ? 1 : alpha.endsWith("%") ? parseFloat(alpha) / 100 : parseFloat(alpha);
  return { r: Number(r), g: Number(g), b: Number(b), a };
}

/** WCAG relative luminance, 0 (black) … 1 (white). */
export function relativeLuminance({ r, g, b }: Rgba): number {
  const channel = (value: number) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

// Luminance at which black and white text have equal contrast: the natural light/dark split.
const LIGHT_DARK_THRESHOLD = 0.179;

/** Returns null when the page's background can't be read (e.g. a non-rgb color space). */
export function detectSiteColorScheme(doc: Document = document): SiteColorScheme | null {
  for (const element of [doc.body, doc.documentElement]) {
    if (!element) continue;
    const background = parseCssColor(getComputedStyle(element).backgroundColor);
    if (!background) return null;
    if (background.a === 0) continue; // Transparent: the next layer decides.
    return relativeLuminance(background) < LIGHT_DARK_THRESHOLD ? "dark" : "light";
  }

  // Nothing painted: the browser canvas shows through, which follows the page's color-scheme.
  const colorScheme = getComputedStyle(doc.documentElement).colorScheme;
  return /\bdark\b/.test(colorScheme) && !/\blight\b/.test(colorScheme) ? "dark" : "light";
}

/**
 * Calls `listener` whenever the detected scheme changes (theme switchers usually
 * flip a class, attribute or inline style on html/body). Returns an unsubscribe function.
 */
export function watchSiteColorScheme(
  listener: (scheme: SiteColorScheme | null) => void,
  doc: Document = document,
): () => void {
  let current = detectSiteColorScheme(doc);
  const recheck = () => {
    const next = detectSiteColorScheme(doc);
    if (next === current) return;
    current = next;
    listener(next);
  };

  const observer = new MutationObserver(recheck);
  const observed = { attributes: true, attributeFilter: ["class", "style", "data-theme", "data-color-mode"] };
  observer.observe(doc.documentElement, observed);
  if (doc.body) observer.observe(doc.body, observed);

  // Sites without their own switcher repaint via prefers-color-scheme media queries.
  const osScheme = window.matchMedia("(prefers-color-scheme: dark)");
  osScheme.addEventListener("change", recheck);

  return () => {
    observer.disconnect();
    osScheme.removeEventListener("change", recheck);
  };
}
