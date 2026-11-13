"use client";

import Link from "next/link";
import { useEffect } from "react";
import { GatePill } from "@/components/GatePill";
import { StatusPill } from "@/components/StatusPill";
import { PropertyMap } from "@/components/PropertyMap";
import { useI18n } from "@/components/I18nProvider";
import type { LotListItem } from "@/components/LotsExplorer";
import { countyLabel } from "@/lib/countyLabel";
import { pct, usd, ymd } from "@/lib/format";

type Props = {
  lot: LotListItem | null;
  open: boolean;
  onClose: () => void;
};

export function LotDrawer({ lot, open, onClose }: Props) {
  const { t } = useI18n();

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open || !lot) return null;

  const address = lot.propertyAddress ?? lot.propertyAddressLine ?? "—";
  const place = [lot.city, lot.zip].filter(Boolean).join(" ");
  const barriers = Array.isArray(lot.barriers)
    ? (lot.barriers as Array<{ code: string; message: string; severity: string }>)
    : [];
  const facts: string[] = [];
  if (lot.beds != null) facts.push(`${lot.beds} bd`);
  if (lot.baths != null) facts.push(`${lot.baths} ba`);
  if (lot.livingSqft != null) facts.push(`${lot.livingSqft.toLocaleString()} sf`);
  if (lot.yearBuilt != null) facts.push(`yb ${lot.yearBuilt}`);

  const fillPct =
    lot.fillScore != null ? Math.round(Math.max(0, Math.min(1, lot.fillScore)) * 100) : null;

  return (
    <>
      <button type="button" className="drawer-backdrop" aria-label="Close" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={address}>
        <div className="drawer-head">
          <div>
            <div className="drawer-kicker">{t("lots.drawerPreview")}</div>
            <h2 className="drawer-title">{address}</h2>
            {place ? <div className="row-meta" style={{ marginBottom: 8 }}>{place}</div> : null}
            <div className="meta-line" style={{ marginBottom: 0 }}>
              <StatusPill status={lot.status} label={t(`statuses.${lot.status}`)} />
              <span className="pill info">{t(`channels.${lot.channel}`)}</span>
              <span className="pill neutral">{countyLabel(t, lot.county)}</span>
              <span className={`pill ${lot.bucket === "CURRENT" ? "ok" : "neutral"}`}>
                {lot.daysUntilSale === 0
                  ? t("lots.saleToday")
                  : lot.daysUntilSale != null && lot.daysUntilSale > 0
                    ? t("lots.inDays", { n: lot.daysUntilSale })
                    : t(`buckets.${lot.bucket}`)}
              </span>
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

          <div className="drawer-decision">
            <GatePill
              hasGate={lot.hasGate}
              bidAllowed={lot.bidAllowed}
              needsDd={lot.needsDd}
              allowedLabel={t("common.allowed")}
              blockedLabel={t("common.blocked")}
              pendingLabel={t("common.pending")}
              needsDdLabel={t("common.needsDd")}
            />
            <div className="drawer-decision-copy">
              {lot.bidAllowed
                ? t("lots.drawerReadyCopy")
                : lot.needsDd
                  ? t("lots.drawerReviewCopy")
                  : t("lots.drawerBlockedCopy")}
            </div>
          </div>

          <div className="cards drawer-money-cards">
            <div className="card">
              <div className="label">{t("lots.colOpening")}</div>
              <div className="value" style={{ fontSize: 20 }}>
                {usd(lot.openingBid)}
              </div>
              <div className="hint">
                {t("common.judgment")}: {usd(lot.judgmentAmount)}
              </div>
            </div>
            <div className="card">
              <div className="label">{t("lots.colValue")}</div>
              <div className="value" style={{ fontSize: 20 }}>
                {usd(lot.valueHint)}
              </div>
            </div>
            <div className="card">
              <div className="label">{t("lots.colDiscount")}</div>
              <div
                className="value"
                style={{
                  fontSize: 20,
                  color:
                    lot.discountPct != null && lot.discountPct > 0.15 ? "var(--ok)" : "inherit",
                }}
              >
                {lot.discountPct != null ? pct(lot.discountPct) : "—"}
              </div>
              <div className="hint">
                {lot.spread != null
                  ? `~${usd(lot.spread)} ${t("lots.spreadVsValue")}`
                  : t("lots.discountHint")}
              </div>
            </div>
            <div className="card">
              <div className="label">{t("lotDetail.ceiling")}</div>
              <div className="value" style={{ fontSize: 20 }}>
                {usd(lot.ceiling)}
              </div>
              <div className="hint">{t("lots.ceilingHint")}</div>
            </div>
          </div>

          {facts.length ? (
            <div className="drawer-facts">
              {facts.map((f) => (
                <span key={f} className="pill neutral">
                  {f}
                </span>
              ))}
            </div>
          ) : null}

          {fillPct != null ? (
            <div className="drawer-fill">
              <div className="drawer-fill-head">
                <span>{t("lots.colCompleteness")}</span>
                <span className="mono">{fillPct}%</span>
              </div>
              <div className="fill-meter-track tall">
                <div
                  className={`fill-meter-bar ${fillPct >= 80 ? "ok" : fillPct >= 50 ? "warn" : "bad"}`}
                  style={{ width: `${fillPct}%` }}
                />
              </div>
            </div>
          ) : null}

          <dl className="kv">
            <dt>{t("common.sale")}</dt>
            <dd className="mono">{ymd(lot.saleDate)}</dd>
            <dt>{t("common.case")}</dt>
            <dd className="mono">{lot.caseNumber}</dd>
            <dt>{t("common.folio")}</dt>
            <dd className="mono">{lot.folio}</dd>
            <dt>{t("common.plaintiff")}</dt>
            <dd>{lot.plaintiff ?? "—"}</dd>
            {lot.winningBid != null ? (
              <>
                <dt>{t("lots.winningBid")}</dt>
                <dd className="mono">
                  {usd(lot.winningBid)}
                  {lot.purchaseConfirmed ? (
                    <span className="pill ok" style={{ marginLeft: 8 }}>
                      {t("lotDetail.purchaseConfirmed")}
                    </span>
                  ) : null}
                </dd>
              </>
            ) : null}
            <dt>{t("lots.colRisks")}</dt>
            <dd>
              {lot.riskFailCount > 0
                ? `${lot.riskFailCount} ${t("lots.risksFailing")}`
                : lot.riskUnknownCount > 0
                  ? `${lot.riskUnknownCount} ${t("lots.risksUnknown")}`
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
          ) : (
            <p className="muted" style={{ marginTop: 14, fontSize: 13 }}>
              {t("lotDetail.noBarriers")}
            </p>
          )}
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
