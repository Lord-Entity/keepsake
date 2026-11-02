import type { IconName } from "../ui/Icon";
import type { Page } from "../../state/nav";

export interface NavItem {
  page: Page;
  label: string;
  icon: IconName;
  key: string;
}

/** Sidebar order. Mod+<key> jumps to the page. */
export const NAV_ITEMS: NavItem[] = [
  { page: "home", label: "Home", icon: "home", key: "1" },
  { page: "downloads", label: "Downloads", icon: "download", key: "2" },
  { page: "library", label: "Library", icon: "library", key: "3" },
  { page: "favorites", label: "Favorites", icon: "heart", key: "4" },
  { page: "sources", label: "Sources", icon: "sources", key: "5" },
  { page: "settings", label: "Settings", icon: "settings", key: "6" },
];

/** Phone tab bar: five slots. Sources is reached from Home on phones. */
export const TAB_ITEMS: NavItem[] = NAV_ITEMS.filter((i) => i.page !== "sources");
