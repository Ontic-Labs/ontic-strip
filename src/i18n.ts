import i18n from "i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import HttpBackend from "i18next-http-backend";
import { initReactI18next, useTranslation as useTranslationBase } from "react-i18next";

// Supported namespaces and languages
export const namespaces = ["ui", "layout", "feed", "pages", "stories", "strip"] as const;
export const defaultNS = "ui";

// i18n initialization
void i18n
  .use(HttpBackend)
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    fallbackLng: "en",
    supportedLngs: ["en", "pt-BR"],
    load: "currentOnly",
    ns: namespaces,
    defaultNS,
    backend: {
      loadPath: "/locales/{{lng}}/{{ns}}.json",
    },
    compatibilityJSON: "v4",
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  });

// Typed useTranslation helper
export const useTranslation = useTranslationBase;
export default i18n;
