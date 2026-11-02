/**
 * Shared page-layout tokens. The shell's <main> owns the side gutter (16px phone,
 * 24px desktop, plus safe-area insets) and the 1280px max-width container; pages
 * only add their vertical stack and the bottom clearance below.
 */

/** Bottom clearance so the FAB (56px + 16px offset on phones) never covers the last row. */
export const PAGE_BOTTOM = "pb-24";

/** Default page stack: vertical rhythm, bottom clearance, and no horizontal blow-out. */
export const PAGE_STACK = `flex min-w-0 flex-col gap-4 ${PAGE_BOTTOM}`;

// Small shared controls (Button sm/md, Select, Segmented, Switch, Stepper) get their
// 44px phone hit area from the `.hit` class in components/ui (theme.css), so pages
// only size controls explicitly where a visibly larger control reads better.
