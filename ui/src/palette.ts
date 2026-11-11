// The colours of the Evolved war sides: the HELLDIVERS (2015) campaign colours, as the Vanilla map
// takes them from the game table (Super Earth yellow, Bugs green, Cyborgs red, Illuminates blue).

export type Side = "superearth" | "bugs" | "cyborgs" | "illuminates";

/** Index = Evolved owner (0 Super Earth, 1 Bugs, 2 Cyborgs, 3 Illuminates). */
export const SIDES: Side[] = ["superearth", "bugs", "cyborgs", "illuminates"];

const RGB: Record<Side, string> = {
  superearth: "255, 170, 20",
  bugs: "70, 220, 160",
  cyborgs: "230, 80, 70",
  illuminates: "40, 150, 250",
};

export const sideColor = (s: Side, alpha = 1) => `rgba(${RGB[s]}, ${alpha})`;
