// The colours of every war, Vanilla and Evolved: Super Earth blue, Bugs orange yellow, Cyborgs red,
// Illuminates purple. styles.css repeats them as --se, --bugs, --cyborgs and --illuminates.

export type Side = "superearth" | "bugs" | "cyborgs" | "illuminates";

/** Index = Evolved owner (0 Super Earth, 1 Bugs, 2 Cyborgs, 3 Illuminates). */
export const SIDES: Side[] = ["superearth", "bugs", "cyborgs", "illuminates"];

const RGB: Record<Side, string> = {
  superearth: "70, 160, 255",
  bugs: "255, 165, 30",
  cyborgs: "235, 72, 60",
  illuminates: "165, 100, 255",
};

export const sideColor = (s: Side, alpha = 1) => `rgba(${RGB[s]}, ${alpha})`;
/** Super Earth: the territory it holds, liberation and defense progress. */
export const SE_COLOR = `rgb(${RGB.superearth})`;
