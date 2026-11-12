"use client";

import Link from "next/link";
import { GatePill } from "@/components/GatePill";
import { StatusPill } from "@/components/StatusPill";
import { PropertyMap } from "@/components/PropertyMap";
import { useI18n } from "@/components/I18nProvider";
import { countyLabel } from "@/lib/countyLabel";
import { pct, usd, ymd } from "@/lib/format";
import type { LotListItem } from "@/components/LotsExplorer";

type Props = {
  lot: LotListItem | null;
  open: boolean;
  onClose: () => void;
};

export function LotDrawer({ lot, open, onClose }: Props) {
  const { t } = useI18n();
  if (!open || !lot) return null;

  const address = lot.propertyAddress ?? lot.propertyAddressLine ?? "—";
  const barriers = Array.isArray(lot.barriers)
    ? (lot.barriers as Array<{ code: string; message: string; severity: string }>)
    : [];

  return (
    <>
      <button type="button" className="drawer-backdrop" aria-label="Close" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={address}>
        <div className="drawer-head">
          <div>
            <div className="drawer-kicker">{t("lots.drawerPreview")}</div>
            <h2 className="drawer-title">{address}</h2>
            <div className="meta-line" style={{ marginBottom: 0 }}>
              <StatusPill status={lot.status} label={t(`statuses.${lot.status}`)} />
              <span className="pill info">{t(`channels.${lot.channel}`)}</span>
              <span className="pill neutral">{countyLabel(t, lot.county)}</span>
              <span className="pill neutral">{t(`buckets.${lot.bucket}`)}</span>
            </div>
          </div>
          <button type="button" className="btn ghost drawer-close" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="drawer-body">
          <PropertyMap
            address={address}
            lat={lot.lat}
            lng={lot.lng}
            title={address}
            className="drawer-map"
          />

          <div className="cards" style={{ marginTop: 14, marginBottom: 14 }}>
            <div className="card">
              <div className="label">{t("lots.colOpening")}</div>
              <div className="value" style={{ fontSize: 20 }}>{usd(lot.openingBid)}</div>
            </div>
            <div className="card">
              <div className="label">{t("lots.colValue")}</div>
              <div className="value" style={{ fontSize: 20 }}>{usd(lot.valueHint)}</div>
            </div>
            <div className="card">
              <div className="label">{t("lots.colDiscount")}</div>
              <div
                className="value"
                style={{
                  fontSize: 20,
                  color:
                    lot.discountPct != null && lot.discountPct > 0.15
                      ? "var(--ok)"
                      : "inherit",
                }}
              >
                {lot.discountPct != null ? pct(lot.discountPct) : "—"}
              </div>
              <div className="hint">{lot.spread != null ? `~${usd(lot.spread)} vs value` : t("lots.discountHint")}</div>
            </div>
            <div className="card">
              <div className="label">{t("lotDetail.ceiling")}</div>
              <div className="value" style={{ fontSize: 20 }}>{usd(lot.ceiling)}</div>
            </div>
          </div>

          <dl className="kv">
            <dt>{t("common.sale")}</dt>
            <dd className="mono">{ymd(lot.saleDate)}</dd>
            <dt>{t("common.case")}</dt>
            <dd className="mono">{lot.caseNumber}</dd>
            <dt>{t("common.folio")}</dt>
            <dd className="mono">{lot.folio}</dd>
            <dt>{t("common.plaintiff")}</dt>
            <dd>{lot.plaintiff ?? "—"}</dd>
            <dt>{t("moneyLabels.judgmentAmount")}</dt>
            <dd className="mono">{usd(lot.judgmentAmount)}</dd>
            <dt>{t("lots.colDecision")}</dt>
            <dd>
              <GatePill
                hasGate={lot.hasGate}
                bidAllowed={lot.bidAllowed}
                needsDd={lot.needsDd}
                allowedLabel={t("common.allowed")}
                blockedLabel={t("common.blocked")}
                pendingLabel={t("common.pending")}
                needsDdLabel={t("common.needsDd")}
              />
            </dd>
            <dt>{t("lots.colCompleteness")}</dt>
            <dd className="mono">{lot.fillScore != null ? pct(lot.fillScore) : "—"}</dd>
            <dt>{t("lots.colRisks")}</dt>
            <dd>
              {lot.riskFailCount > 0
                ? `${lot.riskFailCount} ${t("lots.risksFailing")}`
                : lot.riskCount
                  ? `${lot.riskCount} ${t("lots.risksChecked")}`
                  : "—"}
            </dd>
          </dl>

          {barriers.length > 0 ? (
            <div style={{ marginTop: 16 }}>
              <h3 style={{ fontSize: 14, margin: "0 0 8px" }}>{t("lotDetail.bidBarriers")}</h3>
              {barriers.slice(0, 6).map((b) => (
                <div key={b.code} className={`barrier ${b.severity === "warn" ? "warn" : ""}`}>
                  <div className="code">{b.code.replaceAll("_", " ")}</div>
                  <div>{b.message}</div>
                </div>
              ))}
            </div>
          ) : null}
        </div>

        <div className="drawer-foot">
          {lot.sourceUrl ? (
            <a className="btn secondary" href={lot.sourceUrl} target="_blank" rel="noreferrer">
              {t("lotDetail.sourceUrl")}
            </a>
          ) : null}
          <Link className="btn" href={`/lots/${lot.id}`} onClick={onClose}>
            {t("lots.openFullPage")}
          </Link>
        </div>
      </aside>
    </>
  );
}
