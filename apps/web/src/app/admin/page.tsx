import { prisma } from "@lienradar/db";
import { getServerSession } from "next-auth";
import { JobsConsole } from "@/components/JobsConsole";
import { Shell } from "@/components/Shell";
import { authOptions } from "@/lib/auth";
import { getNextCronDate } from "@/lib/cronNext";
import { getI18n } from "@/lib/i18n";
import { countiesForJobKey } from "@/lib/jobCounties";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const session = await getServerSession(authOptions);
  const { t } = await getI18n();
  const [jobs, resources, runs, lotCount] = await Promise.all([
    prisma.scheduledJob.findMany({ orderBy: { cronExpr: "asc" } }),
    prisma.dataResource.findMany({ where: { enabled: true }, orderBy: [{ kind: "asc" }, { name: "asc" }] }),
    prisma.ingestRun.findMany({ orderBy: { startedAt: "desc" }, take: 50 }),
    prisma.lot.count(),
  ]);

  const initial = {
    syncedAt: new Date().toISOString(),
    jobs: jobs.map((j) => ({
      id: j.id,
      key: j.key,
      name: j.name,
      description: j.description,
      cronExpr: j.cronExpr,
      timezone: j.timezone,
      enabled: j.enabled,
      lastStartedAt: j.lastStartedAt?.toISOString() ?? null,
      lastFinishedAt: j.lastFinishedAt?.toISOString() ?? null,
      lastStatus: j.lastStatus,
      lastError: j.lastError,
      lastCounts: (j.lastCounts as Record<string, unknown> | null) ?? null,
      nextRunAt: j.enabled
        ? getNextCronDate(j.cronExpr, j.timezone)?.toISOString() ?? null
        : null,
      running: j.lastStatus === "RUNNING",
      counties: countiesForJobKey(j.key),
    })),
    resources: resources.map((r) => ({
      id: r.id,
      key: r.key,
      name: r.name,
      kind: r.kind,
      status: r.status,
      endpoint: r.endpoint,
      detail: r.detail,
      lastError: r.lastError,
      lastCheckedAt: r.lastCheckedAt?.toISOString() ?? null,
      lastSuccessAt: r.lastSuccessAt?.toISOString() ?? null,
    })),
    runs: runs.map((r) => ({
      id: r.id,
      stage: r.stage,
      status: r.status,
      startedAt: r.startedAt.toISOString(),
      finishedAt: r.finishedAt?.toISOString() ?? null,
      counts: (r.counts as Record<string, unknown> | null) ?? null,
      errorSummary: r.errorSummary,
      notes: r.notes,
    })),
  };

  return (
    <Shell active="admin" email={session?.user?.email}>
      <div className="page-head">
        <h1>{t("admin.title")}</h1>
        <p className="sub">{t("admin.subtitle")}</p>
      </div>
      <JobsConsole initial={initial} lotCount={lotCount} />
    </Shell>
  );
}
