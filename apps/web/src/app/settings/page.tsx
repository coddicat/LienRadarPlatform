import { getServerSession } from "next-auth";
import { MethodSettingsForm } from "@/components/MethodSettingsForm";
import { Shell } from "@/components/Shell";
import { authOptions } from "@/lib/auth";
import { getI18n } from "@/lib/i18n";
import { getUserMethodSettings } from "@/lib/methodSettings";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const session = await getServerSession(authOptions);
  const { t } = await getI18n();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  const settings = await getUserMethodSettings(userId);

  return (
    <Shell active="settings" email={session?.user?.email}>
      <div className="page-head">
        <h1>{t("settings.title")}</h1>
        <p className="sub">{t("settings.subtitle")}</p>
      </div>
      <div className="callout">{t("settings.tip")}</div>
      <MethodSettingsForm initial={settings} />
    </Shell>
  );
}
