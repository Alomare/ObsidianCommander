// Every war setting with a plain description and a range. Used by Create War and by Settings.
import { Fragment } from "react";
import { FIELDS, fromShown, toShown, type Field } from "../settings";
import { t, tk, type StringKey } from "../strings";
import type { Settings } from "../types";
import { num } from "../util";
import { NumberField, Switch } from "./ui";

function unit(f: Field): string {
  if (f.kind === "chance") return t("percentPerHour");
  if (f.kind === "hours") return t("hours");
  if (f.key === "pressure_per_hour") return t("perHour");
  return t("points");
}

export function SettingsForm({ value, onChange }: { value: Settings; onChange: (s: Settings) => void }) {
  const groups: StringKey[] = ["groupFronts", "groupDefense", "groupAttack"];
  const set = (f: Field, shown: number) => onChange({ ...value, [f.key]: fromShown(f, shown) });
  const step = value.points_max / 10;
  return (
    <div className="settings-form">
      {groups.map((g) => (
        <Fragment key={g}>
          <h3 className="form-group cap">{t(g)}</h3>
          {FIELDS.filter((f) => f.group === g).map((f) => {
            const shown = toShown(f, value[f.key]);
            const max = f.key === "start_points" ? value.points_max : f.max;
            const off = f.key === "defend_chance_per_hour" && !value.director;
            return (
              <div key={f.key} className={`set-row${off ? " off" : ""}`}>
                <div className="set-text">
                  <label className="set-name">{tk(`set_${f.key}`)}</label>
                  <small>{tk(`setText_${f.key}`)}</small>
                  {f.key === "start_points" && <small className="set-hint">{t("regionOf", { n: Math.min(10, Math.floor(value.start_points / step) + 1) })}</small>}
                  {f.key === "points_max" && <small className="set-hint">{num(step)} {t("points")} / {t("region").toLowerCase()}</small>}
                </div>
                <div className="set-ctl">
                  {f.kind === "bool"
                    ? <Switch on={!!value[f.key]} onChange={(v) => set(f, v ? 1 : 0)} label={tk(`set_${f.key}`)} />
                    : <>
                      <input type="range" min={f.min} max={max} step={f.step} value={Math.min(max, shown)} onChange={(e) => set(f, Number(e.target.value))} aria-label={tk(`set_${f.key}`)} disabled={off} />
                      <NumberField value={shown} min={f.min} max={max} step={f.step} onChange={(v) => set(f, v)} suffix={unit(f)} />
                    </>}
                </div>
              </div>
            );
          })}
        </Fragment>
      ))}
    </div>
  );
}
