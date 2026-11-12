import { CacheKeys, CacheTtl, cacheDel, cacheGetJson, cacheSetJson } from "@lienradar/cache";
import { prisma } from "@lienradar/db";
import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { getNextCronDate } from "@/lib/cronNext";
import { countiesForJobKey } from "@/lib/jobCounties";

export const dynamic = "force-dynamic";

function serializeJob(j: {
  id: string;
  key: string;
  name: string;
  description: string;
  cronExpr: string;
  timezone: string;
  enabled: boolean;
  lastStartedAt: Date | null;
  lastFinishedAt: Date | null;
  lastStatus: string | null;
  lastError: string | null;
  lastCounts: unknown;
}) {
  const nextRunAt =
    j.enabled ? getNextCronDate(j.cronExpr, j.timezone)?.toISOString() ?? null : null;
  return {
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
    lastCounts: j.lastCounts ?? null,
    nextRunAt,
    running: j.lastStatus === "RUNNING",
    counties: countiesForJobKey(j.key),
  };
}

async function loadJobsPayload() {
  const [jobs, resources, runs] = await Promise.all([
    prisma.scheduledJob.findMany({ orderBy: { cronExpr: "asc" } }),
    prisma.dataResource.findMany({
      where: { enabled: true },
      orderBy: [{ kind: "asc" }, { name: "asc" }],
    }),
    prisma.ingestRun.findMany({ orderBy: { startedAt: "desc" }, take: 50 }),
  ]);

  return {
    syncedAt: new Date().toISOString(),
    jobs: jobs.map(serializeJob),
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
      counts: r.counts ?? null,
      errorSummary: r.errorSummary,
      notes: r.notes,
    })),
  };
}

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const cached = await cacheGetJson<Awaited<ReturnType<typeof loadJobsPayload>>>(CacheKeys.adminJobs);
  if (cached) {
    return NextResponse.json({ ...cached, cache: "hit" });
  }

  const payload = await loadJobsPayload();
  await cacheSetJson(CacheKeys.adminJobs, payload, CacheTtl.adminJobsSec);
  return NextResponse.json({ ...payload, cache: "miss" });
}

export async function PATCH(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const key = String(body.key || "");
  if (!key) return NextResponse.json({ error: "key required" }, { status: 400 });

  const data: { enabled?: boolean; cronExpr?: string } = {};
  if (typeof body.enabled === "boolean") data.enabled = body.enabled;
  if (typeof body.cronExpr === "string" && body.cronExpr.trim()) {
    const expr = body.cronExpr.trim();
    if (expr.split(/\s+/).length !== 5) {
      return NextResponse.json({ error: "cron must be 5 fields (m h dom mon dow)" }, { status: 400 });
    }
    data.cronExpr = expr;
  }
  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "nothing to update" }, { status: 400 });
  }

  const updated = await prisma.scheduledJob.update({
    where: { key },
    data,
  });
  await cacheDel(CacheKeys.adminJobs, CacheKeys.dashStats);

  return NextResponse.json({ job: serializeJob(updated) });
}
