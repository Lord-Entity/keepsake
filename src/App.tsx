import { AnimatePresence, LayoutGroup, MotionConfig, motion, useReducedMotion } from "motion/react";
import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { SupportedSitesDialog } from "./components/features/SupportedSitesDialog";
import { Sidebar } from "./components/layout/Sidebar";
import { Splash } from "./components/layout/Splash";
import { TabBar } from "./components/layout/TabBar";
import { Titlebar } from "./components/layout/Titlebar";
import { Button, IconButton } from "./components/ui/Button";
import { Fab } from "./components/ui/Fab";
import { Toasts } from "./components/ui/Toasts";
import { AddLinkDialog } from "./pages/AddLink";
import { cancelAll, clearFinished, useHasFinished } from "./state/downloads";
import { refreshBinaries, versionsLine } from "./state/engine";
import { isMac } from "./state/format";
import { useIsNarrowWindow, useIsPhone } from "./state/hooks";
import { initLibrary } from "./state/library";
import { showWindow } from "./state/native";
import { emit, emitOn, navigate, openAddLink, PAGES, usePage, type Page } from "./state/nav";
import { initSettings, toggleDarkLight, updateSettings, useSettings } from "./state/settings";

// Pages load on demand so the first paint only pulls the shell.
const HomePage = lazy(() => import("./pages/Home").then((m) => ({ default: m.HomePage })));
const DownloadsPage = lazy(() => import("./pages/Downloads").then((m) => ({ default: m.DownloadsPage })));
const LibraryPage = lazy(() => import("./pages/Library").then((m) => ({ default: m.LibraryPage })));
const FavoritesPage = lazy(() => import("./pages/Favorites").then((m) => ({ default: m.FavoritesPage })));
const SourcesPage = lazy(() => import("./pages/Sources").then((m) => ({ default: m.SourcesPage })));
const SettingsPage = lazy(() => import("./pages/Settings").then((m) => ({ default: m.SettingsPage })));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Boot =
  | { phase: "splash"; step: string; versions: string | null; error: { title: string; body: string } | null }
  | { phase: "ready" };

export function App() {
  return (
    <MotionConfig reducedMotion="user">
      <Root />
    </MotionConfig>
  );
}

function Root() {
  const [boot, setBoot] = useState<Boot>({
    phase: "splash",
    step: "Loading settings",
    versions: null,
    error: null,
  });
  const [attempt, setAttempt] = useState(0);

  // The window starts hidden (tauri.conf visible:false); show it once the splash has painted.
  useEffect(() => {
    requestAnimationFrame(() => void showWindow());
  }, []);

  useEffect(() => {
    let alive = true;
    const step = (s: string) =>
      alive && setBoot((b) => (b.phase === "splash" ? { ...b, step: s, error: null } : b));
    const init = async () => {
      if (attempt === 0) {
        step("Loading settings");
        await initSettings();
        step("Preparing library");
        await initLibrary();
      }
      step("Checking yt-dlp and ffmpeg");
      return refreshBinaries();
    };
    void Promise.all([init(), sleep(600)]).then(async ([bins]) => {
      if (!alive) return;
      if (bins.state === "ready") {
        const st = bins.status;
        setBoot((b) => (b.phase === "splash" ? { ...b, versions: versionsLine(st) } : b));
        if (st.ytdlp === "missing") {
          setBoot((b) =>
            b.phase === "splash"
              ? {
                  ...b,
                  error: {
                    title: "Keepsake can't start downloads",
                    body: "yt-dlp is missing or damaged. Reinstall Keepsake.",
                  },
                }
              : b,
          );
          return;
        }
        await sleep(250);
      }
      if (alive) setBoot({ phase: "ready" });
    });
    return () => {
      alive = false;
    };
  }, [attempt]);

  // Exit: cancel every running job so sidecars do not outlive the window.
  useEffect(() => {
    const onUnload = () => cancelAll();
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, []);

  const ready = boot.phase === "ready";
  return (
    <>
      <AnimatePresence>
        {boot.phase === "splash" && (
          <Splash
            step={boot.step}
            versions={boot.versions}
            error={boot.error}
            onRetry={() => setAttempt((a) => a + 1)}
          />
        )}
      </AnimatePresence>
      {boot.phase === "splash" && boot.error && (
        <div className="fixed bottom-[max(1.5rem,env(safe-area-inset-bottom))] left-1/2 z-[61] -translate-x-1/2">
          <Button variant="ghost" size="lg" onClick={() => setBoot({ phase: "ready" })}>
            Continue without downloads
          </Button>
        </div>
      )}
      {ready && (
        <motion.div
          className="h-full"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.2, delay: 0.08 }}
        >
          <Shell />
        </motion.div>
      )}
      {ready && <Toasts />}
    </>
  );
}

function isTypingTarget(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (el as HTMLElement).isContentEditable;
}

/** Pages that bind Mod+F to their own search field; the shell leaves Mod+F alone there. */
const PAGES_WITH_OWN_SEARCH: ReadonlySet<Page> = new Set<Page>(["favorites"]);

function Shell() {
  const page = usePage();
  const phone = useIsPhone();
  const narrowWindow = useIsNarrowWindow();
  const collapsedPref = useSettings((s) => s.sidebarCollapsed);
  const [overlay, setOverlay] = useState(false);
  const [sites, setSites] = useState(false);
  const reduced = useReducedMotion();
  const hasFinished = useHasFinished();

  const collapsed = narrowWindow || collapsedPref;

  const toggleSidebar = useCallback(() => {
    if (narrowWindow) {
      setOverlay((o) => !o);
    } else {
      setOverlay(false);
      updateSettings({ sidebarCollapsed: !collapsedPref });
    }
  }, [narrowWindow, collapsedPref]);

  // Keyboard shortcuts (UI_CONTENT.md section 7). Mod+1..6 follow the sidebar order.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (!mod || e.altKey) return;
      const k = e.key.toLowerCase();
      // While typing, leave Mod+<key> to the field (paste, select-all, undo, ...).
      // Only Mod+Enter (download from the Home paste field) passes through.
      if (k !== "enter" && isTypingTarget(document.activeElement)) return;
      if (e.shiftKey) {
        if (k === "l") {
          e.preventDefault();
          toggleDarkLight();
        }
        return;
      }
      if (k === "b" && !phone) {
        e.preventDefault();
        toggleSidebar();
      } else if (k >= "1" && k <= String(PAGES.length)) {
        e.preventDefault();
        navigate(PAGES[Number(k) - 1]);
      } else if (k === "l") {
        e.preventDefault();
        emitOn("home", "focus-paste");
      } else if (k === "f") {
        // Pages with their own search (Favorites) handle Mod+F themselves.
        if (PAGES_WITH_OWN_SEARCH.has(page)) return;
        e.preventDefault();
        emitOn("library", "focus-library-search");
      } else if (k === "enter") {
        if (page === "home") {
          e.preventDefault();
          emit("download");
        }
      } else if (k === "v") {
        if (page === "home") {
          e.preventDefault();
          emit("paste-and-fetch");
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [page, phone, toggleSidebar]);

  // Phone header actions are 44px tall (touch targets); desktop keeps the compact sm size.
  const action =
    page === "home" ? (
      phone ? (
        <IconButton icon="globe" label="Supported sites" size={44} onClick={() => setSites(true)} />
      ) : (
        <Button size="sm" variant="ghost" icon="globe" onClick={() => setSites(true)}>
          Supported sites
        </Button>
      )
    ) : page === "downloads" && hasFinished ? (
      <Button
        size="sm"
        variant="ghost"
        className={phone ? "h-11" : ""}
        aria-label="Clear finished downloads"
        title="Clear finished downloads"
        onClick={clearFinished}
      >
        {phone ? "Clear" : "Clear finished"}
      </Button>
    ) : page === "sources" && phone ? (
      <Button size="sm" variant="ghost" icon="chevronLeft" className="h-11" onClick={() => navigate("home")}>
        Home
      </Button>
    ) : null;

  const fab =
    page === "settings" ? null : (
      <Fab
        phone={phone}
        className={
          phone
            ? "right-[max(1rem,env(safe-area-inset-right))] bottom-4"
            : "right-6 bottom-6"
        }
        actions={[
          { label: "Paste and fetch", icon: "clipboard", onSelect: () => emitOn("home", "paste-and-fetch") },
          { label: "Add to Favorites", icon: "heart", onSelect: () => openAddLink("favorites") },
          { label: "Add a source", icon: "sources", onSelect: () => openAddLink("sources") },
        ]}
      />
    );

  const content = (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={page}
        initial={reduced ? { opacity: 0 } : { opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0, transition: { duration: 0.18 } }}
        exit={reduced ? { opacity: 0, transition: { duration: 0.12 } } : { opacity: 0, y: -4, transition: { duration: 0.12 } }}
        className="mx-auto h-full w-full min-w-0 max-w-[1280px]"
      >
        <Suspense fallback={<div className="h-full" aria-busy="true" />}>
          <PageView page={page} phone={phone} onSupportedSites={() => setSites(true)} />
        </Suspense>
      </motion.div>
    </AnimatePresence>
  );

  return (
    <div className="flex h-full bg-app text-fg">
      {phone ? (
        <div className="flex h-full min-w-0 flex-1 flex-col">
          <Titlebar compact action={action} />
          <div className="relative flex min-h-0 flex-1 flex-col">
            {/* One gutter token: 16px (phone) plus the landscape safe-area insets. Pages add PAGE_BOTTOM. */}
            <main className="scroll-y min-h-0 flex-1 overflow-x-hidden pr-[max(1rem,env(safe-area-inset-right))] pl-[max(1rem,env(safe-area-inset-left))]">
              {content}
            </main>
            {fab}
          </div>
          <TabBar />
        </div>
      ) : (
        <LayoutGroup>
          <div className="relative flex h-full min-w-0 flex-1">
            <Sidebar
              collapsed={collapsed}
              overlay={narrowWindow && overlay}
              onToggle={toggleSidebar}
              onCloseOverlay={() => setOverlay(false)}
              onSupportedSites={() => setSites(true)}
            />
            <motion.div layout className="flex h-full min-w-0 flex-1 flex-col">
              <Titlebar action={action} />
              <div className="relative flex min-h-0 flex-1 flex-col">
                <main className="scroll-y min-h-0 flex-1 overflow-x-hidden px-6">{content}</main>
                {fab}
              </div>
            </motion.div>
          </div>
        </LayoutGroup>
      )}
      <SupportedSitesDialog open={sites} onClose={() => setSites(false)} fullScreen={phone} />
      <AddLinkDialog phone={phone} />
    </div>
  );
}

function PageView({ page, phone, onSupportedSites }: { page: Page; phone: boolean; onSupportedSites: () => void }) {
  switch (page) {
    case "home":
      return <HomePage phone={phone} />;
    case "downloads":
      return <DownloadsPage phone={phone} />;
    case "library":
      return <LibraryPage phone={phone} />;
    case "favorites":
      return <FavoritesPage phone={phone} />;
    case "sources":
      return <SourcesPage phone={phone} />;
    case "settings":
      return <SettingsPage phone={phone} onSupportedSites={onSupportedSites} />;
  }
}
