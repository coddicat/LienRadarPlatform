"use client";

import { AmountKind, DebtCategory, RiskResult } from "@lienradar/shared";
import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";
import { useI18n } from "@/components/I18nProvider";

const DEBTS = [
  { value: DebtCategory.TAX, labelKey: "dd.catTax" },
  { value: DebtCategory.HOA, labelKey: "dd.catHoa" },
  { value: DebtCategory.UTILITY, labelKey: "dd.catUtility" },
  { value: DebtCategory.MUNI_CODE, labelKey: "dd.catMuni" },
  { value: DebtCategory.MORTGAGE, labelKey: "dd.catMortgage" },
] as const;

const RISKS = [
  "bankruptcy",
  "redemption",
  "federal_lien",
  "title_insurability",
  "flood",
  "occupancy",
];

export function ManualDdForm({ lotId }: { lotId: string }) {
  const { t } = useI18n();
  const router = useRouter();
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    setMsg(null);
    const fd = new FormData(e.currentTarget);
    const mode = String(fd.get("mode") || "debt");
    const body: Record<string, unknown> = {
      lotId,
      evidenceNote: fd.get("evidenceNote"),
      documentUrl: fd.get("documentUrl") || null,
    };
    if (mode === "debt") {
      body.debtCategory = fd.get("debtCategory");
      body.amount = fd.get("amount");
      body.amountKind = fd.get("amountKind");
      body.searchScoped = fd.get("searchScoped") === "on";
      body.holder = fd.get("holder");
    } else if (mode === "mortgage") {
      body.mortgageL2 = true;
      body.lender = fd.get("lender");
      body.mortgageBalance = fd.get("mortgageBalance");
      body.satisfied = fd.get("satisfied") === "yes" ? true : fd.get("satisfied") === "no" ? false : null;
    } else if (mode === "risk") {
      body.riskCode = fd.get("riskCode");
      body.riskResult = fd.get("riskResult");
    }
    const res = await fetch("/api/dd", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    setPending(false);
    if (!res.ok) {
      setMsg(t("common.saveFailed"));
      return;
    }
    setMsg(
      `${t("common.saved")} · ${json.bidAllowed ? t("common.allowed") : t("common.needsDd")} · ${t("common.fill")} ${json.fillScore}`,
    );
    router.refresh();
  }

  return (
    <form className="stack" onSubmit={onSubmit} style={{ maxWidth: 560 }}>
      <h2 style={{ margin: "0" }}>{t("dd.title")}</h2>
      <p className="sub">{t("dd.hint")}</p>
      <label>
        {t("dd.mode")}
        <select className="field" name="mode" defaultValue="debt">
          <option value="debt">{t("dd.modeDebt")}</option>
          <option value="mortgage">{t("dd.modeMortgage")}</option>
          <option value="risk">{t("dd.modeRisk")}</option>
        </select>
      </label>
      <label>
        {t("dd.debtCategory")}
        <select className="field" name="debtCategory" defaultValue={DebtCategory.TAX}>
          {DEBTS.map((c) => (
            <option key={c.value} value={c.value}>{t(c.labelKey)}</option>
          ))}
        </select>
      </label>
      <label>
        {t("dd.amount")}
        <input className="field" name="amount" type="number" step="0.01" />
      </label>
      <label>
        {t("dd.amountKind")}
        <select className="field" name="amountKind" defaultValue={AmountKind.EXACT_FROM_DOC}>
          <option value={AmountKind.EXACT_FROM_DOC}>{t("dd.amountExact")}</option>
          <option value={AmountKind.ESTIMATED_SCENARIO}>{t("dd.amountEstimated")}</option>
          <option value={AmountKind.UNKNOWN}>{t("dd.amountUnknown")}</option>
        </select>
      </label>
      <label style={{ display: "flex", gap: 8, alignItems: "center", flexDirection: "row" }}>
        <input type="checkbox" name="searchScoped" defaultChecked />
        {t("dd.searchScoped")}
      </label>
      <label>
        {t("dd.holder")}
        <input className="field" name="holder" />
      </label>
      <label>
        {t("dd.lender")}
        <input className="field" name="lender" />
      </label>
      <label>
        {t("dd.mortgageBalance")}
        <input className="field" name="mortgageBalance" type="number" step="0.01" />
      </label>
      <label>
        {t("dd.satisfied")}
        <select className="field" name="satisfied" defaultValue="">
          <option value="">—</option>
          <option value="yes">{t("common.yesShort")}</option>
          <option value="no">{t("common.noShort")}</option>
        </select>
      </label>
      <label>
        {t("dd.riskCode")}
        <select className="field" name="riskCode" defaultValue="occupancy">
          {RISKS.map((c) => (
            <option key={c} value={c}>{c.replaceAll("_", " ")}</option>
          ))}
        </select>
      </label>
      <label>
        {t("dd.riskResult")}
        <select className="field" name="riskResult" defaultValue={RiskResult.PASS}>
          <option value={RiskResult.PASS}>{t("dd.riskPass")}</option>
          <option value={RiskResult.FAIL}>{t("dd.riskFail")}</option>
          <option value={RiskResult.UNKNOWN}>{t("dd.riskUnknown")}</option>
          <option value={RiskResult.NOT_APPLICABLE}>{t("dd.riskNa")}</option>
        </select>
      </label>
      <label>
        {t("dd.evidence")}
        <textarea className="field" name="evidenceNote" rows={3} required placeholder={t("dd.evidencePh")} />
      </label>
      <label>
        {t("dd.docUrl")}
        <input className="field" name="documentUrl" type="url" />
      </label>
      <button className="btn" type="submit" disabled={pending}>
        {pending ? t("common.saving") : t("dd.save")}
      </button>
      {msg ? <p className="muted">{msg}</p> : null}
    </form>
  );
}
