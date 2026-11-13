import {
  AuctionChannel,
  AuctionStatus,
  COUNTY_REGISTRY,
  countyResourceKey,
  resolveActiveCounties,
  toCivilDateISO,
  toUsSlashDate,
  type CountySlug,
} from "@lienradar/shared";
import { resolveAuctionProxy, resolveAuctionProxyCandidates } from "../proxy.js";
import type { AuctionSourceAdapter, CalendarDay, NormalizedLotCard } from "./types.js";

export type ProbeResult = {
  ok: boolean;
  error?: string;
  days?: number;
};

type LiveOutcome = {
  plaintiff_max: number | null;
  status: string;
  final_bid: number | null;
  outcome_text: string | null;
};

type LinkedField = { text: string | null; href: string | null };

type ParsedItem = {
  aid: string;
  case_number: string | null;
  platform_case_number: string | null;
  certificate_number: string | null;
  tax_deed_number: string | null;
  auction_type: string | null;
  folio: string | null;
  parcel_id: string | null;
  address: string | null;
  final_judgment: number | null;
  opening_bid: number | null;
  assessed_value: number | null;
  market_value: number | null;
  /** Case # outbound link (clerk OR / instrument), when RealAuction exposes one. */
  case_doc_url: string | null;
  /** Parcel ID outbound link (county PA), when RealAuction exposes one. */
  parcel_appraiser_url: string | null;
  city: string | null;
  zip: string | null;
  plaintiff_max?: number | null;
  status?: string;
  outcome_text?: string | null;
  final_bid?: number | null;
};

function money(s: string | null | undefined): number | null {
  if (!s) return null;
  const n = Number(String(s).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function sourceMoney(s: string | null | undefined): number | null {
  if (s == null) return null;
  const n = Number(String(s).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function mapPlatformStatus(raw: string): AuctionStatus {
  const s = raw.toLowerCase();
  if (s.startsWith("sold")) return AuctionStatus.SOLD;
  if (s === "redeemed") return AuctionStatus.REDEEMED;
  if (s === "canceled" || s === "cancelled") return AuctionStatus.CANCELED;
  if (s === "not_sold") return AuctionStatus.NOT_SOLD;
  if (s === "live") return AuctionStatus.LIVE;
  return AuctionStatus.SCHEDULED;
}

function outcomeFromLive(it: Record<string, unknown>): LiveOutcome {
  const plaintiff_max = money(String(it.P ?? ""));
  const a = String(it.A ?? "").trim();
  const st = String(it.ST ?? "").trim();
  const b = String(it.B ?? "").trim();
  const soldFlag = it.S;

  if (a === "Auction Sold") {
    const amt = money(String(it.D ?? ""));
    let status = "sold";
    if (st === "3rd Party Bidder") status = "sold_3rd_party";
    else if (st === "Plaintiff") status = "sold_plaintiff";
    return { plaintiff_max, status, final_bid: amt, outcome_text: b || null };
  }
  if (a === "B" && b) {
    const bl = b.toLowerCase();
    let status = "not_sold";
    if (bl.includes("redeem")) status = "redeemed";
    else if (bl.includes("cancel") || bl.includes("did not meet") || bl.includes("not meet")) {
      status = "canceled";
    }
    return { plaintiff_max, status, final_bid: null, outcome_text: b };
  }
  if (soldFlag === "C") {
    return { plaintiff_max, status: "sold", final_bid: null, outcome_text: b || null };
  }
  return { plaintiff_max, status: "scheduled", final_bid: null, outcome_text: null };
}

/** Same PAIR as legacy guest sidecar — optional inner <a> so Case # is not truncated. */
const PAIR_RE =
  />([^<@>]+?):@F[^>]*?AD_DTA"[^>]*>\s*(?:<[a-z][^>]*>)?([^@<]+?)(?:<\/[a-z]+>)?\s*@/gi;
const PAIR_DIV_RE =
  /([A-Za-z][^@<>\n:]{1,50}):@B<div[^>]*@CAD_DTA[^>]*>\s*(?:<[a-z][^>]*>)?([^@<>\n]+?)(?:\s*<\/[a-z]+>)?\s*@B/gi;

/**
 * Extract text + optional href for a labeled RealAuction card field.
 * Case # / Parcel ID often link out to clerk Official Records or the county PA.
 */
function linkedField(blk: string, label: string): LinkedField {
  const esc = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const withAnchor = new RegExp(
    `${esc}:@F[^]*?AD_DTA"[^>]*>\\s*<a[^>]+href=["']([^"']+)["'][^>]*>\\s*([^<]+?)\\s*</a>`,
    "i",
  );
  const m = withAnchor.exec(blk);
  if (m) {
    return { href: m[1].trim() || null, text: m[2].trim() || null };
  }
  const plain = new RegExp(
    `${esc}:@F[^]*?AD_DTA"[^>]*>\\s*(?:<[a-z][^>]*>)?([^@<]+?)(?:</[a-z]+>)?\\s*@`,
    "i",
  );
  const p = plain.exec(blk);
  return { href: null, text: p?.[1]?.trim() || null };
}

function classifyCaseDocUrl(url: string): string {
  if (/officialrecords|AcclaimWeb|InstrumentNumber|erec\.|DocumentAndInfoByBookPage|clerk/i.test(url)) {
    return "auction_case_instrument";
  }
  if (/propertysearch|RecInfo|pbcpao|parcelId|URL_Folio|folio=/i.test(url)) {
    return "auction_parcel_appraiser";
  }
  return "auction_case_link";
}

/** Second unlabeled CAD_DTA row after Property Address → city / ZIP. */
function addressCityZip(blk: string): { city: string | null; zip: string | null } {
  const m =
    /Property Address:@F[^]*?AD_DTA"[^>]*>([^@<]+)@G@H(?:[^@]*@CAD_LBL"[^>]*>)?@F[^]*?AD_DTA"[^>]*>([^@<]+)/i.exec(
      blk,
    );
  if (!m?.[2]) return { city: null, zip: null };
  const line2 = m[2].trim();
  const zipM = line2.match(/\b(\d{5})(?:-\d{4})?\b/);
  const city = line2
    .replace(/,?\s*FL-?\s*/i, " ")
    .replace(/\b\d{5}(?:-\d{4})?\b/g, "")
    .replace(/,/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return { city: city || null, zip: zipM?.[1] ?? null };
}

function parseAreaHtml(html: string): Record<string, ParsedItem> {
  const out: Record<string, ParsedItem> = {};
  const blocks = html.split(/(?=AITEM_\d+")/).slice(1);
  for (const blk of blocks) {
    const aidM = blk.match(/AITEM_(\d+)/);
    if (!aidM) continue;
    const aid = aidM[1];
    const pairs: Record<string, string> = {};
    PAIR_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = PAIR_RE.exec(blk))) {
      const k = m[1].trim();
      const v = m[2].trim();
      if (k) pairs[k] = v;
    }
    if (Object.keys(pairs).length === 0) {
      PAIR_DIV_RE.lastIndex = 0;
      while ((m = PAIR_DIV_RE.exec(blk))) {
        const k = m[1].trim();
        const v = m[2].trim();
        if (k && !(k in pairs)) pairs[k] = v;
      }
    }

    const caseLinked = linkedField(blk, "Case #");
    const caseLinkedAlt = caseLinked.text || caseLinked.href ? caseLinked : linkedField(blk, "Case Number");
    const parcelLinked = linkedField(blk, "Parcel ID");

    const platform_case_raw =
      caseLinkedAlt.text || pairs["Case #"] || pairs["Case Number"] || null;
    const certificate = pairs["Certificate #"] || null;
    const tax_deed = pairs["Tax Deed #"] || null;
    const parcel_id =
      (parcelLinked.text || pairs["Parcel ID"] || "").trim() || null;
    const folioDigits = parcel_id ? parcel_id.replace(/\D/g, "") : null;
    // Miami-Dade sometimes puts the folio in "Case #" — never treat folio shape as court identity.
    const folioShapedCase =
      !!platform_case_raw &&
      (/^\d{2}-\d{4}-\d{3}-\d{4}$/.test(platform_case_raw.trim()) ||
        (folioDigits != null &&
          platform_case_raw.replace(/\D/g, "") === folioDigits &&
          folioDigits.length >= 10));
    const platform_case = folioShapedCase ? null : platform_case_raw;
    const ident = platform_case || certificate || tax_deed;
    const auction_type =
      pairs["Auction Type"] ||
      (platform_case && pairs["Final Judgment Amount"] && !certificate && !tax_deed
        ? "FORECLOSURE"
        : null);

    // Case # may link to OR; on some hosts (MD) only Parcel ID is linked — never treat PA as case doc.
    let case_doc_url = caseLinkedAlt.href;
    if (case_doc_url && classifyCaseDocUrl(case_doc_url) === "auction_parcel_appraiser") {
      case_doc_url = null;
    }
    const parcel_appraiser_url = parcelLinked.href;
    const { city, zip } = addressCityZip(blk);

    out[aid] = {
      aid,
      case_number: ident,
      platform_case_number: platform_case,
      certificate_number: certificate,
      tax_deed_number: tax_deed,
      auction_type,
      folio: folioDigits || null,
      parcel_id,
      address: pairs["Property Address"] || null,
      city,
      zip,
      final_judgment: money(pairs["Final Judgment Amount"]),
      opening_bid: sourceMoney(pairs["Opening Bid"]),
      assessed_value: sourceMoney(pairs["Assessed Value"]),
      market_value: sourceMoney(pairs["Property App. Market Value"]),
      case_doc_url,
      parcel_appraiser_url,
    };
  }
  return out;
}

/**
 * RealAuction guest PREVIEW → AREA LOAD → UPDATE path inside a browser session.
 * Same endpoints as the legacy curl_cffi sidecar; no captcha bypass — fail closed on notice/captcha.
 */
export function createRealAuctionAdapter(opts: {
  county: string;
  channel: typeof AuctionChannel.TAX_DEED | typeof AuctionChannel.FORECLOSURE;
  host: string;
}): AuctionSourceAdapter & { probe: () => Promise<ProbeResult>; resourceKey: string; county: string } {
  const base = `https://${opts.host}`;
  const index = `${base}/index.cfm`;
  const expectedTypeToken =
    opts.channel === AuctionChannel.TAX_DEED ? "TAXDEED" : "FORECLOSURE";
  const resourceKey = countyResourceKey(
    opts.county,
    opts.channel === AuctionChannel.TAX_DEED ? "taxdeed_realauction" : "foreclose_realauction",
  );

  async function withBrowser<T>(
    fn: (page: import("playwright").Page) => Promise<T>,
    opts?: { proxy?: ReturnType<typeof resolveAuctionProxy> },
  ): Promise<T> {
    const { chromium } = await import("playwright");
    const proxy = opts?.proxy === undefined ? resolveAuctionProxy() : opts.proxy;
    const browser = await chromium.launch({
      headless: true,
      ...(proxy ? { proxy } : {}),
    });
    try {
      const context = await browser.newContext({
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        locale: "en-US",
        extraHTTPHeaders: { "Accept-Language": "en-US,en;q=0.9" },
      });
      const page = await context.newPage();
      return await fn(page);
    } finally {
      await browser.close();
    }
  }

  /** Retry PREVIEW across SOCKS/HTTP proxies when one path returns 403. */
  async function withBrowserRetry<T>(fn: (page: import("playwright").Page) => Promise<T>): Promise<T> {
    const candidates: Array<ReturnType<typeof resolveAuctionProxy> | undefined> = [
      ...resolveAuctionProxyCandidates(),
      undefined,
    ];
    // De-dupe undefined-only trailing if no proxies configured.
    const list = candidates.length ? candidates : [undefined];
    let lastErr: unknown;
    for (const proxy of list) {
      try {
        return await withBrowser(fn, { proxy });
      } catch (e) {
        lastErr = e;
        const msg = e instanceof Error ? e.message : String(e);
        if (!/403|Forbidden|PREVIEW HTTP|notice or CAPTCHA/i.test(msg)) throw e;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  async function fetchArea(
    page: import("playwright").Page,
    area: "R" | "W" | "C",
    referer: string,
    byAid: Map<string, ParsedItem>,
  ) {
    for (let pageIdx = 0; pageIdx < 30; pageIdx++) {
      const tx = Date.now() + pageIdx * 137;
      const bypass = pageIdx === 0 ? (area === "W" ? 1 : 0) : pageIdx + 1;
      const loadUrl =
        `${index}?zaction=AUCTION&Zmethod=UPDATE&FNC=LOAD&AREA=${area}` +
        `&PageDir=0&doR=1&tx=${tx}&bypassPage=${bypass}&test=1&_=${tx + 1}`;

      const loadRaw = await page.evaluate(
        async ({ url, referer: ref }) => {
          const res = await fetch(url, {
            headers: {
              "X-Requested-With": "XMLHttpRequest",
              Accept: "application/json, text/javascript, */*; q=0.01",
              Referer: ref,
            },
            credentials: "same-origin",
          });
          return { status: res.status, text: await res.text() };
        },
        { url: loadUrl, referer },
      );
      if (loadRaw.status >= 400) {
        throw new Error(`LOAD area=${area} page=${pageIdx} HTTP ${loadRaw.status}`);
      }
      let payload: { retHTML?: string };
      try {
        payload = JSON.parse(loadRaw.text) as { retHTML?: string };
      } catch {
        throw new Error(`LOAD area=${area} page=${pageIdx}: non-JSON response`);
      }
      if (typeof payload.retHTML !== "string") {
        throw new Error(`LOAD area=${area} page=${pageIdx}: missing retHTML`);
      }
      const items = parseAreaHtml(payload.retHTML);
      if (payload.retHTML.includes("AITEM_") && Object.keys(items).length === 0) {
        throw new Error(`LOAD area=${area}: item markup present but parser returned zero`);
      }
      if (Object.keys(items).length === 0) break;

      const refList = Object.keys(items).join(",");
      const updUrl =
        `${index}?zaction=AUCTION&ZMETHOD=UPDATE&FNC=UPDATE&ref=${refList},&tx=${tx}`;
      const updRaw = await page.evaluate(
        async ({ url, referer: ref }) => {
          const res = await fetch(url, {
            headers: {
              "X-Requested-With": "XMLHttpRequest",
              Accept: "application/json, text/javascript, */*; q=0.01",
              Referer: ref,
            },
            credentials: "same-origin",
          });
          return { status: res.status, text: await res.text() };
        },
        { url: updUrl, referer },
      );
      if (updRaw.status >= 400) {
        throw new Error(`UPDATE area=${area} page=${pageIdx} HTTP ${updRaw.status}`);
      }
      const upd = JSON.parse(updRaw.text) as {
        ADATA?: { AITEM?: Array<Record<string, unknown>> };
      };
      const live = new Map<string, LiveOutcome>();
      for (const it of upd.ADATA?.AITEM ?? []) {
        live.set(String(it.AID), outcomeFromLive(it));
      }
      let omitted = 0;
      for (const aid of Object.keys(items)) {
        if (!live.has(aid)) omitted += 1;
      }
      if (omitted > 0) {
        console.warn(
          `[realauction] UPDATE omitted ${omitted}/${Object.keys(items).length} AIDs on ${opts.host} page=${pageIdx} — keeping preview status for those rows`,
        );
      }

      let fresh = 0;
      for (const [aid, st] of Object.entries(items)) {
        if (byAid.has(aid)) continue;
        const lv = live.get(aid);
        if (!lv) {
          // Fail-open for partial UPDATE payloads — keep calendar/preview card fields.
          byAid.set(aid, {
            ...st,
            case_number: st.case_number || `AID${aid}`,
          });
          fresh += 1;
          continue;
        }
        byAid.set(aid, {
          ...st,
          plaintiff_max: lv.plaintiff_max,
          status: lv.status,
          outcome_text: lv.outcome_text,
          final_bid: lv.final_bid,
          case_number: st.case_number || `AID${aid}`,
        });
        fresh += 1;
      }
      if (fresh === 0) break;
    }
  }

  return {
    id: opts.host,
    channel: opts.channel,
    county: opts.county,
    resourceKey,
    async probe() {
      try {
        return await withBrowser(async (page) => {
          const res = await page.goto(`${index}?zaction=USER&zmethod=CALENDAR`, {
            waitUntil: "domcontentloaded",
            timeout: 60_000,
          });
          if (!res || !res.ok()) {
            return { ok: false, error: `HTTP ${res?.status() ?? "no response"}` };
          }
          const html = await page.content();
          if (/NOTICEMSG|captcha/i.test(html)) {
            return { ok: false, error: "calendar presented notice or CAPTCHA; fail closed" };
          }
          await page.waitForTimeout(800);
          const dayids = await page.$$eval(".CALSELF", (els) =>
            els.map((el) => el.getAttribute("dayid")).filter(Boolean),
          );
          return { ok: true, days: dayids.length };
        });
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
    async fetchCalendar(from, to): Promise<CalendarDay[]> {
      return withBrowser(async (page) => {
        const days: CalendarDay[] = [];
        const seen = new Set<string>();

        const collectMonth = async () => {
          await page.waitForTimeout(600);
          const html = await page.content();
          if (/NOTICEMSG|captcha/i.test(html)) {
            throw new Error("calendar presented notice or CAPTCHA; fail closed");
          }
          const cells = await page.$$eval(".CALSELF", (els) =>
            els.map((el) => {
              const dayid = el.getAttribute("dayid") || "";
              const text = (el.textContent || "").replace(/\s+/g, " ");
              const nums = [...text.matchAll(/\b(\d{1,4})\b/g)].map((m) => Number(m[1]));
              // Prefer the largest number that isn't the day-of-month (1..31) as count hint.
              const dayNum = Number(dayid.split("/")[1] || 0);
              const hint = nums.filter((n) => n !== dayNum && n > 0).sort((a, b) => b - a)[0];
              return { dayid, countHint: hint };
            }),
          );
          for (const c of cells) {
            if (!c.dayid) continue;
            const civil = toCivilDateISO(c.dayid);
            if (!civil || seen.has(civil)) continue;
            // Compare at noon UTC so civil day stays inside [from,to] window edges.
            const d = new Date(`${civil}T12:00:00.000Z`);
            if (d >= from && d <= to) {
              seen.add(civil);
              days.push({ saleDate: civil, countHint: c.countHint });
            }
          }
        };

        await page.goto(`${index}?zaction=USER&zmethod=CALENDAR`, {
          waitUntil: "domcontentloaded",
          timeout: 60_000,
        });
        await collectMonth();

        // Walk previous + next months to cover past outcomes and upcoming sales.
        for (const label of ["Previous Month", "Next Month"] as const) {
          try {
            const href = await page
              .locator(`a[aria-label="${label}"]`)
              .first()
              .getAttribute("href");
            if (!href) continue;
            await page.goto(new URL(href, base).toString(), {
              waitUntil: "domcontentloaded",
              timeout: 60_000,
            });
            await collectMonth();
            // Return to current for the other direction
            await page.goto(`${index}?zaction=USER&zmethod=CALENDAR`, {
              waitUntil: "domcontentloaded",
              timeout: 60_000,
            });
          } catch {
            // optional month nav
          }
        }
        return days;
      });
    },
    async fetchLotsForDate(saleDate): Promise<NormalizedLotCard[]> {
      return withBrowserRetry(async (page) => {
        // Warm session on calendar first — cold PREVIEW hits often 403 on residential proxy.
        await page.goto(`${index}?zaction=USER&zmethod=CALENDAR`, {
          waitUntil: "domcontentloaded",
          timeout: 60_000,
        });
        await page.waitForTimeout(600);

        const auctionDateParam = toUsSlashDate(saleDate) ?? saleDate;
        const referer = `${index}?zaction=AUCTION&Zmethod=PREVIEW&AUCTIONDATE=${auctionDateParam}`;
        const res = await page.goto(referer, { waitUntil: "domcontentloaded", timeout: 60_000 });
        if (!res || !res.ok()) {
          throw new Error(`PREVIEW HTTP ${res?.status() ?? "no response"}`);
        }
        await page.waitForTimeout(1000);
        const html = await page.content();
        if (/403 Forbidden/i.test(html)) {
          throw new Error("PREVIEW HTTP 403 Forbidden");
        }
        if (/NOTICEMSG|captcha/i.test(html)) {
          throw new Error("guest PREVIEW presented notice or CAPTCHA; fail closed");
        }
        if (!/Preview Items For Sale|var CALMODE\s*=\s*"PREVIEW"/i.test(html)) {
          throw new Error("guest PREVIEW marker missing");
        }

        const alb = html.match(/id=['"]ALB['"][^>]*>([^<]*)<\/div>/i);
        if (!alb) {
          // Verified empty only if no inventory markup; otherwise fail closed.
          if (/AITEM_|id=['"]ALB['"]/i.test(html)) {
            throw new Error("guest PREVIEW #ALB missing but item markup present");
          }
          return [];
        }
        const expectedAids = new Set(
          alb[1]
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        );

        const byAid = new Map<string, ParsedItem>();
        await fetchArea(page, "R", referer, byAid);
        await fetchArea(page, "W", referer, byAid);
        await fetchArea(page, "C", referer, byAid);
        if (process.env.LR_DEBUG_RA === "1") {
          console.error(
            `[ra-debug] ${opts.host} ${saleDate} alb=${expectedAids.size} parsed=${byAid.size}`,
          );
        }

        if (expectedAids.size > 0) {
          const got = new Set(byAid.keys());
          const missing = [...expectedAids].filter((a) => !got.has(a));
          const extra = [...got].filter((a) => !expectedAids.has(a));
          // Tax-deed host often parks inventory only in AREA=C and ALB can include
          // aids not yet returned by LOAD pages — require coverage, not exact set equality.
          if (opts.channel === AuctionChannel.TAX_DEED) {
            if (got.size === 0) {
              throw new Error(
                `guest PREVIEW inventory empty after LOAD (alb=${expectedAids.size})`,
              );
            }
            const cover = got.size / expectedAids.size;
            if (cover < 0.5) {
              throw new Error(
                `guest PREVIEW weak coverage parsed=${got.size}/${expectedAids.size} missing=${missing.slice(0, 8).join(",")}`,
              );
            }
          } else if (missing.length || extra.length) {
            throw new Error(
              `guest PREVIEW inventory mismatch missing=${missing.slice(0, 8).join(",")} extra=${extra.slice(0, 8).join(",")}`,
            );
          }
        }

        const lots: NormalizedLotCard[] = [];
        let skippedOtherChannel = 0;
        let retargeted = 0;
        for (const item of byAid.values()) {
          const typeNorm = (item.auction_type || "").replace(/\s+/g, "").toUpperCase();
          const looksTax =
            typeNorm === "TAXDEED" ||
            typeNorm.includes("TAXDEED") ||
            !!item.certificate_number ||
            !!item.tax_deed_number;
          // Explicit type only — do NOT treat "case + amount" as foreclosure.
          // Tax-deed cards often have a case # and dollar fields that look like judgments.
          const looksFc = typeNorm === "FORECLOSURE" || typeNorm.includes("FORECLOS");

          let channel = opts.channel;
          if (opts.channel === AuctionChannel.TAX_DEED) {
            // realtaxdeed.com sometimes lists FORECLOSURE-typed cards on tax calendar days.
            // Keep them as foreclosure (do not invent tax-deed identity).
            if (looksFc && !looksTax) {
              channel = AuctionChannel.FORECLOSURE;
              retargeted += 1;
            } else if (!looksTax && !looksFc) {
              // Unmarked on tax host → treat as tax deed.
              channel = AuctionChannel.TAX_DEED;
            }
          } else if (opts.channel === AuctionChannel.FORECLOSURE) {
            if (looksTax) {
              skippedOtherChannel += 1;
              continue;
            }
          }

          const caseNumber = item.case_number || `AID${item.aid}`;
          let folio = item.parcel_id || item.folio || "";
          if (/property appraiser|multiple|unassigned/i.test(folio)) folio = "";
          // Prefer dashed display folio when present
          if (item.parcel_id && /\d/.test(item.parcel_id)) folio = item.parcel_id;

          const linkedDocuments: NonNullable<NormalizedLotCard["linkedDocuments"]> = [];
          if (item.case_doc_url) {
            linkedDocuments.push({
              docType: classifyCaseDocUrl(item.case_doc_url),
              title: item.platform_case_number || caseNumber,
              sourceUrl: item.case_doc_url,
              evidenceNote:
                "Linked from RealAuction Case # on preview card (clerk/OR instrument page)",
            });
          }
          if (item.parcel_appraiser_url) {
            linkedDocuments.push({
              docType: "auction_parcel_appraiser",
              title: item.parcel_id || folio || "Parcel",
              sourceUrl: item.parcel_appraiser_url,
              evidenceNote: "Linked from RealAuction Parcel ID on preview card (county PA)",
            });
          }

          lots.push({
            county: opts.county,
            channel,
            source: opts.host,
            caseNumber,
            platformCaseNumber: item.platform_case_number,
            certificateNumber: item.certificate_number,
            taxDeedNumber: item.tax_deed_number,
            folio,
            saleDate,
            status: mapPlatformStatus(item.status || "scheduled"),
            propertyAddress: item.address || undefined,
            propertyCity: item.city,
            propertyZip: item.zip,
            openingBid: item.opening_bid ?? null,
            judgmentAmount: item.final_judgment ?? null,
            plaintiffMaxBid: item.plaintiff_max ?? null,
            winningBid: item.final_bid ?? null,
            assessedValue: item.assessed_value ?? null,
            marketValue: item.market_value ?? null,
            outcomeText: item.outcome_text ?? null,
            sourceUrl: referer,
            expectedAidCount: expectedAids.size,
            linkedDocuments: linkedDocuments.length ? linkedDocuments : undefined,
            raw: {
              ...item,
              platformStatus: item.status,
              skippedOtherChannel,
              retargetedChannel: channel !== opts.channel ? channel : undefined,
              expectedTypeToken,
              linkedDocumentCount: linkedDocuments.length,
            },
          });
        }
        // Attach skip stats on first card for completeness messaging (pipeline reads expectedAidCount).
        if (lots.length > 0) {
          lots[0].raw = {
            ...lots[0].raw,
            inventoryAids: expectedAids.size,
            kept: lots.length,
            skippedOtherChannel,
            retargeted,
          };
        }
        return lots;
      });
    },
  };
}

export type CountyAuctionAdapter = ReturnType<typeof createRealAuctionAdapter>;

/** Build RealAuction adapters for every active South Florida county × tax+fc host. */
export function buildCountyAdapters(envOverride?: string | null): CountyAuctionAdapter[] {
  const counties = resolveActiveCounties(envOverride ?? process.env.LR_ACTIVE_COUNTIES);
  const out: CountyAuctionAdapter[] = [];
  for (const slug of counties) {
    const cfg = COUNTY_REGISTRY[slug as CountySlug];
    if (!cfg) continue;
    if (cfg.taxDeedHost) {
      out.push(
        createRealAuctionAdapter({
          county: cfg.slug,
          channel: AuctionChannel.TAX_DEED,
          host: cfg.taxDeedHost,
        }),
      );
    }
    if (cfg.foreclosureHost) {
      out.push(
        createRealAuctionAdapter({
          county: cfg.slug,
          channel: AuctionChannel.FORECLOSURE,
          host: cfg.foreclosureHost,
        }),
      );
    }
  }
  return out;
}

/** @deprecated prefer buildCountyAdapters() */
export const miamiTaxDeedAdapter = createRealAuctionAdapter({
  county: "miami-dade",
  channel: AuctionChannel.TAX_DEED,
  host: "miamidade.realtaxdeed.com",
});

/** @deprecated prefer buildCountyAdapters() */
export const miamiForecloseAdapter = createRealAuctionAdapter({
  county: "miami-dade",
  channel: AuctionChannel.FORECLOSURE,
  host: "miamidade.realforeclose.com",
});
