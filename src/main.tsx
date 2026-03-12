
import { createRoot } from "react-dom/client";
import { HelmetProvider } from "react-helmet-async";
import App from "./App.tsx";
import "./index.css";
import "./i18n";
import { I18nextProvider } from "react-i18next";
import i18n from "./i18n";
import { Suspense } from "react";

createRoot(document.getElementById("root")!).render(
  <Suspense fallback={<div>Loading…</div>}>
    <I18nextProvider i18n={i18n}>
      <HelmetProvider>
        <App />
      </HelmetProvider>
    </I18nextProvider>
  </Suspense>,
);
