import { motion, useReducedMotion } from "motion/react";
import { useMemo, useState } from "react";
import { Dialog } from "../ui/Dialog";
import { Icon } from "../ui/Icon";
import { listItem } from "../ui/motion";

/**
 * The engine has no list_supported_sites yet, so this is a static placeholder
 * of common sites. yt-dlp supports far more on desktop.
 */
const SITES = [
  "YouTube",
  "YouTube Music",
  "YouTube Shorts",
  "SoundCloud",
  "Vimeo",
  "Dailymotion",
  "Twitch (VODs and clips)",
  "X (Twitter)",
  "Instagram",
  "Facebook",
  "TikTok",
  "Reddit",
  "Bandcamp",
  "Mixcloud",
  "Bilibili",
  "Niconico",
  "PeerTube",
  "Rumble",
  "Odysee",
  "Streamable",
  "Imgur",
  "Tumblr",
  "VK",
  "BBC iPlayer",
  "Arte",
  "ARD Mediathek",
  "ZDF",
  "CBC",
  "NHK",
  "Archive.org",
  "Audiomack",
  "Bitchute",
  "Coub",
  "Kick",
  "LinkedIn",
  "Pinterest",
  "Spreaker",
  "TED",
  "Vevo",
  "Weibo",
];

export function SupportedSitesDialog({
  open,
  onClose,
  fullScreen,
}: {
  open: boolean;
  onClose: () => void;
  fullScreen?: boolean;
}) {
  const [q, setQ] = useState("");
  const reduced = useReducedMotion();
  const list = useMemo(() => {
    const n = q.trim().toLowerCase();
    return n ? SITES.filter((s) => s.toLowerCase().includes(n)) : SITES;
  }, [q]);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Supported sites"
      description="YouTube works everywhere. On desktop, yt-dlp adds 1,000+ more sites; this is a short list of popular ones."
      width={520}
      fullScreen={fullScreen}
    >
      <label className="icon-host group relative mb-3 block">
        <Icon
          name="search"
          size={16}
          animated
          className="absolute top-1/2 left-3 -translate-y-1/2 text-fg-2 group-focus-within:text-accent"
        />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search sites"
          aria-label="Search sites"
          className="h-9 w-full rounded-md border border-line bg-inset pr-3 pl-9 text-[13px] text-fg transition-colors duration-150 placeholder:text-fg-3 hover:border-line-strong focus-visible:border-accent"
        />
      </label>
      {list.length === 0 ? (
        <p className="py-6 text-center text-fg-2">No matches for "{q}"</p>
      ) : (
        <ul className="grid min-w-0 grid-cols-1 gap-x-4 min-[380px]:grid-cols-2">
          {list.map((s, i) => (
            <motion.li
              key={s}
              {...listItem(reduced, i)}
              className="truncate border-b border-line py-2 text-[13px]"
              title={s}
            >
              {s}
            </motion.li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
