import { createRoot } from "react-dom/client";
import { I18nProvider } from "../../extension/src/i18n";
import { App } from "./App";
import { registerServiceWorker } from "./pwa/registerServiceWorker";

createRoot(document.getElementById("app-root")!).render(
  <I18nProvider>
    <App />
  </I18nProvider>,
);

registerServiceWorker();
