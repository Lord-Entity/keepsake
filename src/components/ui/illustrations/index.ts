import type { ComponentType } from "react";
import { EmptyDownloads } from "./EmptyDownloads";
import { EmptyEditor } from "./EmptyEditor";
import { EmptyFavorites } from "./EmptyFavorites";
import { EmptyHome } from "./EmptyHome";
import { EmptyLibrary } from "./EmptyLibrary";
import { EmptySearch } from "./EmptySearch";
import { EmptySources } from "./EmptySources";
import { ErrorState } from "./ErrorState";
import type { IllustrationProps } from "./Scene";

export { CookingScene } from "./CookingScene";
export { DownloadStateArt, type DownloadArtState } from "./DownloadStateArt";
export { Mascot,MASCOT_HANDS, mascotHand, type MascotMood, type MascotPose } from "./Mascot";
export { Scene, Sparkle, Person, PERSON_HANDS, type IllustrationProps, type PersonPose } from "./Scene";
export { EmptyDownloads, EmptyEditor, EmptyFavorites, EmptyHome, EmptyLibrary, EmptySearch, EmptySources, ErrorState };

/** Every finished empty-state illustration by name, for `<EmptyState illustration="…">`. */
export const ILLUSTRATIONS = {
  library: EmptyLibrary,
  favorites: EmptyFavorites,
  downloads: EmptyDownloads,
  sources: EmptySources,
  search: EmptySearch,
  error: ErrorState,
  home: EmptyHome,
  editor: EmptyEditor,
} satisfies Record<string, ComponentType<IllustrationProps>>;

export type IllustrationName = keyof typeof ILLUSTRATIONS;
