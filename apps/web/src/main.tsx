import { createRoot } from "react-dom/client";
import { App } from "./App";
import { registerServiceWorker } from "./pwa/registerServiceWorker";

createRoot(document.getElementById("app-root")!).render(<App />);

registerServiceWorker();
