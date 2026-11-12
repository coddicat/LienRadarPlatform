import { invalidateUiCaches } from "@lienradar/cache";
import { prisma, ResourceHealth } from "@lienradar/db";
import { DATA_RESOURCES } from "@lienradar/shared";

const RESOURCE_META = new Map(DATA_RESOURCES.map((r) => [r.key, r]));

export async function setResourceStatus(input: {
  key: string;
  status: ResourceHealth;
  detail?: string;
  lastError?: string | null;
  success?: boolean;
}) {
  const now = new Date();
  const meta = RESOURCE_META.get(input.key);
  await prisma.dataResource.upsert({
    where: { key: input.key },
    update: {
      status: input.status,
      detail: input.detail,
      lastError: input.lastError ?? null,
      lastCheckedAt: now,
      ...(input.success ? { lastSuccessAt: now } : {}),
    },
    create: {
      key: input.key,
      name: meta?.name ?? input.key,
      kind: meta?.kind ?? "unknown",
      endpoint: meta?.endpoint,
      usedByJobs: meta?.usedByJobs ?? [],
      enabled: true,
      status: input.status,
      detail: input.detail,
      lastError: input.lastError ?? null,
      lastCheckedAt: now,
      lastSuccessAt: input.success ? now : undefined,
    },
  });
}

export async function markJobStart(key: string) {
  await prisma.scheduledJob.updateMany({
    where: { key },
    data: { lastStartedAt: new Date(), lastStatus: "RUNNING", lastError: null },
  });
}

export async function markJobFinish(
  key: string,
  status: "SUCCESS" | "PARTIAL" | "FAILED",
  counts?: Record<string, number>,
  error?: string,
) {
  await prisma.scheduledJob.updateMany({
    where: { key },
    data: {
      lastFinishedAt: new Date(),
      lastStatus: status,
      lastCounts: counts ?? undefined,
      lastError: error ?? null,
    },
  });
  void invalidateUiCaches();
}
