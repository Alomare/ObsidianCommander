import { useEffect, useState } from "react";
import { hasToken, isMock } from "./api";
import { reportView, setHomeHandler } from "./bridge";
import { Notices, TipLayer } from "./components/ui";
import { WarList } from "./components/WarList";
import { CreateWar } from "./components/CreateWar";
import { WarView } from "./components/WarView";

type Route = { page: "list" } | { page: "create" } | { page: "war"; id: string };

const params = new URLSearchParams(location.search);
/** A LAN guest opens `?war=<id>` without a token: one war, view only. The mock takes `?ro=1` for the same. */
const guestWar = params.get("war");
export const readOnly = isMock ? params.get("ro") === "1" : !hasToken();

function fromHash(): Route {
  const h = location.hash.replace(/^#\/?/, "");
  if (h === "create") return { page: "create" };
  const m = /^war\/([A-Za-z0-9_-]{1,64})$/.exec(h);
  if (m) return { page: "war", id: m[1] };
  return { page: "list" };
}

export function App() {
  const [route, setRoute] = useState<Route>(() => (guestWar ? { page: "war", id: guestWar } : fromHash()));

  useEffect(() => {
    if (guestWar) return;
    const on = () => setRoute(fromHash());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);

  const go = (r: Route) => {
    if (guestWar) return;
    const h = r.page === "list" ? "" : r.page === "create" ? "#/create" : `#/war/${r.id}`;
    history.pushState(null, "", location.pathname + location.search + h);
    setRoute(r);
  };

  // Obsidian hears which screen shows, and the Commander tab there brings the war list back.
  useEffect(() => { reportView(route.page); }, [route.page]);
  useEffect(() => {
    if (guestWar) return;
    setHomeHandler(() => go({ page: "list" }));
    return () => setHomeHandler(null);
  });

  return (
    <div className="app">
      {route.page === "list" && <WarList readOnly={readOnly} onOpen={(id) => go({ page: "war", id })} onCreate={() => go({ page: "create" })} />}
      {route.page === "create" && <CreateWar onCancel={() => go({ page: "list" })} onCreated={(id) => go({ page: "war", id })} />}
      {route.page === "war" && <WarView id={route.id} readOnly={readOnly} guest={!!guestWar} onBack={() => go({ page: "list" })} />}
      <TipLayer />
      <Notices />
    </div>
  );
}
