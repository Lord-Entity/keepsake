import { useEffect, useState } from "react";
import { inTauri, isDecorated, windowAction } from "../../state/native";

/** Min / max / close, shown only on desktop Tauri when native decorations are off. */
export function WindowControls() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (!inTauri) return;
    let alive = true;
    void isDecorated().then((d) => alive && setShow(!d));
    return () => {
      alive = false;
    };
  }, []);
  if (!show) return null;
  const btn =
    "flex h-9 w-11 items-center justify-center text-fg-2 transition-colors duration-150 hover:bg-accent-soft hover:text-fg";
  return (
    <div className="ml-2 flex items-center">
      <button type="button" aria-label="Minimize" className={btn} onClick={() => void windowAction("minimize")}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M0 5h10" stroke="currentColor" />
        </svg>
      </button>
      <button type="button" aria-label="Maximize" className={btn} onClick={() => void windowAction("maximize")}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" />
        </svg>
      </button>
      <button
        type="button"
        aria-label="Close"
        className={`${btn} hover:!bg-danger hover:!text-white`}
        onClick={() => void windowAction("close")}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M0 0l10 10M10 0 0 10" stroke="currentColor" />
        </svg>
      </button>
    </div>
  );
}
