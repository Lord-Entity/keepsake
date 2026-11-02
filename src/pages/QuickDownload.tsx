import { useCallback, useRef, useState } from "react";
import { FormatPicker, type PickerChoice } from "../components/features/FormatPicker";
import { ActionModal } from "../components/ui/ActionModal";
import { Dialog } from "../components/ui/Dialog";
import type { FormatOption, VideoInfo } from "../lib/types";
import { enqueue } from "../state/downloads";
import { asAppError, fetchInfo, listFormats } from "../state/engine";
import { hostOf } from "../state/format";
import { navigate } from "../state/nav";
import { settingsStore } from "../state/settings";
import { notify } from "../state/toast";

const MESSAGES = ["Reading the link…", "Checking available formats…", "Almost there…"];

type Phase = { kind: "idle" } | { kind: "fetching"; url: string } | { kind: "pick"; info: VideoInfo; formats: FormatOption[] };

/**
 * Download from a saved link (favorite or source) with the same flow as Home:
 * fetch info in the ActionModal, then pick a format in a centred dialog and enqueue.
 * `onQueued` lets the caller record the download (e.g. a source's last-downloaded time).
 */
export function useQuickDownload(phone: boolean) {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const abort = useRef<AbortController | null>(null);
  const done = useRef<(() => void) | null>(null);

  const start = useCallback((url: string, onQueued?: () => void) => {
    abort.current?.abort();
    const ctrl = new AbortController();
    abort.current = ctrl;
    done.current = onQueued ?? null;
    setPhase({ kind: "fetching", url });
    void fetchInfo(url, { signal: ctrl.signal, cookiesBrowser: settingsStore.get().cookiesBrowser })
      .then((info) => {
        if (ctrl.signal.aborted) return;
        setPhase({ kind: "pick", info, formats: listFormats(info) });
      })
      .catch((e: unknown) => {
        if (ctrl.signal.aborted) return;
        setPhase({ kind: "idle" });
        notify({ tone: "error", title: "Couldn't read this link", body: asAppError(e).message });
      });
  }, []);

  const cancel = useCallback(() => {
    abort.current?.abort();
    setPhase({ kind: "idle" });
  }, []);

  const onDownload = (choice: PickerChoice) => {
    if (phase.kind !== "pick") return;
    enqueue(phase.info, choice);
    done.current?.();
    notify({
      tone: "success",
      title: "Added to downloads",
      body: phase.info.title,
      action: { label: "View", run: () => navigate("downloads") },
    });
    setPhase({ kind: "idle" });
  };

  const element = (
    <>
      <ActionModal
        open={phase.kind === "fetching"}
        phase="working"
        title="Reading the link"
        messages={MESSAGES}
        detail={phase.kind === "fetching" ? hostOf(phase.url) || undefined : undefined}
        onCancel={cancel}
      />
      <Dialog
        open={phase.kind === "pick"}
        onClose={cancel}
        title={phase.kind === "pick" ? phase.info.title : "Format"}
        description={phase.kind === "pick" && phase.info.kind === "playlist" ? `Playlist${phase.info.playlistCount ? ` · ${phase.info.playlistCount} items` : ""}` : undefined}
        phone={phone}
        width={480}
        bodyClassName="flex flex-col"
      >
        {phase.kind === "pick" && (
          <div className="flex min-h-[300px] min-w-0 flex-1 flex-col">
            <FormatPicker info={phase.info} formats={phase.formats} onDownload={onDownload} fill={phone} />
          </div>
        )}
      </Dialog>
    </>
  );

  return { start, element, busy: phase.kind !== "idle" };
}
