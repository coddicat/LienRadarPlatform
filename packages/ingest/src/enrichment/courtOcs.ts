import { LayerStatus, MortgageRankLevel, RiskResult } from "@lienradar/shared";
import { Prisma, prisma } from "@lienradar/db";
import { syncMortgageDebtRow } from "./syncMortgageDebt.js";

const MD_BASE = "https://www2.miamidadeclerk.gov";

export type OcsResult = {
  matched: boolean;
  plaintiff: string | null;
  defendants: string[];
  caseType: string | null;
  caseCategory: string;
  caseStatus: string | null;
  judgmentAmount: number | null;
  bankruptcyMention: boolean;
  sourceUrl: string;
  payload: Record<string, unknown>;
  error?: string;
};

function categorize(caseType: string | null, plaintiff: string | null): string {
  const t = (caseType || "").toUpperCase();
  const p = (plaintiff || "").toUpperCase();
  if (t.includes("TAX DEED") || t.includes("TAX CERT")) return "tax";
  if (
    t.includes("HOA") ||
    t.includes("ASSOCIATION") ||
    t.includes("CONDO") ||
    /\b(HOMEOWNERS?|CONDOMINIUM|PROPERTY OWNERS?)\b.*ASSOCIATION/.test(p) ||
    /ASSOCIATION,?\s+INC/.test(p)
  ) {
    return "hoa";
  }
  if (t.includes("RPMF") || t.includes("MORTGAGE FORECLOSURE") || t.includes("FORECLOS")) {
    return "mortgage_foreclosure";
  }
  return t ? "other" : "unknown";
}

function moneyFromText(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = s.replace(/,/g, "").match(/\$?\s*([0-9]+(?:\.[0-9]{1,2})?)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export async function probeCourtOcs(): Promise<{ ok: boolean; error?: string; detail?: string }> {
  try {
    const res = await fetch(`${MD_BASE}/ocs/`, {
      signal: AbortSignal.timeout(20_000),
      redirect: "follow",
      headers: { "User-Agent": "LienRadarPlatform/0.1 (+internal OCS probe)" },
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true, detail: "OCS shell reachable (free docket API)" };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Free Miami-Dade OCS case lookup — no captcha/login. */
export async function fetchCourtOcs(caseNumber: string): Promise<OcsResult> {
  const src = `${MD_BASE}/ocs/ (case ${caseNumber})`;
  const headers = {
    Accept: "application/json",
    Referer: `${MD_BASE}/ocs/`,
    "User-Agent": "Mozilla/5.0 (compatible; LienRadarPlatform/0.1)",
  };
  try {
    await fetch(`${MD_BASE}/ocs/`, { signal: AbortSignal.timeout(20_000), headers, redirect: "follow" });
    const enc = await fetch(`${MD_BASE}/ocs/api/CaseInfo/encrypt/${encodeURIComponent(caseNumber)}`, {
      signal: AbortSignal.timeout(30_000),
      headers,
    });
    if (!enc.ok) {
      return {
        matched: false,
        plaintiff: null,
        defendants: [],
        caseType: null,
        caseCategory: "unknown",
        caseStatus: null,
        judgmentAmount: null,
        bankruptcyMention: false,
        sourceUrl: src,
        payload: {},
        error: `encrypt HTTP ${enc.status}`,
      };
    }
    const j1 = (await enc.json()) as { success?: boolean; qs?: string; message?: string };
    if (!j1.success || !j1.qs) {
      return {
        matched: false,
        plaintiff: null,
        defendants: [],
        caseType: null,
        caseCategory: "unknown",
        caseStatus: null,
        judgmentAmount: null,
        bankruptcyMention: false,
        sourceUrl: src,
        payload: j1 as Record<string, unknown>,
        error: j1.message || "encrypt unsuccessful",
      };
    }
    const res = await fetch(`${MD_BASE}/ocs/api/CaseInfo/GetMultipleCaseResult?qs=${j1.qs}`, {
      signal: AbortSignal.timeout(40_000),
      headers: {
        ...headers,
        Referer: `${MD_BASE}/ocs/searchResults?qs=${j1.qs}`,
      },
    });
    if (!res.ok) {
      return {
        matched: false,
        plaintiff: null,
        defendants: [],
        caseType: null,
        caseCategory: "unknown",
        caseStatus: null,
        judgmentAmount: null,
        bankruptcyMention: false,
        sourceUrl: src,
        payload: {},
        error: `case-result HTTP ${res.status}`,
      };
    }
    const j2 = (await res.json()) as {
      caseListResult?: Array<Record<string, unknown>>;
    };
    const cases = j2.caseListResult || [];
    if (!cases.length) {
      return {
        matched: false,
        plaintiff: null,
        defendants: [],
        caseType: null,
        caseCategory: "unknown",
        caseStatus: null,
        judgmentAmount: null,
        bankruptcyMention: false,
        sourceUrl: src,
        payload: {},
        error: "case not found",
      };
    }
    const cl =
      cases.find(
        (c) => String(c.caseNumber || "").trim().toUpperCase() === caseNumber.trim().toUpperCase(),
      ) || cases[0];

    const partiesRaw = (cl.parties as Array<Record<string, unknown>>) || [];
    const plaintiffs: string[] = [];
    const defendants: string[] = [];
    const parties = [];
    for (const p of partiesRaw) {
      const name = String(p.partyName || "").trim();
      const ptype = String(p.partyTypeDesc || "").trim();
      if (!name) continue;
      parties.push({ name, type: ptype, attorney: (p.leadAttName as string) || null });
      const tl = ptype.toLowerCase();
      if (tl.includes("plaintiff") || tl.includes("petitioner")) plaintiffs.push(name);
      if (tl.includes("defendant") || tl.includes("respondent")) defendants.push(name);
    }
    let plaintiff = plaintiffs[0] || null;
    const caseStyle = String(cl.caseStyle || "")
      .replace(/\n/g, " ")
      .trim();
    if (!plaintiff && caseStyle) {
      plaintiff = caseStyle.split(/\bvs\.?\b|-vs-/i)[0]?.trim() || null;
    }

    const dockets = ((cl.dockets as Array<Record<string, unknown>>) || []).map((d) => ({
      date: d.eventDate,
      code: String(d.docketCode || ""),
      desc: String(d.docketDescrition || ""),
      comments: String(d.comments || ""),
    }));

    const fjCodes = new Set(["DJUD", "SUJU", "FJUDJUD"]);
    let judgmentAmount: number | null = null;
    for (const d of dockets) {
      if (fjCodes.has(d.code)) {
        judgmentAmount = moneyFromText(d.comments) || moneyFromText(d.desc);
        if (judgmentAmount) break;
      }
    }

    const blob = JSON.stringify(dockets).toLowerCase();
    const bankruptcyMention = blob.includes("bankrupt");

    const caseType = (cl.caseType as string) || null;
    const matched = !!(plaintiff || parties.length || dockets.length || caseType || caseStyle);
    return {
      matched,
      plaintiff,
      defendants,
      caseType,
      caseCategory: categorize(caseType, plaintiff),
      caseStatus: (cl.caseStatus as string) || null,
      judgmentAmount,
      bankruptcyMention,
      sourceUrl: src,
      payload: {
        flavor: "miamidade_ocs",
        matched,
        caseNumber: cl.caseNumber || caseNumber,
        caseStyle,
        parties,
        caseType,
        caseStatus: cl.caseStatus,
        docketCount: dockets.length,
        dockets: dockets.slice(0, 80),
        judgmentAmount,
        bankruptcyMention,
      },
    };
  } catch (e) {
    return {
      matched: false,
      plaintiff: null,
      defendants: [],
      caseType: null,
      caseCategory: "unknown",
      caseStatus: null,
      judgmentAmount: null,
      bankruptcyMention: false,
      sourceUrl: src,
      payload: {},
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export async function applyCourtOcs(lotId: string, caseNumber: string, result: OcsResult) {
  await prisma.enrichmentLayer.upsert({
    where: { lotId_name: { lotId, name: "court_ocs" } },
    update: {
      status: result.matched ? LayerStatus.OK : LayerStatus.PARTIAL,
      payload: result.payload as Prisma.InputJsonValue,
      error: result.error,
      fetchedAt: new Date(),
    },
    create: {
      lotId,
      name: "court_ocs",
      status: result.matched ? LayerStatus.OK : LayerStatus.PARTIAL,
      payload: result.payload as Prisma.InputJsonValue,
      error: result.error,
    },
  });

  if (result.plaintiff || result.judgmentAmount != null) {
    await prisma.lot.update({
      where: { id: lotId },
      data: {
        plaintiff: result.plaintiff || undefined,
        judgmentAmount:
          result.judgmentAmount != null ? result.judgmentAmount.toFixed(2) : undefined,
      },
    });
  }

  // L1 estimate from docket plaintiff — never L2 (joinder/service proof needs OR/docs).
  if (result.matched && result.plaintiff && result.caseCategory === "mortgage_foreclosure") {
    const existing = await prisma.mortgageAssessment.findFirst({ where: { lotId } });
    const evidenceNote =
      "OCS docket plaintiff — L1 only; L2 requires OR/joinder proof or manual DD";
    if (!existing) {
      await prisma.mortgageAssessment.create({
        data: {
          lotId,
          rankLevel: MortgageRankLevel.L1_ESTIMATE,
          lender: result.plaintiff,
          estimatedBalance: result.judgmentAmount != null ? result.judgmentAmount.toFixed(2) : null,
          evidenceNote,
        },
      });
    }
    await syncMortgageDebtRow(lotId, {
      lender: result.plaintiff,
      estimatedBalance: result.judgmentAmount != null ? result.judgmentAmount.toFixed(2) : null,
      evidenceNote,
    });
  }

  // Bankruptcy: positive mention fails; clean matched docket → PASS (docket-scoped only).
  if (result.matched) {
    if (result.bankruptcyMention) {
      await prisma.riskCheck.upsert({
        where: { lotId_code: { lotId, code: "bankruptcy" } },
        update: {
          result: RiskResult.FAIL,
          blocksBid: true,
          evidence: "OCS docket mentions bankruptcy",
          checkedAt: new Date(),
        },
        create: {
          lotId,
          code: "bankruptcy",
          result: RiskResult.FAIL,
          blocksBid: true,
          evidence: "OCS docket mentions bankruptcy",
        },
      });
    } else {
      await prisma.riskCheck.upsert({
        where: { lotId_code: { lotId, code: "bankruptcy" } },
        update: {
          result: RiskResult.PASS,
          blocksBid: false,
          evidence:
            "OCS docket scanned — no bankruptcy mention (docket-only; not a PACER/nationwide search)",
          checkedAt: new Date(),
        },
        create: {
          lotId,
          code: "bankruptcy",
          result: RiskResult.PASS,
          blocksBid: false,
          evidence:
            "OCS docket scanned — no bankruptcy mention (docket-only; not a PACER/nationwide search)",
        },
      });
    }
  }

  // Redemption N/A on judicial foreclosure dockets.
  if (result.caseCategory === "mortgage_foreclosure" || result.caseCategory === "hoa") {
    await prisma.riskCheck.upsert({
      where: { lotId_code: { lotId, code: "redemption" } },
      update: {
        result: "NOT_APPLICABLE",
        blocksBid: false,
        evidence: "Judicial foreclosure — tax-deed redemption window N/A",
        checkedAt: new Date(),
      },
      create: {
        lotId,
        code: "redemption",
        result: "NOT_APPLICABLE",
        blocksBid: false,
        evidence: "Judicial foreclosure — tax-deed redemption window N/A",
      },
    });
  }
}
