// A small static copy of the war map, for the war list.
import { memo } from "react";
import type { FrontBrief } from "../types";
import { FACTION_OF } from "../util";
import { OUTER_R, REGIONS, SUPER_EARTH_R } from "./geometry";
import { PLANETS, RIM, SECTORS, START_OWNERS, ownerColor, sectorHolder } from "./galaxy";
import { sideColor } from "../palette";

function stateOf(fronts: FrontBrief[] | undefined, enemy: number, index: number) {
  const f = fronts?.find((x) => x.enemy === enemy);
  if (!f || f.status === "hidden") return "hidden";
  if (f.status === "defeated") return "liberated";
  const cur = f.region || (f.points != null && f.points_max ? Math.min(10, Math.max(1, Math.floor(f.points / (f.points_max / 10)) + 1)) : 1);
  if (index >= 11) return "home";
  return index < cur ? "liberated" : index === cur ? "front" : "enemy";
}

export const MiniMap = memo(function MiniMap({ fronts }: { fronts?: FrontBrief[] }) {
  const R = OUTER_R + 8;
  return (
    <svg className="minimap" viewBox={`${-R} ${-R} ${R * 2} ${R * 2}`} aria-hidden>
      <circle r={OUTER_R + 6} className="mm-back" />
      {REGIONS.map((r) => {
        const st = stateOf(fronts, FACTION_OF.indexOf(r.faction), r.index);
        const fill = st === "liberated" ? sideColor("superearth", 0.45)
          : st === "front" ? sideColor(r.faction, 0.75)
          : st === "home" ? sideColor(r.faction, 0.9)
          : st === "hidden" ? "rgba(120, 140, 170, 0.25)"
          : sideColor(r.faction, 0.38);
        return <path key={r.id} d={r.path} style={{ fill }} className="mm-region" />;
      })}
      <circle r={SUPER_EARTH_R} className="mm-se" />
    </svg>
  );
});

/** The Evolved galaxy in small: the sectors by who holds them, the starting owners when none are given. */
export const EvoMiniMap = memo(function EvoMiniMap({ owners }: { owners?: number[] }) {
  const own = owners && owners.length === PLANETS.length ? owners : START_OWNERS;
  const R = RIM + 10;
  return (
    <svg className="minimap" viewBox={`${-R} ${-R} ${R * 2} ${R * 2}`} aria-hidden>
      <circle r={RIM + 6} className="mm-back" />
      {SECTORS.map((s) => {
        const h = sectorHolder(own, s);
        return <path key={s.id} d={s.path} style={{ fill: ownerColor(h.owner, h.owner === 0 ? 0.3 : 0.32 + 0.45 * h.share) }} className="mm-sector" />;
      })}
      <circle r={RIM} className="mm-rim" />
      <circle r={30} className="mm-se" />
    </svg>
  );
});
