import { AmountKind, DebtCategory, LayerStatus } from "@lienradar/shared";
import { Prisma, prisma } from "@lienradar/db";

export const CCVIOL_LAYER =
  "https://services.arcgis.com/8Pc9XBTAsYuxx9Ny/arcgis/rest/services/CCVIOL_gdb/FeatureServer/0";

const OUT_FIELDS = [
  "FOLIO",
  "ADDRESS",
  "CASE_NUM",
  "CASE_DATE",
  "CASE_STATUS",
  "STAT_DESC",
  "PROBLEM",
  "PROBLEM_DESC",
  "LN_RFRL",
  "LN_RFRLTYP",
  "LN_RECBOOK",
  "LN_RECPAGE",
  "LN_RECDATE",
].join(",");

type CountyCoverage = "unincorporated" | "incorporated" | "unknown";

type CcviolAttrs = Record<string, unknown>;

function trim(v: unknown): string {
  return v == null ? "" : String(v).trim();
}

export function classifyCoverage(folio: string, city: string | null | undefined): CountyCoverage {
  const f = folio.replace(/\D/g, "");
  const c = (city ?? "").trim().toLowerCase();
  if (f.startsWith("30") || c.includes("unincorporated")) return "unincorporated";
  if (c !== "") return "incorporated";
  return "unknown";
}

export async function probeCcviol(): Promise<{ ok: boolean; error?: string; detail?: string }> {
  try {
    const params = new URLSearchParams({
      where: "1=1",
      returnCountOnly: "true",
      f: "json",
    });
    const res = await fetch(`${CCVIOL_LAYER}/query`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params,
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const json = (await res.json()) as { count?: number; error?: unknown };
    if (json.error) return { ok: false, error: JSON.stringify(json.error) };
    return { ok: true, detail: `CCVIOL count=${json.count ?? "n/a"}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function fetchCcviolByFolio(folio13: string): Promise<CcviolAttrs[]> {
  if (!/^\d{13}$/.test(folio13)) {
    throw new Error(`folio must be 13 digits, got ${folio13}`);
  }
  const params = new URLSearchParams({
    where: `FOLIO LIKE '${folio13}%'`,
    outFields: OUT_FIELDS,
    returnGeometry: "false",
    orderByFields: "CASE_DATE DESC",
    resultRecordCount: "500",
    f: "json",
  });
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${CCVIOL_LAYER}/query`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params,
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`CCVIOL HTTP ${res.status}`);
      const data = (await res.json()) as { features?: Array<{ attributes: CcviolAttrs }>; error?: unknown };
      if (data.error) throw new Error(`CCVIOL ESRI: ${JSON.stringify(data.error)}`);
      return (data.features ?? []).map((f) => f.attributes);
    } catch (e) {
      last = e;
      if (attempt < 2) await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

function isActiveOpen(code: string): boolean {
  if (code === "" || code === "2" || code === "4") return false;
  return true;
}

export type MuniEnrichResult = {
  status: typeof LayerStatus.OK | typeof LayerStatus.PARTIAL | typeof LayerStatus.FAILED;
  payload: Record<string, unknown>;
  debt: {
    amount: number | null;
    amountKind: string;
    searchScoped: boolean;
    evidenceNote: string;
  };
  error?: string;
};

/** Apply CCVIOL honesty rules into a MUNI_CODE debt decision. */
export async function enrichMuniMd(opts: {
  folio: string;
  city?: string | null;
  address?: string | null;
}): Promise<MuniEnrichResult> {
  const digits = opts.folio.replace(/\D/g, "");
  const folio13 = digits.padStart(13, "0").slice(-13);
  if (!/^\d{10,}$/.test(digits)) {
    return {
      status: LayerStatus.FAILED,
      payload: { folio: opts.folio },
      debt: {
        amount: null,
        amountKind: AmountKind.UNKNOWN,
        searchScoped: false,
        evidenceNote: "Invalid folio — CCVIOL not queried",
      },
      error: "invalid folio",
    };
  }

  const coverage = classifyCoverage(folio13, opts.city);
  try {
    const rows = await fetchCcviolByFolio(folio13);
    const cases = rows.map((a) => {
      const statusCode = trim(a.CASE_STATUS);
      const lienBook = trim(a.LN_RECBOOK);
      const isLien = statusCode === "4" || !!lienBook || !!trim(a.LN_RECDATE);
      return {
        id: trim(a.CASE_NUM),
        status: trim(a.STAT_DESC),
        statusCode,
        isOpen: isActiveOpen(statusCode),
        isLien,
        problem: trim(a.PROBLEM_DESC) || trim(a.PROBLEM) || null,
      };
    });
    const open = cases.filter((c) => c.isOpen);
    const liens = cases.filter((c) => c.isLien);

    let hasOpen: boolean | null;
    let note: string;
    if (open.length > 0) {
      hasOpen = true;
      note = `CCVIOL: ${open.length} open code case(s); ${liens.length} recorded lien flag(s)`;
    } else if (coverage === "unincorporated") {
      hasOpen = false;
      note = "CCVIOL searched (unincorporated UMSA) — no open county code cases";
    } else if (coverage === "incorporated") {
      hasOpen = null;
      note = `COVERAGE GAP: city enforcement not in CCVIOL (${opts.city ?? "incorporated"}) — absence ≠ clean`;
    } else {
      hasOpen = null;
      note = "COVERAGE UNKNOWN: jurisdiction not confirmed — absence ≠ clean";
    }

    const payload = {
      source: "miamidade_ccviol",
      folio: folio13,
      coverage,
      municipality: opts.city ?? "",
      caseCount: cases.length,
      openCaseCount: open.length,
      recordedLienCount: liens.length,
      hasOpenCodeCase: hasOpen,
      cases: cases.slice(0, 40),
      note,
      retrievedAt: new Date().toISOString(),
    };

    // Only unincorporated + zero open/lien can be search-scoped exact zero.
    if (coverage === "unincorporated" && open.length === 0 && liens.length === 0) {
      return {
        status: LayerStatus.OK,
        payload,
        debt: {
          amount: 0,
          amountKind: AmountKind.EXACT_FROM_DOC,
          searchScoped: true,
          evidenceNote: note,
        },
      };
    }
    if (liens.length > 0 || open.length > 0) {
      return {
        status: LayerStatus.PARTIAL,
        payload,
        debt: {
          amount: null,
          amountKind: AmountKind.UNKNOWN,
          searchScoped: true,
          evidenceNote: `${note} — amount not published in CCVIOL (needs city/estoppel)`,
        },
      };
    }
    return {
      status: LayerStatus.PARTIAL,
      payload,
      debt: {
        amount: null,
        amountKind: AmountKind.UNKNOWN,
        searchScoped: false,
        evidenceNote: note,
      },
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      status: LayerStatus.FAILED,
      payload: { folio: folio13, coverage },
      debt: {
        amount: null,
        amountKind: AmountKind.UNKNOWN,
        searchScoped: false,
        evidenceNote: `CCVIOL fetch failed: ${msg}`,
      },
      error: msg,
    };
  }
}

export async function applyMuniDebt(lotId: string, result: MuniEnrichResult) {
  const existing = await prisma.debtItem.findFirst({
    where: { lotId, category: DebtCategory.MUNI_CODE },
  });
  const data = {
    amount: result.debt.amount != null ? result.debt.amount.toFixed(2) : null,
    amountKind: result.debt.amountKind as "UNKNOWN" | "EXACT_FROM_DOC" | "ESTIMATED_SCENARIO",
    searchScoped: result.debt.searchScoped,
    evidenceNote: result.debt.evidenceNote,
    holder: "Miami-Dade CCVIOL",
  };
  if (existing) {
    await prisma.debtItem.update({ where: { id: existing.id }, data });
  } else {
    await prisma.debtItem.create({
      data: { lotId, category: DebtCategory.MUNI_CODE, ...data },
    });
  }
  await prisma.enrichmentLayer.upsert({
    where: { lotId_name: { lotId, name: "muni_flags" } },
    update: {
      status: result.status,
      payload: result.payload as Prisma.InputJsonValue,
      error: result.error,
      fetchedAt: new Date(),
    },
    create: {
      lotId,
      name: "muni_flags",
      status: result.status,
      payload: result.payload as Prisma.InputJsonValue,
      error: result.error,
    },
  });
}
