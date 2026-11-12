"use client";

import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { useI18n } from "@/components/I18nProvider";

export default function LoginPage() {
  const router = useRouter();
  const { t } = useI18n();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    setError(null);
    const fd = new FormData(e.currentTarget);
    const res = await signIn("credentials", {
      email: String(fd.get("email") || ""),
      password: String(fd.get("password") || ""),
      redirect: false,
    });
    setPending(false);
    if (res?.error) {
      setError(t("common.invalidCredentials"));
      return;
    }
    router.push("/");
    router.refresh();
  }

  return (
    <div className="login">
      <form className="login-box stack" onSubmit={onSubmit}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start" }}>
          <div>
            <h1 className="brand" style={{ fontSize: 30 }}>
              Lien<span>Radar</span>
            </h1>
            <p className="sub">{t("login.subtitle")}</p>
          </div>
          <LanguageSwitcher />
        </div>
        <label>
          {t("common.email")}
          <input className="field" name="email" type="email" defaultValue="owner@lienradar.local" required />
        </label>
        <label>
          {t("common.password")}
          <input className="field" name="password" type="password" defaultValue="lienradar" required />
        </label>
        {error ? <div className="barrier">{error}</div> : null}
        <button className="btn" type="submit" disabled={pending}>
          {pending ? t("common.signingIn") : t("common.signIn")}
        </button>
        <p className="muted" style={{ fontSize: 12 }}>
          {t("common.seedUser")}
        </p>
      </form>
    </div>
  );
}
