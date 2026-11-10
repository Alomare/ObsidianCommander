// A small static copy of the war map, for the war list.
import { memo } from "react";
import type { FrontBrief } from "../types";
import { FACTION_OF } from "../util";
import { OUTER_R, REGIONS, SUPER_EARTH_R, gameColor } from "./geometry";

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
        const fill = st === "liberated" ? gameColor("helldivers", "fill_color", 0.75)
          : st === "front" ? gameColor(r.faction, "active_fill_color", 1)
          : st === "home" ? gameColor(r.faction, "hq_fill_color", 1.3)
          : st === "hidden" ? gameColor("hidden", "fill_color", 2.5)
          : gameColor(r.faction, "fill_color", 1.6);
        return <path key={r.id} d={r.path} style={{ fill }} className="mm-region" />;
      })}
      <circle r={SUPER_EARTH_R} className="mm-se" />
    </svg>
  );
});
