import type { ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * Dialogs render on <body>. Opened from the top bar, a `position: fixed`
 * backdrop would be sized to the bar instead of the window, because the bar's
 * `backdrop-filter` makes it the containing block for fixed descendants.
 */
export function ModalPortal({ children }: { children: ReactNode }) {
  return typeof document === "undefined" ? null : createPortal(children, document.body);
}
