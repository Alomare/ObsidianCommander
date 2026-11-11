// Line icons in one style: 24 units, 1.8 stroke, square ends where the shape allows.
import type { SVGProps } from "react";

type P = SVGProps<SVGSVGElement>;
const base = (p: P) => ({
  width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8,
  strokeLinecap: "square" as const, strokeLinejoin: "miter" as const, "aria-hidden": true, ...p,
});

/** Starts the game: the solid triangle of the Obsidian Play. */
export const IPlay = (p: P) => <svg {...base(p)} fill="currentColor" stroke="none"><path d="M7 4.5v15l13-7.5z" /></svg>;
/** The war clock controls: drawn in a ring, so they never read as the game Play. */
export const IClockPause = (p: P) => <svg {...base(p)}><circle cx="12" cy="12" r="9" /><path d="M10 8.5v7M14 8.5v7" strokeWidth={2.2} /></svg>;
export const IClockResume = (p: P) => <svg {...base(p)}><circle cx="12" cy="12" r="9" /><path d="M10 8v8l6-4z" fill="currentColor" strokeWidth={1.2} strokeLinejoin="round" /></svg>;
export const IBack = (p: P) => <svg {...base(p)}><path d="M15 5l-7 7 7 7" /></svg>;
export const IPlus = (p: P) => <svg {...base(p)}><path d="M12 5v14M5 12h14" /></svg>;
export const ICheck = (p: P) => <svg {...base(p)}><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>;
export const IImport = (p: P) => <svg {...base(p)}><path d="M12 3.5V15M7.5 10.5L12 15l4.5-4.5" /><path d="M4 13.5v7h16v-7" /></svg>;
export const IExport = (p: P) => <svg {...base(p)}><path d="M12 15V3.5M7.5 8L12 3.5 16.5 8" /><path d="M4 13.5v7h16v-7" /></svg>;
/** A pencil: edit the war info. */
export const IEdit = (p: P) => <svg {...base(p)}><path d="M4 20h4L19.5 8.5l-4-4L4 16z" /><path d="M13.5 6.5l4 4" /></svg>;
export const ITrash = (p: P) => <svg {...base(p)}><path d="M4 7h16M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13M10 11v5.5M14 11v5.5" /></svg>;
/** The Obsidian cog, so Settings looks the same in both. */
export const IGear = (p: P) => (
  <svg {...base(p)} strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
  </svg>
);
export const IMore = (p: P) => <svg {...base(p)} fill="currentColor" stroke="none"><rect x="4" y="10.5" width="3" height="3" /><rect x="10.5" y="10.5" width="3" height="3" /><rect x="17" y="10.5" width="3" height="3" /></svg>;
export const IWarn = (p: P) => <svg {...base(p)}><path d="M12 3L22 20H2z" strokeLinejoin="miter" /><path d="M12 9.5v5M12 16.5v1.5" /></svg>;
export const IShield = (p: P) => <svg {...base(p)}><path d="M12 3l8 3v6c0 4.5-3.4 7.8-8 9-4.6-1.2-8-4.5-8-9V6z" /></svg>;
export const ITarget = (p: P) => <svg {...base(p)}><circle cx="12" cy="12" r="7" /><path d="M12 2v5M12 17v5M2 12h5M17 12h5" /></svg>;
export const ILan = (p: P) => <svg {...base(p)}><rect x="9" y="3" width="6" height="5" /><rect x="3" y="16" width="6" height="5" /><rect x="15" y="16" width="6" height="5" /><path d="M12 8v4M6 16v-4h12v4" /></svg>;
export const IUsers = (p: P) => <svg {...base(p)}><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20c.8-3.7 3.3-5.5 6.5-5.5s5.7 1.8 6.5 5.5" /><path d="M15.5 4.8a3.5 3.5 0 0 1 0 6.4M18 14.8c1.8.8 3 2.5 3.5 5.2" /></svg>;
export const IList = (p: P) => <svg {...base(p)}><path d="M8 6h13M8 12h13M8 18h13M3 6h1M3 12h1M3 18h1" /></svg>;
export const IStats = (p: P) => <svg {...base(p)}><path d="M5 20V11M12 20V4M19 20v-6" strokeWidth={2.6} /></svg>;
/** Rank chevrons: the Game Master orders. */
export const ICommand = (p: P) => <svg {...base(p)}><path d="M5 10l7-5 7 5M5 15l7-5 7 5M5 20l7-5 7 5" /></svg>;
export const IChevron = (p: P) => <svg {...base(p)}><path d="M9 5l7 7-7 7" /></svg>;
export const IClose = (p: P) => <svg {...base(p)}><path d="M6 6l12 12M18 6L6 18" /></svg>;
export const IUp = (p: P) => <svg {...base(p)}><path d="M5 15l7-7 7 7" /></svg>;
export const IDown = (p: P) => <svg {...base(p)}><path d="M5 9l7 7 7-7" /></svg>;
export const IFlag = (p: P) => <svg {...base(p)}><path d="M5 21V4M5 4h12l-2 4 2 4H5" /></svg>;
export const IEye = (p: P) => <svg {...base(p)}><path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></svg>;
export const IInfo = (p: P) => <svg {...base(p)}><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7.5v1" /></svg>;
export const IBug = (p: P) => <svg {...base(p)}><ellipse cx="12" cy="13" rx="5" ry="7" /><path d="M12 6v14M7 10H3M7 15H3M17 10h4M17 15h4M9 5L7 2M15 5l2-3" /></svg>;
export const ICyborg = (p: P) => <svg {...base(p)}><path d="M5 4h14v9l-3 7H8l-3-7z" /><path d="M8 10h3M13 10h3" strokeWidth={2.4} /></svg>;
export const IIlluminate = (p: P) => <svg {...base(p)}><path d="M12 3l9 17H3z" /><circle cx="12" cy="14" r="2.5" /></svg>;

export const EnemyIcon = ({ enemy, ...p }: P & { enemy: number }) =>
  enemy === 0 ? <IBug {...p} /> : enemy === 1 ? <ICyborg {...p} /> : <IIlluminate {...p} />;
