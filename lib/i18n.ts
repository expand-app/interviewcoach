"use client";

import { useStore } from "./store";

/**
 * Minimal i18n: we only have two locales and a small UI surface, so instead
 * of a translation table, we pass both strings at the call site.
 *
 *   const t = useTranslations();
 *   <div>{t("Pause", "暂停")}</div>
 */
export function useTranslations() {
  const lang = useStore((s) => s.commentLang);
  return (en: string, zh: string) => (lang === "zh" ? zh : en);
}
