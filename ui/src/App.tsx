import { useEffect, useState } from "react";
import { api, hasToken, isMock } from "./api";
import { reportView, setHostHandlers } from "./bridge";
import { Notices, TipLayer, notify } from "./components/ui";
import { WarList } from "./components/WarList";
import { CreateWar } from "./components/CreateWar";
import { WarView } from "./components/WarView";
import { t } from "./strings";

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

/** Imports a war file from its text, the same way for Import in the war list and Import in the Obsidian bar.
    Answers the new war id, or null after a notice. */
export async function importWarText(text: string): Promise<string | null> {
  try {
    const w = await api.importWar(JSON.parse(text));
    notify(t("importDone"));
    return w.id;
  } catch {
    notify(t("importFailed"), true);
    return null;
  }
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

  // Obsidian hears which screen shows; the Commander tab there brings the war list back, and the Import and
  // New War buttons of the Obsidian bar act here.
  useEffect(() => { reportView(route.page); }, [route.page]);
  useEffect(() => {
    if (guestWar) return;
    setHostHandlers({
      home: () => go({ page: "list" }),
      create: () => { if (!readOnly) go({ page: "create" }); },
      importText: async (text) => { if (readOnly) return; const id = await importWarText(text); if (id) go({ page: "war", id }); },
    });
    return () => setHostHandlers(null);
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
