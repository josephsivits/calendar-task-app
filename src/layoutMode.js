import { useState, useEffect } from "react";

/** Stack below this CSS width on any device. */
export const NARROW_BREAKPOINT = 555;

/**
 * Touch-primary devices (phones, many tablets) with CSS width under this
 * also stack — Android "display size / font size" settings often inflate
 * CSS pixels past NARROW_BREAKPOINT even on a handheld screen.
 */
export const TOUCH_STACK_BREAKPOINT = 900;

const NARROW_MQ = `(max-width: ${NARROW_BREAKPOINT - 1}px)`;
const TOUCH_STACK_MQ = `(max-width: ${TOUCH_STACK_BREAKPOINT - 1}px)`;
const COARSE_MQ = "(pointer: coarse)";
const NO_HOVER_MQ = "(hover: none)";

/**
 * Resolve layout mode from viewport + input modality.
 * Returns "rows" (stacked) or "columns" (side-by-side).
 */
export function resolveLayoutMode(win = typeof window !== "undefined" ? window : null) {
  if (!win) return "columns";

  const width = win.innerWidth;
  const height = win.innerHeight;
  const narrow = width < NARROW_BREAKPOINT;
  const coarse = win.matchMedia(COARSE_MQ).matches;
  const noHover = win.matchMedia(NO_HOVER_MQ).matches;
  const touchPrimary = coarse && noHover;
  const touchHandheld = touchPrimary && width < TOUCH_STACK_BREAKPOINT;

  const mode = narrow || touchHandheld ? "rows" : "columns";

  return {
    mode,
    isStacked: mode === "rows",
    width,
    height,
    narrow,
    touchPrimary,
    touchHandheld,
  };
}

/**
 * Subscribe to viewport / pointer media changes and return layout dimensions.
 */
export function useLayoutMode() {
  const [layout, setLayout] = useState(() => resolveLayoutMode());

  useEffect(() => {
    const mqs = [
      window.matchMedia(NARROW_MQ),
      window.matchMedia(TOUCH_STACK_MQ),
      window.matchMedia(COARSE_MQ),
      window.matchMedia(NO_HOVER_MQ),
    ];

    const refresh = () => setLayout(resolveLayoutMode());
    refresh();

    for (const mq of mqs) mq.addEventListener("change", refresh);
    window.addEventListener("resize", refresh);
    window.addEventListener("orientationchange", refresh);

    return () => {
      for (const mq of mqs) mq.removeEventListener("change", refresh);
      window.removeEventListener("resize", refresh);
      window.removeEventListener("orientationchange", refresh);
    };
  }, []);

  return layout;
}
