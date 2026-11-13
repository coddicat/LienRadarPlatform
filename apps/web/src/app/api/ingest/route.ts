import { invalidateUiCaches } from "@lienradar/cache";
import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
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

/**
 * Admin "run once" / refresh: mark jobs RUNNING and let the ingest worker claim them.
 * Playwright calendar pulls must not run inside the web `after()` path (1GB, deploy kills).
 */
export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const job = String(body.job || body.stage || "all");
  const asyncMode = body.async !== false;

  try {
    const ingest = await import("@lienradar/ingest");
    if (typeof ingest.loadRootEnv === "function") ingest.loadRootEnv();

    if (asyncMode) {
      const markedRunning =
        job === "all" ? [...ALL_REFRESH_JOB_KEYS] : [job];

      if (typeof ingest.markJobStart === "function") {
        await Promise.all(markedRunning.map((key) => ingest.markJobStart(key)));
      }
      await invalidateUiCaches();

      return NextResponse.json(
        {
          job,
          accepted: true,
          markedRunning,
          queuedForWorker: true,
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
