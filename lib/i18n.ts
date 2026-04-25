"use client";

/**
 * UI copy is English-only. Commentary language is tracked separately on
 * the store (`commentLang`) and applied only when generating commentary.
 *
 *   const t = useTranslations();
 *   <div>{t("Pause", "暂停")}</div>
 *
 * The Chinese argument is retained at call sites purely for future-proofing
 * — if we reintroduce a UI language toggle, every string is already paired.
 */
export function useTranslations() {
  return (en: string, _zh: string) => en;
}
