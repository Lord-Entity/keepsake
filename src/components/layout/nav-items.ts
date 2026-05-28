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

/** Phone tab bar order: five slots with Editor as the raised centre tab. Downloads and Sources are reached from Home. */
const TAB_PAGES: readonly Page[] = ["home", "library", "editor", "favorites", "settings"];
export const TAB_ITEMS: NavItem[] = TAB_PAGES.flatMap((p) => NAV_ITEMS.filter((i) => i.page === p));

/** The emphasised centre tab. */
export const TAB_CENTER: Page = "editor";

/** The tab highlighted for a page: pages without their own tab (Downloads, Sources) live under Home. */
export const tabForPage = (page: Page): Page => (TAB_PAGES.includes(page) ? page : "home");
