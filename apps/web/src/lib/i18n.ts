import { cookies } from "next/headers";
import {
  LOCALE_COOKIE,
  createTranslator,
  defaultLocale,
  getDictionary,
  isLocale,
  type Locale,
} from "@/lib/i18n-core";

export {
  LOCALE_COOKIE,
  createTranslator,
  defaultLocale,
  getDictionary,
  isLocale,
  locales,
  type Dictionary,
  type Locale,
} from "@/lib/i18n-core";

export async function getLocale(): Promise<Locale> {
  const jar = await cookies();
  const raw = jar.get(LOCALE_COOKIE)?.value;
  return isLocale(raw) ? raw : defaultLocale;
}

export async function getI18n() {
  const locale = await getLocale();
  const dict = getDictionary(locale);
  const t = createTranslator(dict);
  return { locale, dict, t };
}
