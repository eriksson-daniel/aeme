/** Colors a new user is handed out from, in order of preference. Mid-tone
 * and spread around the wheel, so neighbours in a split availability cell
 * stay tellable apart on both the light cards and the dark page. A user can
 * pick any other `#rrggbb` afterwards; this is just the starting set. */
export const USER_COLORS = [
  { name: "Blue", hex: "#2563eb" },
  { name: "Rose", hex: "#e11d48" },
  { name: "Emerald", hex: "#059669" },
  { name: "Orange", hex: "#ea580c" },
  { name: "Violet", hex: "#7c3aed" },
  { name: "Gold", hex: "#ca8a04" },
  { name: "Cyan", hex: "#0891b2" },
  { name: "Fuchsia", hex: "#c026d3" },
  { name: "Lime", hex: "#65a30d" },
  { name: "Brown", hex: "#92400e" },
  { name: "Pink", hex: "#f472b6" },
  { name: "Slate", hex: "#475569" },
] as const;

/** Just the hex values of `USER_COLORS`, in the same order. */
export const USER_COLOR_PALETTE: string[] = USER_COLORS.map((color) => color.hex);

/** Lowercase `#rrggbb` — the only form stored, so equal colors compare equal
 * when counting how many users already have one. */
export const USER_COLOR_PATTERN = /^#[0-9a-f]{6}$/;
