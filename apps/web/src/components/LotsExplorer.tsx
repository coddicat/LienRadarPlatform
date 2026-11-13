"use client";

import { useMemo, useState } from "react";
import { GatePill } from "@/components/GatePill";
import { LotDrawer } from "@/components/LotDrawer";
import { StatusPill } from "@/components/StatusPill";
import { useI18n } from "@/components/I18nProvider";
import { SingleSelect } from "@/components/ui/MultiSelect";
import { countyLabel } from "@/lib/countyLabel";
import { pct, usd, ymd } from "@/lib/format";

export type LotListItem = {
  id: string;
  caseNumber: string;
  folio: string;
  county: string;
  channel: string;
  status: string;
  bucket: string;
  saleDate: string;
  propertyAddress: string | null;
  propertyAddressLine: string | null;
  city: string | null;
  zip: string | null;
  plaintiff: string | null;
  openingBid: number | null;
  judgmentAmount: number | null;
  winningBid: number | null;
  purchaseConfirmed: boolean;
  valueHint: number | null;
  spread: number | null;
  discountPct: number | null;
  ceiling: number | null;
  hasGate: boolean;
  bidAllowed: boolean;
  needsDd: boolean;
  fillScore: number | null;
  barriers: unknown;
  sourceUrl: string | null;
  lat: number | null;
  lng: number | null;
  riskCount: number;
  riskFailCount: number;
  riskUnknownCount: number;
  beds: number | null;
  baths: number | null;
  livingSqft: number | null;
  yearBuilt: number | null;
  daysUntilSale: number | null;
};

type SortKey = "sale" | "discount" | "opening" | "value" | "fill";

function FillMeter({ score }: { score: number | null }) {
  if (score == null) return <span className="muted">—</span>;
  const pctPts = Math.round(Math.max(0, Math.min(1, score)) * 100);
  const tone = pctPts >= 80 ? "ok" : pctPts >= 50 ? "warn" : "bad";
  return (
    <div className="fill-meter" title={`${pctPts}%`}>
      <div className="fill-meter-track">
        <div className={`fill-meter-bar ${tone}`} style={{ width: `${pctPts}%` }} />
      </div>
      <span className="mono fill-meter-label">{pctPts}%</span>
    </div>
  );
}

function SaleWhen({
  saleDate,
  bucket,
  daysUntilSale,
  bucketLabel,
  todayLabel,
  inDaysLabel,
  daysAgoLabel,
}: {
  saleDate: string;
  bucket: string;
  daysUntilSale: number | null;
  bucketLabel: string;
  todayLabel: string;
  inDaysLabel: (n: number) => string;
  daysAgoLabel: (n: number) => string;
}) {
  let relative = bucketLabel;
  if (daysUntilSale === 0) relative = todayLabel;
  else if (daysUntilSale != null && daysUntilSale > 0) relative = inDaysLabel(daysUntilSale);
  else if (daysUntilSale != null && daysUntilSale < 0) relative = daysAgoLabel(Math.abs(daysUntilSale));

  return (
    <td>
      <div className="strong mono">{ymd(saleDate)}</div>
      <div className={`row-meta sale-when ${bucket === "CURRENT" ? "is-today" : ""}`}>{relative}</div>
    </td>
  );
}

function PropertyFacts({ lot }: { lot: LotListItem }) {
  const bits: string[] = [];
  if (lot.beds != null) bits.push(`${lot.beds} bd`);
  if (lot.baths != null) bits.push(`${lot.baths} ba`);
  if (lot.livingSqft != null) bits.push(`${lot.livingSqft.toLocaleString()} sf`);
  if (lot.yearBuilt != null) bits.push(`yb ${lot.yearBuilt}`);
  if (!bits.length) return null;
  return <div className="row-meta property-facts">{bits.join(" · ")}</div>;
}

function RiskBadge({
  fail,
  unknown,
  failLabel,
  unknownLabel,
  clearLabel,
}: {
  fail: number;
  unknown: number;
  failLabel: string;
  unknownLabel: string;
  clearLabel: string;
}) {
  if (fail > 0) return <span className="pill bad">{fail} {failLabel}</span>;
  if (unknown > 0) return <span className="pill warn">{unknown} {unknownLabel}</span>;
  return <span className="pill ok">{clearLabel}</span>;
}

export function LotsExplorer({
  lots,
  resultLabel,
  hotDiscountPct = 0.2,
}: {
  lots: LotListItem[];
  resultLabel?: string;
  hotDiscountPct?: number;
}) {
  const { t } = useI18n();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sort, setSort] = useState<SortKey>("discount");
  const hotThreshold = hotDiscountPct;

  const sorted = useMemo(() => {
    const copy = [...lots];
    copy.sort((a, b) => {
      switch (sort) {
        case "discount":
          return (b.discountPct ?? -1) - (a.discountPct ?? -1);
        case "opening":
          return (a.openingBid ?? Number.POSITIVE_INFINITY) - (b.openingBid ?? Number.POSITIVE_INFINITY);
        case "value":
          return (b.valueHint ?? 0) - (a.valueHint ?? 0);
        case "fill":
          return (b.fillScore ?? 0) - (a.fillScore ?? 0);
        case "sale":
        default:
          return a.saleDate.localeCompare(b.saleDate) || a.caseNumber.localeCompare(b.caseNumber);
      }
    });
    return copy;
  }, [lots, sort]);

  const selected = sorted.find((l) => l.id === selectedId) ?? null;

  const inDaysLabel = (n: number) => t("lots.inDays", { n });
  const daysAgoLabel = (n: number) => t("lots.daysAgo", { n });

  return (
    <>
      <div className="lots-toolbar">
        <div className="lots-toolbar-legend">
          <span>
            <span className="pill ok">{t("common.allowed")}</span> {t("lots.legendReady")}
          </span>
          <span>
            <span className="pill warn">{t("common.needsDd")}</span> {t("lots.legendReview")}
          </span>
          <span>
            <span className="pill bad">{t("common.blocked")}</span> {t("lots.legendBlocked")}
          </span>
          <span className="lots-legend-hot">
            <span className="hot-dot" aria-hidden /> {t("lots.legendHot")}
          </span>
        </div>
        <div className="lots-toolbar-controls">
          <SingleSelect
            label={t("lots.sortBy")}
            value={sort}
            onChange={(next) => setSort((next as SortKey) || "discount")}
            options={[
              { value: "discount", label: t("lots.sortDiscount") },
              { value: "sale", label: t("lots.sortSale") },
              { value: "opening", label: t("lots.sortOpening") },
              { value: "value", label: t("lots.sortValue") },
              { value: "fill", label: t("lots.sortFill") },
            ]}
          />
          {resultLabel ? <span className="result-count">{resultLabel}</span> : null}
        </div>
      </div>

      {/* Desktop / wide table */}
      <div className="table-wrap lots-table-desktop">
        <table className="lots-table">
          <thead>
            <tr>
              <th>{t("common.sale")}</th>
              <th>{t("lots.colProperty")}</th>
              <th>{t("common.channel")}</th>
              <th>{t("lots.colOpening")}</th>
              <th>{t("lots.colValue")}</th>
              <th>{t("lots.colDiscount")}</th>
              <th>{t("lotDetail.ceiling")}</th>
              <th>{t("lots.colDecision")}</th>
              <th>{t("lots.colRisks")}</th>
              <th>{t("lots.colCompleteness")}</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((lot) => {
              const address = lot.propertyAddress ?? lot.propertyAddressLine ?? "—";
              const hot =
                lot.discountPct != null && lot.discountPct >= hotThreshold && lot.bucket !== "PAST";
              const place = [lot.city, lot.zip].filter(Boolean).join(" ");
              return (
                <tr
                  key={lot.id}
                  className={`lot-row ${selectedId === lot.id ? "selected" : ""} ${hot ? "hot" : ""}`}
                  onClick={() => setSelectedId(lot.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setSelectedId(lot.id);
                    }
                  }}
                  tabIndex={0}
                  role="button"
                >
                  <SaleWhen
                    saleDate={lot.saleDate}
                    bucket={lot.bucket}
                    daysUntilSale={lot.daysUntilSale}
                    bucketLabel={t(`buckets.${lot.bucket}`)}
                    todayLabel={t("lots.saleToday")}
                    inDaysLabel={inDaysLabel}
                    daysAgoLabel={daysAgoLabel}
                  />
                  <td>
                    <div className="row-title">
                      {address}
                      {hot ? <span className="hot-tag">{t("lots.hotTag")}</span> : null}
                    </div>
                    {place ? <div className="row-meta">{place}</div> : null}
                    <PropertyFacts lot={lot} />
                    <div className="row-meta mono">
                      {lot.caseNumber} · {t("common.folio")} {lot.folio}
                    </div>
                    {lot.plaintiff ? <div className="row-meta truncate">{lot.plaintiff}</div> : null}
                  </td>
                  <td>
                    <StatusPill status={lot.status} label={t(`statuses.${lot.status}`)} />
                    <div style={{ marginTop: 6 }}>
                      <span className="pill info">{t(`channels.${lot.channel}`)}</span>
                    </div>
                    <div className="row-meta">{countyLabel(t, lot.county)}</div>
                  </td>
                  <td>
                    <div className="money-stack">
                      <div className="primary">{usd(lot.openingBid)}</div>
                      <div className="secondary">
                        {t("common.judgment")}: {usd(lot.judgmentAmount)}
                      </div>
                      {lot.winningBid != null ? (
                        <div className="secondary">
                          {t("lots.winningBid")}: {usd(lot.winningBid)}
                        </div>
                      ) : null}
                    </div>
                  </td>
                  <td className="mono">{usd(lot.valueHint)}</td>
                  <td>
                    <div
                      className="strong mono"
                      style={{
                        color:
                          lot.discountPct != null && lot.discountPct > 0.15
                            ? "var(--ok)"
                            : undefined,
                      }}
                    >
                      {lot.discountPct != null ? pct(lot.discountPct) : "—"}
                    </div>
                    {lot.spread != null ? (
                      <div className="row-meta mono">{usd(lot.spread)} {t("lots.spreadVsValue")}</div>
                    ) : (
                      <div className="row-meta">{t("lots.discountHint")}</div>
                    )}
                  </td>
                  <td className="mono">{usd(lot.ceiling)}</td>
                  <td>
                    <GatePill
                      hasGate={lot.hasGate}
                      bidAllowed={lot.bidAllowed}
                      needsDd={lot.needsDd}
                      allowedLabel={t("common.allowed")}
                      blockedLabel={t("common.blocked")}
                      pendingLabel={t("common.pending")}
                      needsDdLabel={t("common.needsDd")}
                    />
                  </td>
                  <td>
                    <RiskBadge
                      fail={lot.riskFailCount}
                      unknown={lot.riskUnknownCount}
                      failLabel={t("lots.riskFailShort")}
                      unknownLabel={t("lots.riskUnknownShort")}
                      clearLabel={t("lots.riskClearShort")}
                    />
                  </td>
                  <td>
                    <FillMeter score={lot.fillScore} />
                  </td>
                </tr>
              );
            })}
            {sorted.length === 0 ? (
              <tr>
                <td colSpan={10} className="empty">
                  <div className="lots-empty">
                    <strong>{t("lots.noMatch")}</strong>
                    <p className="muted">{t("lots.noMatchHint")}</p>
                  </div>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {/* Mobile cards */}
      <div className="lots-card-list">
        {sorted.map((lot) => {
          const address = lot.propertyAddress ?? lot.propertyAddressLine ?? "—";
          const hot =
            lot.discountPct != null && lot.discountPct >= hotThreshold && lot.bucket !== "PAST";
          const place = [lot.city, lot.zip].filter(Boolean).join(" ");
          return (
            <button
              key={lot.id}
              type="button"
              className={`lot-card ${selectedId === lot.id ? "selected" : ""} ${hot ? "hot" : ""}`}
              onClick={() => setSelectedId(lot.id)}
            >
              <div className="lot-card-top">
                <div>
                  <div className="lot-card-date mono">{ymd(lot.saleDate)}</div>
                  <div className="row-meta">
                    {lot.daysUntilSale === 0
                      ? t("lots.saleToday")
                      : lot.daysUntilSale != null && lot.daysUntilSale > 0
                        ? t("lots.inDays", { n: lot.daysUntilSale })
                        : t(`buckets.${lot.bucket}`)}
                  </div>
                </div>
                <GatePill
                  hasGate={lot.hasGate}
                  bidAllowed={lot.bidAllowed}
                  needsDd={lot.needsDd}
                  allowedLabel={t("common.allowed")}
                  blockedLabel={t("common.blocked")}
                  pendingLabel={t("common.pending")}
                  needsDdLabel={t("common.needsDd")}
                />
              </div>
              <div className="lot-card-title">
                {address}
                {hot ? <span className="hot-tag">{t("lots.hotTag")}</span> : null}
              </div>
              {place ? <div className="row-meta">{place}</div> : null}
              <PropertyFacts lot={lot} />
              <div className="lot-card-meta">
                <span className="pill info">{t(`channels.${lot.channel}`)}</span>
                <StatusPill status={lot.status} label={t(`statuses.${lot.status}`)} />
                <span className="muted">{countyLabel(t, lot.county)}</span>
              </div>
              <div className="lot-card-money">
                <div>
                  <div className="label">{t("lots.colOpening")}</div>
                  <div className="mono strong">{usd(lot.openingBid)}</div>
                </div>
                <div>
                  <div className="label">{t("lots.colValue")}</div>
                  <div className="mono">{usd(lot.valueHint)}</div>
                </div>
                <div>
                  <div className="label">{t("lots.colDiscount")}</div>
                  <div
                    className="mono strong"
                    style={{
                      color:
                        lot.discountPct != null && lot.discountPct > 0.15
                          ? "var(--ok)"
                          : undefined,
                    }}
                  >
                    {lot.discountPct != null ? pct(lot.discountPct) : "—"}
                  </div>
                </div>
                <div>
                  <div className="label">{t("lotDetail.ceiling")}</div>
                  <div className="mono">{usd(lot.ceiling)}</div>
                </div>
              </div>
              <div className="lot-card-foot">
                <span className="mono muted">
                  {lot.caseNumber} · {lot.folio}
                </span>
                <FillMeter score={lot.fillScore} />
              </div>
            </button>
          );
        })}
        {sorted.length === 0 ? (
          <div className="lots-empty">
            <strong>{t("lots.noMatch")}</strong>
            <p className="muted">{t("lots.noMatchHint")}</p>
          </div>
        ) : null}
      </div>

      <LotDrawer lot={selected} open={!!selected} onClose={() => setSelectedId(null)} />
    </>
  );
}
