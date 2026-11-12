"use client";

import { useMemo, useState } from "react";
import {
  DEFAULT_METHOD_SETTINGS,
  type BarrierSeverity,
  type MethodSettings,
  type MortgageL2Policy,
} from "@lienradar/method";
import { SingleSelect } from "@/components/ui/MultiSelect";
import { useI18n } from "@/components/I18nProvider";

type Props = {
  initial: MethodSettings;
};

const SEVERITY_KEYS: Array<{
  group: "debtUnknown" | "riskUnknown";
  code: string;
  labelKey: string;
}> = [
  { group: "debtUnknown", code: "HOA", labelKey: "debtHoa" },
  { group: "debtUnknown", code: "UTILITY", labelKey: "debtUtility" },
  { group: "debtUnknown", code: "TAX", labelKey: "debtTax" },
  { group: "debtUnknown", code: "MUNI_CODE", labelKey: "debtMuni" },
  { group: "debtUnknown", code: "MORTGAGE", labelKey: "debtMortgage" },
  { group: "riskUnknown", code: "federal_lien", labelKey: "riskFederal" },
  { group: "riskUnknown", code: "title_insurability", labelKey: "riskTitle" },
  { group: "riskUnknown", code: "occupancy", labelKey: "riskOccupancy" },
  { group: "riskUnknown", code: "bankruptcy", labelKey: "riskBankruptcy" },
  { group: "riskUnknown", code: "flood", labelKey: "riskFlood" },
];

function PctField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
}) {
  return (
    <label className="stack" style={{ gap: 6 }}>
      <span className="muted">{label}</span>
      <input
        className="input"
        type="number"
        min={0}
        max={100}
        step={1}
        value={Math.round(value * 1000) / 10}
        onChange={(e) => {
          const raw = Number(e.target.value);
          if (!Number.isFinite(raw)) return;
          onChange(Math.max(0, Math.min(100, raw)) / 100);
        }}
      />
    </label>
  );
}

export function MethodSettingsForm({ initial }: Props) {
  const { t } = useI18n();
  const [settings, setSettings] = useState<MethodSettings>(initial);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<"saved" | "error" | null>(null);

  const severityOptions = useMemo(
    () => [
      { value: "block", label: t("settings.severityBlock") },
      { value: "warn", label: t("settings.severityWarn") },
      { value: "ignore", label: t("settings.severityIgnore") },
    ],
    [t],
  );

  const l2Options = useMemo(
    () => [
      { value: "block", label: t("settings.l2Block") },
      { value: "warn_if_l1", label: t("settings.l2Warn") },
      { value: "ignore", label: t("settings.l2Ignore") },
    ],
    [t],
  );

  const preview = useMemo(() => {
    const { repairReservePct, profitPct, ownerHaircut } = settings.ceiling;
    const base = 200_000 * (1 - repairReservePct - profitPct) * ownerHaircut;
    return Math.max(0, Math.round(base));
  }, [settings.ceiling]);

  function setCeiling(key: keyof MethodSettings["ceiling"], value: number) {
    setSettings((s) => ({ ...s, ceiling: { ...s.ceiling, [key]: value } }));
  }

  function setSeverity(
    group: "debtUnknown" | "riskUnknown",
    code: string,
    severity: BarrierSeverity,
  ) {
    setSettings((s) => ({
      ...s,
      decisions: {
        ...s.decisions,
        [group]: { ...s.decisions[group], [code]: severity },
      },
    }));
  }

  async function persist(next: MethodSettings | "defaults") {
    setBusy(true);
    setFlash(null);
    try {
      const res = await fetch("/api/settings/method", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(next === "defaults" ? { reset: true } : { settings: next }),
      });
      if (!res.ok) throw new Error("save_failed");
      const data = (await res.json()) as { settings: MethodSettings };
      setSettings(data.settings);
      setFlash("saved");
    } catch {
      setFlash("error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack" style={{ gap: 20 }}>
      <section className="filter-panel stack" style={{ gap: 14 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 18 }}>{t("settings.ceilingTitle")}</h2>
          <p className="muted" style={{ margin: "6px 0 0" }}>
            {t("settings.ceilingSub")}
          </p>
        </div>
        <div className="filter-grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(160px,1fr))" }}>
          <PctField
            label={t("settings.repair")}
            value={settings.ceiling.repairReservePct}
            onChange={(n) => setCeiling("repairReservePct", n)}
          />
          <PctField
            label={t("settings.profit")}
            value={settings.ceiling.profitPct}
            onChange={(n) => setCeiling("profitPct", n)}
          />
          <PctField
            label={t("settings.haircut")}
            value={settings.ceiling.ownerHaircut}
            onChange={(n) => setCeiling("ownerHaircut", n)}
          />
        </div>
        <p className="muted" style={{ margin: 0 }}>
          {t("settings.preview")}:{" "}
          <strong>
            {t("settings.previewResult")} ${preview.toLocaleString("en-US")}
          </strong>
        </p>
      </section>

      <section className="filter-panel stack" style={{ gap: 14 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 18 }}>{t("settings.decisionsTitle")}</h2>
          <p className="muted" style={{ margin: "6px 0 0" }}>
            {t("settings.decisionsSub")}
          </p>
        </div>
        <div className="stack" style={{ gap: 10 }}>
          {SEVERITY_KEYS.map((row) => {
            const value =
              settings.decisions[row.group][row.code] ??
              (row.group === "debtUnknown" || row.group === "riskUnknown" ? "block" : "block");
            return (
              <SingleSelect
                key={`${row.group}:${row.code}`}
                label={t(`settings.${row.labelKey}`)}
                options={severityOptions}
                value={value}
                onChange={(v) => setSeverity(row.group, row.code, v as BarrierSeverity)}
              />
            );
          })}
          <SingleSelect
            label={t("settings.mortgageL2")}
            options={l2Options}
            value={settings.decisions.mortgageL2}
            onChange={(v) =>
              setSettings((s) => ({
                ...s,
                decisions: { ...s.decisions, mortgageL2: v as MortgageL2Policy },
              }))
            }
          />
        </div>
      </section>

      <section className="filter-panel stack" style={{ gap: 14 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 18 }}>{t("settings.opportunityTitle")}</h2>
          <p className="muted" style={{ margin: "6px 0 0" }}>
            {t("settings.opportunitySub")}
          </p>
        </div>
        <div style={{ maxWidth: 220 }}>
          <PctField
            label={t("settings.hotDiscount")}
            value={settings.opportunity.hotDiscountPct}
            onChange={(n) =>
              setSettings((s) => ({
                ...s,
                opportunity: { ...s.opportunity, hotDiscountPct: n },
              }))
            }
          />
        </div>
      </section>

      <div className="row" style={{ gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <button className="btn" type="button" disabled={busy} onClick={() => void persist(settings)}>
          {busy ? t("settings.saving") : t("settings.save")}
        </button>
        <button
          className="btn ghost"
          type="button"
          disabled={busy}
          onClick={() => {
            setSettings(DEFAULT_METHOD_SETTINGS);
            void persist("defaults");
          }}
        >
          {t("settings.reset")}
        </button>
        {flash === "saved" ? <span className="muted">{t("settings.saved")}</span> : null}
        {flash === "error" ? (
          <span style={{ color: "var(--bad)" }}>{t("settings.saveFailed")}</span>
        ) : null}
      </div>
    </div>
  );
}
