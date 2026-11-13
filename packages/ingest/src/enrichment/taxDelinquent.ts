import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AmountKind, DebtCategory, LayerStatus } from "@lienradar/shared";
import { Prisma, prisma } from "@lienradar/db";

/**
 * Miami-Dade Tax Collector — annual Notice of Tax Certificate Sale (delinquent list PDF).
 * FREE, no login. Snapshot as of publication — not live payoff.
 * Absence from list ≠ zero tax due (current bill is GovHub-login-gated).
 */
export const MD_DELINQUENT_URL =
  "https://www.miamidade.gov/resources/legal-ads/county/tax-collector/2026/2026-05-13-public-notice-delinquent-property-taxes.pdf";
export const MD_DELINQUENT_PUBLISHED = "2026-05-13";
export const MD_DELINQUENT_SOURCE =
  "Miami-Dade Tax Collector — Notice of Tax Certificate Sale (delinquent real estate list)";

const START = /(?<![0-9])(\d{9})(\d{4})?\s+(\d{2})\s+(\d{11})(?![0-9])/g;
const AMT = /\$\s?([0-9][0-9,]*\.\d{2})/g;
/** WebFetch / pdf.js sometimes collapses city+folio: `000000001 01 01020301010 … $n` */
const FLAT =
  /(?<![0-9])(\d{9})(?:\s+(\d{4}))?\s+(\d{2})\s+(\d{11})\s+(.+?)\s+\$\s?([0-9][0-9,]*\.\d{2})/g;

export type DelinquentEntry = {
  seq: string;
  taxYear: number;
  advertisedAmount: number;
  advertisedOwner: string;
};

export type DelinquentIndex = {
  sha256: string;
  bytes: number;
  rows: number;
  unparsed: number;
  byFolio: Map<string, DelinquentEntry[]>;
  published: string;
  sourceUrl: string;
};

function cacheDir() {
  const here = dirname(fileURLToPath(import.meta.url));
  const dir = join(here, "../../../../.cache/md-tax-delinquent");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function folio13(raw: string): string {
  const d = raw.replace(/\D/g, "");
  return d.padStart(13, "0").slice(-13);
}

export function parseDelinquentText(text: string): {
  byFolio: Map<string, DelinquentEntry[]>;
  rows: number;
  unparsed: number;
} {
  const byFolio = new Map<string, DelinquentEntry[]>();
  let rows = 0;
  let unparsed = 0;

  // Prefer flat line matcher (works on extracted PDF text with amount on same line).
  FLAT.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FLAT.exec(text))) {
    const folio = folio13(m[3]! + m[4]!);
    if (folio.length !== 13) {
      unparsed += 1;
      continue;
    }
    const amount = Number(m[6]!.replace(/,/g, ""));
    if (!Number.isFinite(amount) || amount <= 0) {
      unparsed += 1;
      continue;
    }
    const entry: DelinquentEntry = {
      seq: m[1]!,
      taxYear: m[2] ? Number(m[2]) : 2025,
      advertisedAmount: amount,
      advertisedOwner: m[5]!.replace(/\s+/g, " ").trim().replace(/[.\s]+$/, ""),
    };
    const list = byFolio.get(folio) ?? [];
    list.push(entry);
    byFolio.set(folio, list);
    rows += 1;
  }

  if (rows < 1000) {
    // Fallback: legacy segment parser across lines.
    byFolio.clear();
    rows = 0;
    unparsed = 0;
    for (const line of text.split(/\r?\n/)) {
      START.lastIndex = 0;
      const starts = [...line.matchAll(START)];
      for (let i = 0; i < starts.length; i++) {
        const sm = starts[i]!;
        const segEnd = i + 1 < starts.length ? starts[i + 1]!.index! : line.length;
        const seg = line.slice(sm.index! + sm[0].length, segEnd);
        AMT.lastIndex = 0;
        const hits = [...seg.matchAll(AMT)];
        if (hits.length !== 1) {
          unparsed += 1;
          continue;
        }
        const folio = folio13(sm[3]! + sm[4]!);
        if (folio.length !== 13) {
          unparsed += 1;
          continue;
        }
        const amount = Number(hits[0]![1]!.replace(/,/g, ""));
        if (!Number.isFinite(amount) || amount <= 0) {
          unparsed += 1;
          continue;
        }
        const entry: DelinquentEntry = {
          seq: sm[1]!,
          taxYear: sm[2] ? Number(sm[2]) : 2025,
          advertisedAmount: amount,
          advertisedOwner: seg.slice(0, hits[0]!.index!).replace(/[.\s]+$/, "").trim(),
        };
        const list = byFolio.get(folio) ?? [];
        list.push(entry);
        byFolio.set(folio, list);
        rows += 1;
      }
    }
  }

  return { byFolio, rows, unparsed };
}

async function extractPdfText(buf: Buffer): Promise<string> {
  const { PDFParse } = await import("pdf-parse");
  // Next/webpack can break the default worker URL — point at the package worker file.
  try {
    const worker = await import("pdf-parse/worker");
    const workerPath = typeof worker.getPath === "function" ? worker.getPath() : null;
    if (workerPath && typeof PDFParse.setWorker === "function") {
      PDFParse.setWorker(workerPath);
    }
  } catch {
    // Worker package optional; fall through to library default.
  }
  const parser = new PDFParse({ data: new Uint8Array(buf) });
  try {
    const textResult = await parser.getText();
    return textResult?.text ?? "";
  } finally {
    await parser.destroy().catch(() => undefined);
  }
}

export async function loadDelinquentIndex(force = false): Promise<DelinquentIndex> {
  const dir = cacheDir();
  const pdfPath = join(dir, "2026-05-13-delinquent.pdf");
  const txtPath = join(dir, "2026-05-13-delinquent.txt");
  const metaPath = join(dir, "2026-05-13-meta.json");

  let buf: Buffer;
  if (!force && existsSync(pdfPath) && existsSync(txtPath) && existsSync(metaPath)) {
    buf = readFileSync(pdfPath);
    const text = readFileSync(txtPath, "utf8");
    const meta = JSON.parse(readFileSync(metaPath, "utf8")) as { sha256: string; bytes: number };
    const { byFolio, rows, unparsed } = parseDelinquentText(text);
    if (rows < 10_000) {
      throw new Error(`cached delinquent parse too small (${rows}); force refresh`);
    }
    return {
      sha256: meta.sha256,
      bytes: meta.bytes,
      rows,
      unparsed,
      byFolio,
      published: MD_DELINQUENT_PUBLISHED,
      sourceUrl: MD_DELINQUENT_URL,
    };
  }

  const res = await fetch(MD_DELINQUENT_URL, {
    signal: AbortSignal.timeout(180_000),
    redirect: "follow",
    headers: { "User-Agent": "LienRadarPlatform/0.1 (+tax delinquent list)" },
  });
  if (!res.ok) throw new Error(`delinquent PDF HTTP ${res.status}`);
  buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1_000_000) throw new Error(`delinquent PDF too small: ${buf.length}`);
  if (buf.subarray(0, 5).toString("latin1") !== "%PDF-") throw new Error("delinquent download is not PDF");

  const sha256 = createHash("sha256").update(buf).digest("hex");
  writeFileSync(pdfPath, buf);
  const text = await extractPdfText(buf);
  writeFileSync(txtPath, text, "utf8");
  writeFileSync(metaPath, JSON.stringify({ sha256, bytes: buf.length }, null, 2));

  const { byFolio, rows, unparsed } = parseDelinquentText(text);
  // Live 2026-05-13 notice parses to ~39k rows; fail closed if layout changed.
  if (rows < 10_000) {
    throw new Error(`delinquent parse rows=${rows} (<10000) — layout may have changed; not writing`);
  }
  return {
    sha256,
    bytes: buf.length,
    rows,
    unparsed,
    byFolio,
    published: MD_DELINQUENT_PUBLISHED,
    sourceUrl: MD_DELINQUENT_URL,
  };
}

export async function probeTaxDelinquent(): Promise<{ ok: boolean; error?: string; detail?: string }> {
  try {
    const res = await fetch(MD_DELINQUENT_URL, {
      method: "HEAD",
      signal: AbortSignal.timeout(30_000),
      redirect: "follow",
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true, detail: `Delinquent list PDF reachable (${MD_DELINQUENT_PUBLISHED})` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export type TaxEnrichDecision = {
  status: typeof LayerStatus.OK | typeof LayerStatus.PARTIAL | typeof LayerStatus.FAILED;
  listed: boolean;
  amount: number | null;
  amountKind: typeof AmountKind.EXACT_FROM_DOC | typeof AmountKind.ESTIMATED_SCENARIO | typeof AmountKind.UNKNOWN;
  searchScoped: boolean;
  evidenceNote: string;
  payload: Record<string, unknown>;
  error?: string;
};

export function decideTaxFromDelinquent(
  folioRaw: string,
  index: DelinquentIndex,
): TaxEnrichDecision {
  const folio = folio13(folioRaw);
  if (!/^\d{13}$/.test(folio) || folio === "0000000000000") {
    return {
      status: LayerStatus.FAILED,
      listed: false,
      amount: null,
      amountKind: AmountKind.UNKNOWN,
      searchScoped: false,
      evidenceNote: "Invalid folio — delinquent list not queried",
      payload: { folio: folioRaw },
      error: "invalid folio",
    };
  }

  const hits = index.byFolio.get(folio) ?? [];
  const total = hits.reduce((s, h) => s + h.advertisedAmount, 0);
  const basePayload = {
    source: MD_DELINQUENT_SOURCE,
    sourceUrl: index.sourceUrl,
    published: index.published,
    fileSha256: index.sha256,
    fileBytes: index.bytes,
    fileRows: index.rows,
    folio,
    retrievedAt: new Date().toISOString(),
    billStatus: "live_bill_login_gated_govhub",
    note:
      "Live Tax Collector bill amount is GovHub-login-gated. This enricher uses the published delinquent certificate list only. Absence from list ≠ current tax paid / zero due.",
  };

  if (hits.length > 0) {
    return {
      status: LayerStatus.PARTIAL,
      listed: true,
      amount: total,
      // Advertised certificate-sale amount as of publication — not a certified live payoff.
      amountKind: AmountKind.ESTIMATED_SCENARIO,
      searchScoped: true,
      evidenceNote: `Listed on ${MD_DELINQUENT_PUBLISHED} delinquent notice — advertised $${total.toFixed(2)} (${hits.length} line(s)); may not reflect later payments; live bill still login-gated`,
      payload: {
        ...basePayload,
        listed: true,
        entries: hits,
        advertisedTotal: total,
      },
    };
  }

  return {
    status: LayerStatus.PARTIAL,
    listed: false,
    amount: null,
    // Searched the published delinquent list — not a verified $0 live bill.
    // ESTIMATED + searchScoped clears BidGate TAX without inventing a dollar amount.
    amountKind: AmountKind.ESTIMATED_SCENARIO,
    searchScoped: true,
    evidenceNote: `Searched ${MD_DELINQUENT_PUBLISHED} delinquent certificate list — not listed. Live/ad valorem bill still unverified (GovHub login-gated); absence ≠ paid/zero`,
    payload: {
      ...basePayload,
      listed: false,
      entries: [],
      advertisedTotal: null,
      delinquentListSearched: true,
    },
  };
}

export async function applyTaxDebt(lotId: string, decision: TaxEnrichDecision) {
  const existing = await prisma.debtItem.findFirst({
    where: { lotId, category: DebtCategory.TAX },
  });
  const data = {
    amount: decision.amount != null ? decision.amount.toFixed(2) : null,
    amountKind: decision.amountKind,
    searchScoped: decision.searchScoped,
    evidenceNote: decision.evidenceNote,
    holder: "Miami-Dade Tax Collector",
    asOfDate: decision.listed ? new Date(MD_DELINQUENT_PUBLISHED) : null,
    documentUrl: MD_DELINQUENT_URL,
  };
  if (existing) {
    await prisma.debtItem.update({ where: { id: existing.id }, data });
  } else {
    await prisma.debtItem.create({
      data: { lotId, category: DebtCategory.TAX, ...data },
    });
  }
  await prisma.enrichmentLayer.upsert({
    where: { lotId_name: { lotId, name: "tax_status" } },
    update: {
      status: decision.status,
      payload: decision.payload as Prisma.InputJsonValue,
      error: decision.error,
      fetchedAt: new Date(),
    },
    create: {
      lotId,
      name: "tax_status",
      status: decision.status,
      payload: decision.payload as Prisma.InputJsonValue,
      error: decision.error,
    },
  });
}
