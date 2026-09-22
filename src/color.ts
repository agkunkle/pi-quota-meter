export const DEFAULT_COLOR = "#b7cabd";

const THEME_COLORS = ["accent", "success", "muted", "dim", "text", "warning", "error"] as const;
type ThemeColor = (typeof THEME_COLORS)[number];
export type StatusColor = ThemeColor | "none" | `#${string}`;

export function parse_color(value: unknown): StatusColor {
  if (typeof value !== "string") throw new Error("color must be a string");
  if (value === "none" || THEME_COLORS.some((role) => role === value)) {
    return value as StatusColor;
  }
  if (/^#[0-9a-fA-F]{6}$/.test(value)) return value as `#${string}`;
  throw new Error("color must be #RRGGBB, a Pi theme color, or none");
}

export function style_status(
  text: string, color: StatusColor, theme: { fg: (role: ThemeColor, text: string) => string },
): string {
  if (color === "none") return text;
  if (!color.startsWith("#")) return theme.fg(color as ThemeColor, text);
  const rgb = color.slice(1).match(/../g)!.map((pair) => Number.parseInt(pair, 16));
  return `\x1b[38;2;${rgb.join(";")}m${text}\x1b[39m`;
}
