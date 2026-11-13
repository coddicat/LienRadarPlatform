import { getServerSession } from "next-auth";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { RunPullPageClient } from "@/components/RunPullPageClient";
import { Shell } from "@/components/Shell";
import { authOptions } from "@/lib/auth";
import { getI18n } from "@/lib/i18n";

export const dynamic = "force-dynamic";

export default async function AdminRunPullPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await getServerSession(authOptions);
  if (!session?.user) redirect("/login");

  const { id } = await params;
  if (!id?.trim()) notFound();

  const { t } = await getI18n();

  return (
    <Shell active="admin" email={session.user.email}>
      <div className="page-head lots-page-head">
        <div>
          <h1>{t("admin.pulledDataTitle")}</h1>
          <p className="sub">{t("admin.pulledDataSubtitle")}</p>
        </div>
        <Link className="btn secondary" href="/admin">
          {t("admin.backToAdmin")}
        </Link>
      </div>
      <div className="panel panel-pad run-pull-panel">
        <RunPullPageClient runId={id} />
      </div>
    </Shell>
  );
}
