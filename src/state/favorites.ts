import { loadJsonArray, saveJson } from "./persist";
import { createStore, useStore } from "./store";

export type FavoriteKind = "video" | "audio" | "channel" | "profile";

export interface FavoriteItem {
  id: string;
  url: string;
  title: string;
  thumbnailUrl: string | null;
  site: string;
  kind: FavoriteKind;
  /** ms epoch */
  addedAt: number;
}

const KEY = "keepsake.favorites.v1";

function sorted(items: FavoriteItem[]): FavoriteItem[] {
  const copy = items.slice();
  copy.sort((a, b) => b.addedAt - a.addedAt);
  return copy;
}

export const favoritesStore = createStore<FavoriteItem[]>(
  sorted(loadJsonArray<FavoriteItem>(KEY).filter((f) => f && typeof f.id === "string")),
);
favoritesStore.subscribe(() => saveJson(KEY, favoritesStore.get()));

/** All favorites, newest first. */
export function useFavorites(): FavoriteItem[] {
  return useStore(favoritesStore, (s) => s);
}

/** Reactive single-item check for components. */
export function useIsFavorite(id: string): boolean {
  return useStore(favoritesStore, (s) => s.some((f) => f.id === id));
}

export function isFavorite(id: string): boolean {
  return favoritesStore.get().some((f) => f.id === id);
}

/** Adds the item (addedAt defaults to now) or removes it if already present. Returns the new state. */
export function toggleFavorite(item: Omit<FavoriteItem, "addedAt"> & { addedAt?: number }): boolean {
  const exists = isFavorite(item.id);
  favoritesStore.set((prev) =>
    exists
      ? prev.filter((f) => f.id !== item.id)
      : sorted([{ ...item, addedAt: item.addedAt ?? Date.now() }, ...prev]),
  );
  return !exists;
}

export function removeFavorite(id: string): void {
  favoritesStore.set((prev) => prev.filter((f) => f.id !== id));
}
