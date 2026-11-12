import { LayerStatus } from "@lienradar/shared";
import { Prisma, prisma } from "@lienradar/db";

/**
 * Miami-Dade Clerk Developers API — gated on MIAMI_DADE_CLERK_AUTH_KEY.
 * Free OCS docket remains the default case path; this records AuthKey health and
 * stores any successful official-records style responses when the key works.
 */
export async function probeClerkApi(authKey: string): Promise<{
  ok: boolean;
  error?: string;
  detail?: string;
}> {
  // Public developers portal reachability + key presence check.
  try {
    const res = await fetch("https://www2.miamidadeclerk.gov/Developers/", {
      signal: AbortSignal.timeout(20_000),
      redirect: "follow",
      headers: {
        "User-Agent": "LienRadarPlatform/0.1",
        Authorization: `Bearer ${authKey}`,
      },
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return {
      ok: true,
      detail: "Developers portal reachable; AuthKey present (OR image endpoints remain paid/gated)",
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function applyClerkAuthNote(lotId: string, detail: string) {
  await prisma.enrichmentLayer.upsert({
    where: { lotId_name: { lotId, name: "clerk_api" } },
    update: {
      status: LayerStatus.PARTIAL,
      payload: {
        note: detail,
        authKeyConfigured: true,
        orImages: "paid_per_request — use free OCS for parties; attach OR docs via Manual DD for L2",
      } as Prisma.InputJsonValue,
      fetchedAt: new Date(),
    },
    create: {
      lotId,
      name: "clerk_api",
      status: LayerStatus.PARTIAL,
      payload: {
        note: detail,
        authKeyConfigured: true,
        orImages: "paid_per_request — use free OCS for parties; attach OR docs via Manual DD for L2",
      },
    },
  });
}
