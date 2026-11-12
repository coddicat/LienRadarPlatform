import { AuctionChannel, AuctionStatus } from "@lienradar/shared";
import { resolveAuctionProxy } from "../proxy.js";
import type { NormalizedLotCard } from "./types.js";

export type ReoCollectResult = {
  ok: boolean;
  source: string;
  listings: NormalizedLotCard[];
  error?: string;
  detail?: string;
};

function money(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = s.replace(/,/g, "").match(/\$?\s*([0-9]+(?:\.[0-9]{1,2})?)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function addDays(base: Date, days: number): Date {
  const d = new Date(base);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

/** Parse "Ends in 2 days" / "Starts in 6 days" → approximate sale date. */
function saleDateFromText(text: string, now = new Date()): string {
  const ends = text.match(/Ends in\s+(\d+)\s+days?/i);
  if (ends) return ymd(addDays(now, Number(ends[1])));
  const starts = text.match(/Starts in\s+(\d+)\s+days?/i);
  if (starts) return ymd(addDays(now, Number(starts[1])));
  if (/Ends today|Ending today/i.test(text)) return ymd(now);
  return ymd(addDays(now, 7));
}

/** Strip listing-card noise that glues onto house numbers ("2 bd2 ba750 sq. ft.7300 SW..."). */
function scrubListingNoise(text: string): string {
  // Auction.com glues tokens: "2 bd2 ba750 sq. ft.7300 SW..." — iterate until stable.
  let s = text;
  for (let i = 0; i < 6; i++) {
    const next = s
      .replace(/\b\d+\s*(?:bd|br|ba|bath|beds?|baths?)/gi, " ")
      .replace(/\b\d[\d,]*\s*sq\.?\s*ft\.?/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (next === s) break;
    s = next;
  }
  return s;
}

function normalizeAddress(s: string): string {
  return s
    .replace(/\s+/g, " ")
    .replace(/\b(Sw|Nw|Se|Ne)\b/gi, (m) => m.toUpperCase())
    .replace(/\bFl\b/g, "FL")
    .trim();
}

function extractAddress(text: string, href: string): string | null {
  const cleaned = scrubListingNoise(text);

  // Prefer "123 NW Main St, Miami, FL 33125" (optionally with unit).
  const withZip = cleaned.match(
    /(\d{1,6}\s+(?:(?:[NEWS]{1,2}|North|South|East|West|Northwest|Northeast|Southwest|Southeast)\s+)?[A-Za-z0-9 .#'\-]+?\s+(?:St|Street|Ave|Avenue|Blvd|Boulevard|Rd|Road|Dr|Drive|Ln|Lane|Ct|Court|Pl|Place|Ter|Terrace|Way|Path|Pkwy|Parkway)\b(?:\s*(?:Unit|Apt|#)\s*[A-Za-z0-9\-]+)?,\s*[A-Za-z .]+,\s*FL\s*\d{5})/i,
  );
  if (withZip?.[1]) return normalizeAddress(withZip[1]);

  // Fallback without commas: "15248 SW 31st St Miami FL" (+ optional ZIP).
  const loose = cleaned.match(
    /(\d{1,6}\s+(?:(?:[NEWS]{1,2}|North|South|East|West|Northwest|Northeast|Southwest|Southeast)\s+)?[A-Za-z0-9 .#'\-]+?\s+(?:St|Street|Ave|Avenue|Blvd|Boulevard|Rd|Road|Dr|Drive|Ln|Lane|Ct|Court|Pl|Place|Ter|Terrace|Way|Path|Pkwy|Parkway)\b(?:\s*(?:Unit|Apt|#)\s*[A-Za-z0-9\-]+)?(?:\s+[A-Za-z .]+)?(?:\s+FL(?:\s+\d{5})?)?)/i,
  );
  if (loose?.[1] && loose[1].length > 10) return normalizeAddress(loose[1]);

  // URL slug is reliable enough for display; PA attach may still need ZIP later.
  const fromUrl = href.match(/\/details\/([^/]+?)-\d+(?:\/|$)/i);
  if (fromUrl) {
    const pretty = fromUrl[1]!
      .replace(/-/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());
    if (pretty.length > 8) return normalizeAddress(pretty);
  }
  return null;
}

function isMiamiDadeArea(address: string, text: string): boolean {
  const hay = `${address} ${text}`.toLowerCase();
  // miami_ct search is "within 50 miles" — keep MD-named cities; drop obvious Broward/PBC.
  if (/\b(fort lauderdale|hollywood beach|pompano|coral springs|west palm|boca raton|delray|boynton)\b/.test(hay)) {
    return false;
  }
  return (
    /\bmiami\b/.test(hay) ||
    /\bhomestead\b/.test(hay) ||
    /\bhialeah\b/.test(hay) ||
    /\bkendall\b/.test(hay) ||
    /\bcoral gables\b/.test(hay) ||
    /\bdoral\b/.test(hay) ||
    /\bmiami beach\b/.test(hay) ||
    /\bmiami-dade\b/.test(hay) ||
    /\bcutler bay\b/.test(hay) ||
    /\bpalmetto bay\b/.test(hay) ||
    /\bnorth miami\b/.test(hay)
  );
}

async function withBrowser<T>(fn: (page: import("playwright").Page) => Promise<T>): Promise<T> {
  const { chromium } = await import("playwright");
  const proxy = resolveAuctionProxy();
  const browser = await chromium.launch({
    headless: true,
    ...(proxy ? { proxy } : {}),
  });
  try {
    const page = await browser.newPage({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      locale: "en-US",
      extraHTTPHeaders: { "Accept-Language": "en-US,en;q=0.9" },
    });
    return await fn(page);
  } finally {
    await browser.close();
  }
}

/**
 * Live Auction.com Miami residential search (foreclosure + bank owned).
 * Playwright required — SPA listing cards.
 */
export async function collectAuctionComMiami(limit = 80): Promise<ReoCollectResult> {
  const searchUrl = "https://www.auction.com/residential/FL/miami_ct";
  try {
    const listings = await withBrowser(async (page) => {
      const res = await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
      if (!res || !res.ok()) throw new Error(`Auction.com HTTP ${res?.status() ?? "no response"}`);
      await page.waitForTimeout(3500);
      for (let i = 0; i < 4; i++) {
        await page.mouse.wheel(0, 1800);
        await page.waitForTimeout(800);
      }
      const rows = await page.evaluate(() => {
        const seen = new Set<string>();
        const out: Array<{ href: string; text: string }> = [];
        for (const a of Array.from(document.querySelectorAll('a[href*="/details/"]'))) {
          const href = (a as HTMLAnchorElement).href;
          if (!href || seen.has(href)) continue;
          seen.add(href);
          const card = a.closest("article,li,div") || a;
          const text = (card.textContent || "").replace(/\s+/g, " ").trim();
          out.push({ href, text: text.slice(0, 400) });
        }
        return out;
      });

      const now = new Date();
      const cards: NormalizedLotCard[] = [];
      for (const row of rows) {
        if (cards.length >= limit) break;
        const idMatch = row.href.match(/-(\d+)(?:\/|$)/);
        if (!idMatch) continue;
        const caseNumber = `AC-${idMatch[1]}`;
        const address = extractAddress(row.text, row.href);
        if (!address || !isMiamiDadeArea(address, row.text)) continue;
        const bid =
          money(row.text.match(/\$[\d,]+(?:\.\d{2})?\s*Current Bid/i)?.[0]) ??
          money(row.text.match(/\$[\d,]+(?:\.\d{2})?\s*Opening Bid/i)?.[0]) ??
          money(row.text.match(/\$[\d,]+/)?.[0]);
        const saleDate = saleDateFromText(row.text, now);
        const bankOwned = /Bank Owned/i.test(row.text);
        cards.push({
          county: "miami-dade",
          channel: AuctionChannel.BANK_REO,
          source: "auction.com",
          caseNumber,
          folio: "",
          saleDate,
          status: AuctionStatus.SCHEDULED,
          propertyAddress: address,
          openingBid: bid,
          sourceUrl: row.href,
          raw: {
            marketplace: "auction.com",
            searchUrl,
            bankOwned,
            foreclosureSale: /Foreclosure Sale/i.test(row.text),
            cardText: row.text,
            collectedAt: now.toISOString(),
          },
        });
      }
      return cards;
    });

    return {
      ok: true,
      source: "auction.com",
      listings,
      detail: `Miami search ${searchUrl} → ${listings.length} MD-area BANK_REO cards`,
    };
  } catch (e) {
    return {
      ok: false,
      source: "auction.com",
      listings: [],
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * Live Hubzu collector — best effort via Playwright.
 * Site is aggressively SPA / bot-filtered; fail soft with honest status.
 */
export async function collectHubzuMiami(limit = 40): Promise<ReoCollectResult> {
  const searchUrl = "https://www.hubzu.com/auctions?listingType=AUCN";
  try {
    const listings = await withBrowser(async (page) => {
      const res = await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
      if (!res || !res.ok()) throw new Error(`Hubzu HTTP ${res?.status() ?? "no response"}`);
      await page.waitForTimeout(5000);
      const body = (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ");
      if (!body || body.length < 40) {
        throw new Error("Hubzu returned empty shell (likely bot/verification wall)");
      }
      if (/something isn't here|couldn't find the page/i.test(body)) {
        throw new Error("Hubzu search page not found / blocked");
      }

      // Try location filter UI if present.
      const filled = await page.evaluate(() => {
        const inputs = Array.from(document.querySelectorAll("input")).filter((el) => {
          const t = (el.getAttribute("type") || "text").toLowerCase();
          return t === "text" || t === "search";
        }) as HTMLInputElement[];
        const loc = inputs.find((el) =>
          /city|location|search|address/i.test(
            `${el.name} ${el.id} ${el.placeholder} ${el.getAttribute("aria-label") || ""}`,
          ),
        );
        if (!loc) return false;
        loc.focus();
        loc.value = "Miami, FL";
        loc.dispatchEvent(new Event("input", { bubbles: true }));
        loc.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      });
      if (filled) {
        await page.keyboard.press("Enter");
        await page.waitForTimeout(4000);
      }

      const rows = await page.evaluate(() => {
        const seen = new Set<string>();
        const out: Array<{ href: string; text: string }> = [];
        for (const a of Array.from(document.querySelectorAll("a[href]"))) {
          const href = (a as HTMLAnchorElement).href;
          if (!/hubzu\.com/i.test(href)) continue;
          if (!/property|listing|detail|\/p-/i.test(href)) continue;
          if (seen.has(href)) continue;
          seen.add(href);
          const card = a.closest("article,li,div") || a;
          const text = (card.textContent || "").replace(/\s+/g, " ").trim();
          if (text.length < 12) continue;
          out.push({ href, text: text.slice(0, 400) });
        }
        return out;
      });

      const now = new Date();
      const cards: NormalizedLotCard[] = [];
      for (const row of rows) {
        if (cards.length >= limit) break;
        if (!/FL|Florida|Miami/i.test(row.text) && !/FL|miami/i.test(row.href)) continue;
        const address = extractAddress(row.text, row.href) ?? row.text.slice(0, 80);
        if (!isMiamiDadeArea(address, row.text)) continue;
        const id =
          row.href.match(/(?:property|listing|p-)[/:-]?([A-Za-z0-9_-]{6,})/i)?.[1] ??
          Buffer.from(row.href).toString("base64url").slice(0, 16);
        const bid = money(row.text.match(/\$[\d,]+/)?.[0]);
        cards.push({
          county: "miami-dade",
          channel: AuctionChannel.BANK_REO,
          source: "hubzu.com",
          caseNumber: `HZ-${id}`.slice(0, 64),
          folio: "",
          saleDate: saleDateFromText(row.text, now),
          status: AuctionStatus.SCHEDULED,
          propertyAddress: address,
          openingBid: bid,
          sourceUrl: row.href,
          raw: {
            marketplace: "hubzu.com",
            searchUrl,
            cardText: row.text,
            collectedAt: now.toISOString(),
          },
        });
      }
      return cards;
    });

    return {
      ok: true,
      source: "hubzu.com",
      listings,
      detail: `Hubzu auctions → ${listings.length} MD-area cards`,
    };
  } catch (e) {
    return {
      ok: false,
      source: "hubzu.com",
      listings: [],
      error: e instanceof Error ? e.message : String(e),
      detail: "Playwright Hubzu collect failed — site often requires interactive verification",
    };
  }
}

export async function probeAuctionCom(): Promise<{ ok: boolean; error?: string; detail?: string }> {
  try {
    const res = await fetch("https://www.auction.com/residential/FL/miami_ct", {
      signal: AbortSignal.timeout(20_000),
      redirect: "follow",
      headers: { "User-Agent": "LienRadarPlatform/0.1" },
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true, detail: "Auction.com Miami residential search reachable" };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function probeHubzu(): Promise<{ ok: boolean; error?: string; detail?: string }> {
  try {
    const res = await fetch("https://www.hubzu.com/auctions?listingType=AUCN", {
      signal: AbortSignal.timeout(20_000),
      redirect: "follow",
      headers: { "User-Agent": "LienRadarPlatform/0.1" },
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true, detail: "Hubzu auctions shell reachable (listing parse may need Playwright)" };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
