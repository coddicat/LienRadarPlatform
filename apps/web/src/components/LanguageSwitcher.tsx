"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { useI18n } from "@/components/I18nProvider";
import type { Locale } from "@/lib/i18n-core";

export function LanguageSwitcher() {
  const { locale, t } = useI18n();
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  async function setLocale(next: Locale) {
    if (next === locale) return;
    await fetch("/api/locale", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ locale: next }),
    });
    startTransition(() => router.refresh());
  }

  return (
    <label className="muted" style={{ display: "inline-flex", gap: 6, alignItems: "center", fontSize: 13 }}>
      <span>{t("nav.language")}</span>
      <select
        className="field"
        style={{ padding: "4px 8px", fontSize: 12 }}
        value={locale}
        disabled={pending}
        onChange={(e) => void setLocale(e.target.value as Locale)}
        aria-label={t("nav.language")}
      >
        <option value="en">EN</option>
        <option value="ru">RU</option>
      </select>
    </label>
  );
}
