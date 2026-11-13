import cron from "node-cron";
import { prisma } from "@lienradar/db";
import { REMOVED_REO_RESOURCE_KEYS, SCHEDULED_JOBS } from "@lienradar/shared";
import { loadRootEnv } from "./loadEnv.js";
import { auctionProxySummary } from "./proxy.js";
import { runJob } from "./pipeline.js";

loadRootEnv();
console.log(`[worker] auction proxy: ${auctionProxySummary()}`);

const runningJobs = new Set<string>();

async function disableRemovedJobs() {
  await prisma.scheduledJob.updateMany({
    where: { key: "reo_daily" },
    data: {
      enabled: false,
      description: "Removed — Auction.com / Hubzu Bank REO job disabled",
    },
  });
  await prisma.dataResource.updateMany({
    where: { key: { in: [...REMOVED_REO_RESOURCE_KEYS] } },
    data: {
      enabled: false,
      detail: "Removed — Auction.com / Hubzu Bank REO sources disabled",
    },
  });
}

/**
 * Clear orphaned RUNNING rows after a hard kill.
 * Jobs also run in the web `after()` path, so only age out long-stuck rows —
 * never wipe fresh RUNNING on every worker restart.
 */
async function recoverStuckRuns() {
  const cutoff = new Date(Date.now() - 90 * 60_000);
  const stuckJobs = await prisma.scheduledJob.updateMany({
    where: {
      lastStatus: "RUNNING",
      lastStartedAt: { lt: cutoff },
    },
    data: {
      lastStatus: "FAILED",
      lastFinishedAt: new Date(),
      lastError: "cleared stuck RUNNING (no finish within 90m)",
    },
  });
  const stuckRuns = await prisma.ingestRun.updateMany({
    where: {
      status: "RUNNING",
      startedAt: { lt: cutoff },
    },
    data: {
      status: "FAILED",
      finishedAt: new Date(),
      errorSummary: "cleared stuck RUNNING (no finish within 90m)",
    },
  });
  if (stuckJobs.count || stuckRuns.count) {
    console.log(
      `[worker] recovered stuck RUNNING jobs=${stuckJobs.count} runs=${stuckRuns.count}`,
    );
  }
}

async function runNamed(jobKey: string) {
  // Honor DB enabled flag even if a stale cron task still fires.
  if (jobKey !== "all") {
    if (jobKey === "reo_daily") {
      console.log(`[worker] job=${jobKey} skipped (removed)`);
      return;
    }
    const row = await prisma.scheduledJob.findUnique({ where: { key: jobKey } });
    if (row && !row.enabled) {
      console.log(`[worker] job=${jobKey} skipped (disabled in DB)`);
      return;
    }
  }
  if (runningJobs.has(jobKey)) {
    console.log(`[worker] job=${jobKey} skipped (already running)`);
    return;
  }
  runningJobs.add(jobKey);
  console.log(`[worker] job=${jobKey} start`);
  try {
    const result = await runJob(jobKey);
    console.log(`[worker] job=${jobKey} done`, result);
  } catch (e) {
    console.error(`[worker] job=${jobKey} failed`, e);
  } finally {
    runningJobs.delete(jobKey);
  }
}

const once = process.argv.includes("--once");
const jobArg = process.argv.find((a) => a.startsWith("--job="))?.slice(6);

if (once) {
  await runNamed(jobArg || "all");
  process.exit(0);
}

type TaskHandle = { stop: () => void };

const active = new Map<string, { cronExpr: string; timezone: string; task: TaskHandle }>();

async function ensureJobRows() {
  for (const def of SCHEDULED_JOBS) {
    await prisma.scheduledJob.upsert({
      where: { key: def.key },
      create: {
        key: def.key,
        name: def.name,
        cronExpr: def.cronExpr,
        description: def.description,
        timezone: def.timezone,
        enabled: true,
      },
      update: {
        name: def.name,
        description: def.description,
        // Keep operator-edited cronExpr / enabled as source of truth.
      },
    });
  }
}

async function syncSchedules() {
  const jobs = await prisma.scheduledJob.findMany();
  const seen = new Set<string>();

  for (const job of jobs) {
    seen.add(job.key);
    const existing = active.get(job.key);

    if (!job.enabled) {
      if (existing) {
        existing.task.stop();
        active.delete(job.key);
        console.log(`[worker] stopped schedule ${job.key}`);
      }
      continue;
    }

    if (!cron.validate(job.cronExpr)) {
      console.error(`[worker] invalid cron for ${job.key}: ${job.cronExpr}`);
      continue;
    }

    const same =
      existing &&
      existing.cronExpr === job.cronExpr &&
      existing.timezone === job.timezone;
    if (same) continue;

    if (existing) {
      existing.task.stop();
      active.delete(job.key);
    }

    const task = cron.schedule(
      job.cronExpr,
      () => {
        void runNamed(job.key);
      },
      { timezone: job.timezone },
    );
    active.set(job.key, { cronExpr: job.cronExpr, timezone: job.timezone, task });
    console.log(`[worker] scheduled ${job.key} :: ${job.cronExpr} (${job.timezone})`);
  }

  for (const key of [...active.keys()]) {
    if (!seen.has(key)) {
      active.get(key)?.task.stop();
      active.delete(key);
      console.log(`[worker] removed stale schedule ${key}`);
    }
  }
}

console.log("[worker] registering cron schedules (DB-backed enable + cron)");
await ensureJobRows();
await disableRemovedJobs();
await recoverStuckRuns();
await syncSchedules();
setInterval(() => {
  void syncSchedules().catch((e) => console.error("[worker] schedule sync failed", e));
}, 30_000);

// Optional startup full refresh (off by default — cron + admin trigger are enough).
if (process.env.WORKER_RUN_ALL_ON_BOOT === "1") {
  void runNamed("all");
}
