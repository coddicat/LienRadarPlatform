import en from "@/messages/en.json";
import ru from "@/messages/ru.json";

export const locales = ["en", "ru"] as const;
export type Locale = (typeof locales)[number];
export const LOCALE_COOKIE = "lr_locale";
export const defaultLocale: Locale = "en";

export type Dictionary = typeof en;

const catalogs: Record<Locale, Dictionary> = { en, ru };

export function isLocale(value: string | undefined | null): value is Locale {
  return value === "en" || value === "ru";
}

export function getDictionary(locale: Locale): Dictionary {
  return catalogs[locale] ?? catalogs.en;
}

type DictValue = string | { [key: string]: DictValue };

export function createTranslator(dict: Dictionary) {
  return function t(path: string, vars?: Record<string, string | number>): string {
    const parts = path.split(".");
    let cur: DictValue = dict as unknown as DictValue;
    for (const part of parts) {
      if (cur == null || typeof cur === "string") return path;
      cur = cur[part];
    }
    if (typeof cur !== "string") return path;
    if (!vars) return cur;
    return Object.entries(vars).reduce(
      (s, [k, v]) => s.replaceAll(`{${k}}`, String(v)),
      cur,
    );
  };
}
