import { createRoot } from "react-dom/client";
import "@fontsource-variable/saira";
import "@fontsource/barlow/400.css";
import "@fontsource/barlow/500.css";
import "@fontsource/barlow/600.css";
import "./styles.css";
import { initApi } from "./api";
import { startBridge } from "./bridge";
import { App } from "./App";

startBridge();
initApi().then(() => createRoot(document.getElementById("root")!).render(<App />));
