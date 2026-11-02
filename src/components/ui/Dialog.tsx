import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useIsPhone } from "../../state/hooks";
import { IconButton } from "./Button";
import { t } from "./motion";
import { useModal } from "./useModal";

/**
 * Modal dialog. Esc and backdrop click close it; Tab is trapped inside, body scroll
 * is locked, focus moves into the panel and returns to the opener on close
 * (useModal). Rendered in a portal so a transformed ancestor (pressed row,
 * animating card) can never offset the fixed overlay.
 *
 * - default: centered, `width` px wide (capped by the 16px gutter), max 85vh.
 * - `phone` on a phone-width viewport: bottom sheet, full width (max 560),
 *   max 85dvh, internal scroll, padded by the bottom safe-area inset.
 * - `phone` on a wider viewport: centered, calc(100vw - 32px) wide (max 480).
 * - `fullScreen`: covers the viewport, close button top-left.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  width = 440,
  fullScreen,
  phone,
  bodyClassName = "",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  width?: number;
  fullScreen?: boolean;
  phone?: boolean;
  /** Extra classes for the scrolling body (e.g. "flex flex-col" to pin a footer button). */
  bodyClassName?: string;
}) {
  const reduced = useReducedMotion();
  const panel = useRef<HTMLDivElement>(null);
  const phoneWidth = useIsPhone();
  const sheet = !!phone && phoneWidth && !fullScreen;
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });
  useModal(open, panel, onClose);

  const pad = phone ? "px-4" : "px-5";
  const panelStyle = fullScreen
    ? undefined
    : sheet
      ? { width: "100%", maxWidth: 560, paddingBottom: "env(safe-area-inset-bottom, 0px)" }
      : phone
        ? { width: "calc(100vw - 32px)", maxWidth: 480 }
        : { width, maxWidth: "100%" };

  const enter = reduced
    ? { opacity: 0 }
    : sheet
      ? { opacity: 1, y: "100%" }
      : { opacity: 0, scale: phone ? 0.94 : 0.97, y: phone ? 12 : 6 };
  const leave = reduced ? { opacity: 0 } : sheet ? { opacity: 1, y: "100%" } : { opacity: 0, scale: 0.98 };

  const shape = fullScreen
    ? "safe-top safe-bottom h-full max-h-full w-full"
    : sheet
      ? "max-h-[85dvh] rounded-t-[24px] border border-b-0 border-line"
      : `${phone ? "max-h-[85dvh]" : "max-h-[85vh]"} border border-line shadow-[inset_0_1px_0_rgba(255,255,255,0.05),var(--shadow-pop)] ${phone ? "rounded-[22px_22px_22px_10px]" : "rounded-[24px_24px_24px_10px]"}`;

  const tree = (
    <AnimatePresence>
      {open && (
        <motion.div
          className={`fixed inset-0 z-50 flex justify-center bg-black/55 ${
            sheet ? "items-end" : fullScreen ? "items-center" : "items-center p-4"
          }`}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={t.fast}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) closeRef.current();
          }}
          // Keys typed inside the dialog must not reach row shortcuts (e.g. Delete cancels a job).
          onKeyDown={(e) => e.stopPropagation()}
        >
          <motion.div
            ref={panel}
            role="dialog"
            aria-modal="true"
            aria-label={title}
            tabIndex={-1}
            initial={enter}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={leave}
            transition={reduced ? t.fast : t.spring}
            style={panelStyle}
            className={`modal-panel flex flex-col bg-card text-fg shadow-pop outline-none ${shape}`}
          >
            {sheet && <span aria-hidden="true" className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-line-strong" />}
            <header
              className={`flex shrink-0 items-start gap-3 ${pad} ${phone ? (sheet ? "pt-1 pr-2" : "pt-3 pr-2") : "pt-5"} ${fullScreen ? "flex-row-reverse justify-end" : ""}`}
            >
              <div className={`min-w-0 flex-1 ${phone ? "pt-[13px]" : ""}`}>
                <h2 className={`text-[15px] leading-[22px] font-semibold ${phone ? "line-clamp-2 break-words" : ""}`}>
                  {title}
                </h2>
                {description && <p className="mt-1 text-fg-2">{description}</p>}
              </div>
              <IconButton icon="x" label="Close" size={fullScreen || phone ? 48 : 32} data-close onClick={onClose} />
            </header>
            {children && (
              <div
                className={`scroll-y min-h-0 flex-1 overscroll-contain ${pad} ${phone ? "pt-2 pb-4" : "py-4"} ${bodyClassName}`}
              >
                {children}
              </div>
            )}
            {footer && (
              <footer className={`flex shrink-0 justify-end gap-2 ${pad} pt-1 ${phone ? "pb-4" : "pb-5"}`}>{footer}</footer>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );

  return typeof document === "undefined" ? tree : createPortal(tree, document.body);
}

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel,
  danger,
  children,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  children?: ReactNode;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      footer={
        <>
          <ButtonLite onClick={onClose}>Cancel</ButtonLite>
          <ButtonLite
            danger={danger}
            primary
            onClick={() => {
              onConfirm();
              onClose();
            }}
          >
            {confirmLabel}
          </ButtonLite>
        </>
      }
    >
      {children}
    </Dialog>
  );
}

function ButtonLite({
  children,
  onClick,
  primary,
  danger,
}: {
  children: ReactNode;
  onClick: () => void;
  primary?: boolean;
  danger?: boolean;
}) {
  const cls = !primary
    ? "bg-inset border border-line text-fg hover:border-line-strong"
    : danger
      ? "bg-danger text-white font-semibold"
      : "bg-accent text-on-accent font-semibold hover:bg-accent-hover";
  return (
    <button
      type="button"
      onClick={onClick}
      className={`hit h-9 rounded-md px-4 text-[12px] font-medium transition-colors duration-150 ${cls}`}
    >
      {children}
    </button>
  );
}
