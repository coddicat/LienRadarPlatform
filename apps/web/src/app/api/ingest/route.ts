import { invalidateUiCaches } from "@lienradar/cache";
import { getServerSession } from "next-auth";
import { after, NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";

/** Jobs touched by runJob("all") — keep in sync with pipeline `case "all"`. */
const ALL_REFRESH_JOB_KEYS = [
  "calendar_6h",
  "enrich_folio_6h",
  "enrich_pa_6h",
  "enrich_muni_6h",
  "enrich_flood_6h",
  "enrich_clerk_nightly",
  "enrich_tax_nightly",
  "enrich_or_nightly",
  "method_nightly",
] as const;

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const job = String(body.job || body.stage || "all");
  // Default async so the admin UI is not blocked for minutes while collectors run.
  const asyncMode = body.async !== false;

  try {
    const ingest = await import("@lienradar/ingest");
    if (typeof ingest.loadRootEnv === "function") ingest.loadRootEnv();

    if (asyncMode) {
      const markedRunning =
        job === "all" ? [...ALL_REFRESH_JOB_KEYS] : [job];

      // Mark RUNNING before responding so live poll / page refresh shows progress.
      if (typeof ingest.markJobStart === "function") {
        await Promise.all(markedRunning.map((key) => ingest.markJobStart(key)));
      }
      await invalidateUiCaches();

      // next/server `after` keeps work alive after the 202 response (avoids hung UI wait).
      after(async () => {
        try {
          const result = await ingest.runJob(job);
          console.log(`[api/ingest] job=${job} done`, result);
        } catch (e) {
          console.error(`[api/ingest] job=${job} failed`, e);
          if (typeof ingest.markJobFinish === "function") {
            // Only clear jobs still marked RUNNING (sub-jobs that already finished keep status).
            const { prisma } = await import("@lienradar/db");
            const stuck = await prisma.scheduledJob.findMany({
              where: { key: { in: markedRunning }, lastStatus: "RUNNING" },
              select: { key: true },
            });
            await Promise.allSettled(
              stuck.map((row) =>
                ingest.markJobFinish(
                  row.key,
                  "FAILED",
                  {},
                  e instanceof Error ? e.message : String(e),
                ),
              ),
            );
          }
        } finally {
          await invalidateUiCaches();
        }
      });

      return NextResponse.json(
        {
          job,
          accepted: true,
          markedRunning,
        },
        { status: 202 },
      );
    }

    const result = await ingest.runJob(job);
    return NextResponse.json({ job, result });
  } catch (e) {
    return NextResponse.json(
      { job, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
