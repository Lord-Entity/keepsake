import { createStore, useStore } from "./store";

export type ToastTone = "success" | "error" | "warning" | "info";

export interface Toast {
  id: number;
  tone: ToastTone;
  title: string;
  body?: string;
  /** Milliseconds before auto-dismiss. Hover pauses the countdown. */
  duration: number;
  action?: { label: string; run: () => void };
}

export type ToastInput = Omit<Toast, "id" | "duration"> & { duration?: number };

const MAX_VISIBLE = 3;
const store = createStore<Toast[]>([]);
let seq = 0;

/** Show a toast. Newest goes last; the oldest is dropped past MAX_VISIBLE. */
export function notify(input: ToastInput): number {
  const id = ++seq;
  const toast: Toast = { duration: 4200, ...input, id };
  store.set((list) => [...list.slice(-(MAX_VISIBLE - 1)), toast]);
  return id;
}

export function dismissToast(id: number): void {
  store.set((list) => list.filter((t) => t.id !== id));
}

export function useToasts(): Toast[] {
  return useStore(store, (s) => s);
}
