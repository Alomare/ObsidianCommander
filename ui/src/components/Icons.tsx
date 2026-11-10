// Line icons in one style: 24 units, 1.8 stroke, square ends where the shape allows.
import type { SVGProps } from "react";

type P = SVGProps<SVGSVGElement>;
const base = (p: P) => ({
  width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8,
  strokeLinecap: "square" as const, strokeLinejoin: "miter" as const, "aria-hidden": true, ...p,
});

export const IPlay = (p: P) => <svg {...base(p)} fill="currentColor" stroke="none"><path d="M7 4.5v15l13-7.5z" /></svg>;
export const IPause = (p: P) => <svg {...base(p)}><path d="M8 5v14M16 5v14" strokeWidth={3} /></svg>;
export const IBack = (p: P) => <svg {...base(p)}><path d="M15 5l-7 7 7 7" /></svg>;
export const IPlus = (p: P) => <svg {...base(p)}><path d="M12 5v14M5 12h14" /></svg>;
export const IImport = (p: P) => <svg {...base(p)}><path d="M12 3v12M7 10l5 5 5-5M4 19h16" /></svg>;
export const IExport = (p: P) => <svg {...base(p)}><path d="M12 15V3M7 8l5-5 5 5M4 19h16" /></svg>;
export const ITrash = (p: P) => <svg {...base(p)}><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6" /></svg>;
export const IGear = (p: P) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1" />
  </svg>
);
export const IWarn = (p: P) => <svg {...base(p)}><path d="M12 3L22 20H2z" strokeLinejoin="miter" /><path d="M12 9.5v5M12 16.5v1.5" /></svg>;
export const IShield = (p: P) => <svg {...base(p)}><path d="M12 3l8 3v6c0 4.5-3.4 7.8-8 9-4.6-1.2-8-4.5-8-9V6z" /></svg>;
export const ITarget = (p: P) => <svg {...base(p)}><circle cx="12" cy="12" r="7" /><path d="M12 2v5M12 17v5M2 12h5M17 12h5" /></svg>;
export const ILan = (p: P) => <svg {...base(p)}><rect x="9" y="3" width="6" height="5" /><rect x="3" y="16" width="6" height="5" /><rect x="15" y="16" width="6" height="5" /><path d="M12 8v4M6 16v-4h12v4" /></svg>;
export const IUsers = (p: P) => <svg {...base(p)}><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20c.8-3.7 3.3-5.5 6.5-5.5s5.7 1.8 6.5 5.5" /><path d="M15.5 4.8a3.5 3.5 0 0 1 0 6.4M18 14.8c1.8.8 3 2.5 3.5 5.2" /></svg>;
export const IChart = (p: P) => <svg {...base(p)}><path d="M3 20h18M5 16l5-6 4 3 6-8" /></svg>;
export const IList = (p: P) => <svg {...base(p)}><path d="M8 6h13M8 12h13M8 18h13M3 6h1M3 12h1M3 18h1" /></svg>;
export const IStats = (p: P) => <svg {...base(p)}><path d="M5 20V11M12 20V4M19 20v-6" strokeWidth={2.6} /></svg>;
export const ICommand = (p: P) => <svg {...base(p)}><path d="M12 2l3 6 6.5 1-4.7 4.6 1.1 6.4L12 17l-5.9 3 1.1-6.4L2.5 9 9 8z" /></svg>;
export const IChevron = (p: P) => <svg {...base(p)}><path d="M9 5l7 7-7 7" /></svg>;
export const IClose = (p: P) => <svg {...base(p)}><path d="M6 6l12 12M18 6L6 18" /></svg>;
export const IUp = (p: P) => <svg {...base(p)}><path d="M5 15l7-7 7 7" /></svg>;
export const IDown = (p: P) => <svg {...base(p)}><path d="M5 9l7 7 7-7" /></svg>;
export const IFlag = (p: P) => <svg {...base(p)}><path d="M5 21V4M5 4h12l-2 4 2 4H5" /></svg>;
export const IClock = (p: P) => <svg {...base(p)}><circle cx="12" cy="12" r="8.5" /><path d="M12 7v5l3 2" /></svg>;
export const IEye = (p: P) => <svg {...base(p)}><path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></svg>;
export const IReset = (p: P) => <svg {...base(p)}><path d="M4 12a8 8 0 1 0 2.4-5.7M4 4v4h4" /></svg>;
export const IGlobe = (p: P) => <svg {...base(p)}><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18" /></svg>;
export const IBug = (p: P) => <svg {...base(p)}><ellipse cx="12" cy="13" rx="5" ry="7" /><path d="M12 6v14M7 10H3M7 15H3M17 10h4M17 15h4M9 5L7 2M15 5l2-3" /></svg>;
export const ICyborg = (p: P) => <svg {...base(p)}><path d="M5 4h14v9l-3 7H8l-3-7z" /><path d="M8 10h3M13 10h3" strokeWidth={2.4} /></svg>;
export const IIlluminate = (p: P) => <svg {...base(p)}><path d="M12 3l9 17H3z" /><circle cx="12" cy="14" r="2.5" /></svg>;

export const EnemyIcon = ({ enemy, ...p }: P & { enemy: number }) =>
  enemy === 0 ? <IBug {...p} /> : enemy === 1 ? <ICyborg {...p} /> : <IIlluminate {...p} />;
