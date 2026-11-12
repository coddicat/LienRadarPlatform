import { LayerStatus, MortgageRankLevel } from "@lienradar/shared";
import { Prisma, prisma } from "@lienradar/db";
import { resolveAuctionProxy } from "../proxy.js";
import { syncMortgageDebtRow } from "./syncMortgageDebt.js";

/**
 * Miami-Dade Official Records — mortgage / lien evidence.
 *
 * Paid daily FTP index (AuthKey) is the durable path (legacy FLI md_records).
 * Without AuthKey we attempt a best-effort public Official Records HTML search
 * via Playwright + residential proxy for MOR/LIE hits by owner name.
 *
 * Honesty: no hit in a narrow public search ≠ no mortgage. Window / index limits apply.
 */

const OR_SEARCH = "https://onlineservices.miamidadeclerk.gov/officialrecords";

export type OrMortgageHit = {
  docType: string;
  book?: string;
  page?: string;
  recorded?: string;
  parties?: string;
  raw: string;
};

export async function probeOfficialRecords(): Promise<{
  ok: boolean;
  error?: string;
  detail?: string;
  mode: "authkey" | "public" | "none";
}> {
  if (process.env.MIAMI_DADE_CLERK_AUTH_KEY?.trim()) {
    return {
      ok: true,
      mode: "authkey",
      detail: "AuthKey present — daily OR FTP index path available (paid); public search still used as fallback",
    };
  }
  try {
    const res = await fetch(OR_SEARCH, {
      signal: AbortSignal.timeout(20_000),
      redirect: "follow",
      headers: { "User-Agent": "LienRadarPlatform/0.1 (+OR probe)" },
    });
    if (!res.ok) return { ok: false, mode: "public", error: `HTTP ${res.status}` };
    return {
      ok: true,
      mode: "public",
      detail: "Public Official Records shell reachable; AuthKey not set — FTP index unavailable",
    };
  } catch (e) {
    return { ok: false, mode: "none", error: e instanceof Error ? e.message : String(e) };
  }
}

/** Best-effort public OR name search for mortgage-family document codes. */
export async function searchOfficialRecordsByOwner(ownerName: string): Promise<{
  status: typeof LayerStatus.OK | typeof LayerStatus.PARTIAL | typeof LayerStatus.FAILED;
  hits: OrMortgageHit[];
  payload: Record<string, unknown>;
  error?: string;
}> {
  const name = ownerName.trim();
  if (name.length < 3) {
    return {
      status: LayerStatus.FAILED,
      hits: [],
      payload: { ownerName: name },
      error: "owner name too short",
    };
  }

  // Prefer direct for onlineservices host — residential proxy often fails tunnel here.
  // Fall back to RA proxy only if direct navigation fails.
  const proxy = resolveAuctionProxy();
  try {
    const { chromium } = await import("playwright");

    async function openWith(useProxy: boolean) {
      const browser = await chromium.launch({
        headless: true,
        ...(useProxy && proxy ? { proxy } : {}),
      });
      try {
        const page = await browser.newPage({
          userAgent:
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        });
        const res = await page.goto(OR_SEARCH, { waitUntil: "domcontentloaded", timeout: 60_000 });
        if (!res || !res.ok()) {
          throw new Error(`OR search HTTP ${res?.status() ?? "no response"}`);
        }
        return { browser, page, usedProxy: useProxy && Boolean(proxy) };
      } catch (e) {
        await browser.close().catch(() => undefined);
        throw e;
      }
    }

    let browser: import("playwright").Browser;
    let page: import("playwright").Page;
    let usedProxy = false;
    try {
      ({ browser, page, usedProxy } = await openWith(false));
    } catch (directErr) {
      if (!proxy) throw directErr;
      ({ browser, page, usedProxy } = await openWith(true));
    }

    try {
      const html = await page.content();
      if (/captcha|cloudflare|access denied/i.test(html) && !/Official Records/i.test(html)) {
        throw new Error("OR search blocked or captcha");
      }

      // Site markup varies; try common name inputs then submit.
      const filled = await page.evaluate((q) => {
        const inputs = Array.from(document.querySelectorAll("input")).filter(
          (el) => {
            const t = (el.getAttribute("type") || "text").toLowerCase();
            return t === "text" || t === "search";
          },
        ) as HTMLInputElement[];
        const prefer = inputs.find((el) =>
          /name|grantor|party|lastname/i.test(
            `${el.name} ${el.id} ${el.placeholder} ${el.getAttribute("aria-label") || ""}`,
          ),
        );
        const target = prefer || inputs[0];
        if (!target) return false;
        target.focus();
        target.value = q;
        target.dispatchEvent(new Event("input", { bubbles: true }));
        target.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }, name);

      if (!filled) {
        return {
          status: LayerStatus.PARTIAL,
          hits: [],
          payload: {
            ownerName: name,
            source: OR_SEARCH,
            note: "Public OR form inputs not found — AuthKey FTP index recommended for mortgage L2",
            authKeyConfigured: Boolean(process.env.MIAMI_DADE_CLERK_AUTH_KEY?.trim()),
          },
        };
      }

      await Promise.all([
        page.waitForLoadState("domcontentloaded", { timeout: 20_000 }).catch(() => null),
        page.keyboard.press("Enter"),
      ]);
      await page.waitForTimeout(2500);

      const bodyText = await page.locator("body").innerText().catch(() => "");
      const lines = bodyText
        .split(/\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      const hits: OrMortgageHit[] = [];
      for (const line of lines) {
        if (!/\b(MOR|MTG|MORTGAGE|LIE|LIEN|LIS|JUD)\b/i.test(line)) continue;
        if (line.length > 240) continue;
        hits.push({
          docType: (line.match(/\b(MOR|MTG|MORTGAGE|LIE|LIEN|LIS|JUD)\b/i) || ["?"])[0]!.toUpperCase(),
          raw: line,
        });
        if (hits.length >= 25) break;
      }

      const mortgageHits = hits.filter((h) => /MOR|MTG|MORTGAGE/i.test(h.docType));
      return {
        status: hits.length ? LayerStatus.PARTIAL : LayerStatus.PARTIAL,
        hits,
        payload: {
          ownerName: name,
          source: OR_SEARCH,
          mode: "public_playwright",
          proxy: usedProxy,
          authKeyConfigured: Boolean(process.env.MIAMI_DADE_CLERK_AUTH_KEY?.trim()),
          hitCount: hits.length,
          mortgageHitCount: mortgageHits.length,
          hits: hits.slice(0, 25),
          note:
            hits.length === 0
              ? "No MOR/LIE lines parsed from public OR results — not proof of clear title; use AuthKey FTP or Manual DD"
              : "Public OR hits are recorded evidence only — not current payoff; L2 still needs instrument review",
          retrievedAt: new Date().toISOString(),
        },
      };
    } finally {
      await browser.close();
    }
  } catch (e) {
    return {
      status: LayerStatus.FAILED,
      hits: [],
      payload: {
        ownerName: name,
        source: OR_SEARCH,
        authKeyConfigured: Boolean(process.env.MIAMI_DADE_CLERK_AUTH_KEY?.trim()),
      },
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export async function applyOfficialRecordsMortgage(
  lotId: string,
  ownerName: string | null | undefined,
) {
  const name = (ownerName ?? "").trim();
  if (!name) {
    await prisma.enrichmentLayer.upsert({
      where: { lotId_name: { lotId, name: "official_records" } },
      update: {
        status: LayerStatus.PARTIAL,
        payload: {
          note: "No owner name on lot/property — OR name search skipped",
          authKeyConfigured: Boolean(process.env.MIAMI_DADE_CLERK_AUTH_KEY?.trim()),
        } as Prisma.InputJsonValue,
        fetchedAt: new Date(),
      },
      create: {
        lotId,
        name: "official_records",
        status: LayerStatus.PARTIAL,
        payload: {
          note: "No owner name on lot/property — OR name search skipped",
          authKeyConfigured: Boolean(process.env.MIAMI_DADE_CLERK_AUTH_KEY?.trim()),
        },
      },
    });
    return { ok: false, skipped: true };
  }

  const result = await searchOfficialRecordsByOwner(name);
  await prisma.enrichmentLayer.upsert({
    where: { lotId_name: { lotId, name: "official_records" } },
    update: {
      status: result.status,
      payload: result.payload as Prisma.InputJsonValue,
      error: result.error,
      fetchedAt: new Date(),
    },
    create: {
      lotId,
      name: "official_records",
      status: result.status,
      payload: result.payload as Prisma.InputJsonValue,
      error: result.error,
    },
  });

  const mortgageHits = result.hits.filter((h) => /MOR|MTG|MORTGAGE/i.test(h.docType));
  if (mortgageHits.length > 0) {
    const existing = await prisma.mortgageAssessment.findFirst({
      where: { lotId, rankLevel: MortgageRankLevel.L1_ESTIMATE },
    });
    const note = `Public OR: ${mortgageHits.length} mortgage-family hit(s) for owner "${name}" — balance UNKNOWN until instrument/Manual DD; not L2`;
    if (existing) {
      await prisma.mortgageAssessment.update({
        where: { id: existing.id },
        data: {
          evidenceNote: note,
          satisfied: false,
        },
      });
    } else {
      await prisma.mortgageAssessment.create({
        data: {
          lotId,
          rankLevel: MortgageRankLevel.L1_ESTIMATE,
          estimatedBalance: null,
          satisfied: false,
          evidenceNote: note,
        },
      });
    }
    await syncMortgageDebtRow(lotId, {
      estimatedBalance: null,
      evidenceNote: note,
      rankLevel: MortgageRankLevel.L1_ESTIMATE,
    });
  }

  return { ok: !result.error, hits: result.hits.length, mortgageHits: mortgageHits.length };
}
