import type { IconName } from "../ui/Icon";
import type { Page } from "../../state/nav";

export interface NavItem {
  page: Page;
  label: string;
  icon: IconName;
  key: string;
}

/**
 * Sidebar order. Mod+<key> jumps to the page. Editor sits next to Library but takes
 * Mod+7 so the long-standing Mod+1..6 bindings keep pointing at the same pages.
 */
export const NAV_ITEMS: NavItem[] = [
  { page: "home", label: "Home", icon: "home", key: "1" },
  { page: "downloads", label: "Downloads", icon: "download", key: "2" },
  { page: "library", label: "Library", icon: "library", key: "3" },
  { page: "editor", label: "Editor", icon: "scissors", key: "7" },
  { page: "favorites", label: "Favorites", icon: "heart", key: "4" },
  { page: "sources", label: "Sources", icon: "sources", key: "5" },
  { page: "settings", label: "Settings", icon: "settings", key: "6" },
];

/** The page bound to Mod+<key>, if any. */
export const pageForKey = (key: string): Page | undefined => NAV_ITEMS.find((i) => i.key === key)?.page;

/**
 * Phone tab bar: six slots (Home, Downloads, Library, Editor, Favorites, Settings).
 * Sources is reached from Home on phones.
 */
export const TAB_ITEMS: NavItem[] = NAV_ITEMS.filter((i) => i.page !== "sources");
