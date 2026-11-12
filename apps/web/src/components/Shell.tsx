import Link from "next/link";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { getI18n } from "@/lib/i18n";

export async function Shell({
  children,
  active,
  email,
}: {
  children: React.ReactNode;
  active?: string;
  email?: string | null;
}) {
  const { t } = await getI18n();
  const items = [
    { href: "/", label: t("nav.dashboard"), key: "dashboard" },
    { href: "/lots", label: t("nav.lots"), key: "lots" },
    { href: "/pipeline", label: t("nav.pipeline"), key: "pipeline" },
    { href: "/admin", label: t("nav.admin"), key: "admin" },
    { href: "/settings", label: t("nav.settings"), key: "settings" },
  ];
  return (
    <div className="shell">
      <header className="topbar">
        <Link href="/" className="brand" aria-label="LienRadar">
          Lien<span>Radar</span>
        </Link>
        <nav className="nav">
          {items.map((item) => (
            <Link key={item.key} href={item.href} className={active === item.key ? "active" : undefined}>
              {item.label}
            </Link>
          ))}
          <LanguageSwitcher />
          {email ? <span className="muted">{email}</span> : null}
          <Link href="/api/auth/signout">{t("nav.signOut")}</Link>
        </nav>
      </header>
      <main className="main">{children}</main>
    </div>
  );
}
