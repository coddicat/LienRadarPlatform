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
  plaintiff: string | null;
  openingBid: number | null;
  judgmentAmount: number | null;
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
};

type SortKey = "sale" | "discount" | "opening" | "value" | "fill";

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

  return (
    <>
      <div className="lots-toolbar">
        <div className="lots-toolbar-legend">
          <span><span className="pill ok">{t("common.allowed")}</span> {t("lots.legendReady")}</span>
          <span><span className="pill warn">{t("common.needsDd")}</span> {t("lots.legendReview")}</span>
          <span><span className="pill bad">{t("common.blocked")}</span> {t("lots.legendBlocked")}</span>
          <span>{t("lots.legendClick")}</span>
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

      <div className="table-wrap">
        <table className="lots-table">
          <thead>
            <tr>
              <th>{t("common.sale")}</th>
              <th>{t("common.status")}</th>
              <th>{t("common.channel")}</th>
              <th>{t("lots.colProperty")}</th>
              <th>{t("lots.colOpening")}</th>
              <th>{t("lots.colValue")}</th>
              <th>{t("lots.colDiscount")}</th>
              <th>{t("lotDetail.ceiling")}</th>
              <th>{t("lots.colDecision")}</th>
              <th>{t("lots.colCompleteness")}</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((lot) => {
              const address = lot.propertyAddress ?? lot.propertyAddressLine ?? "—";
              const hot =
                lot.discountPct != null && lot.discountPct >= hotThreshold && lot.bucket !== "PAST";
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
                  <td>
                    <div className="strong mono">{ymd(lot.saleDate)}</div>
                    <div className="row-meta">{t(`buckets.${lot.bucket}`)}</div>
                  </td>
                  <td>
                    <StatusPill status={lot.status} label={t(`statuses.${lot.status}`)} />
                  </td>
                  <td>
                    <span className="pill info">{t(`channels.${lot.channel}`)}</span>
                    <div className="row-meta">{countyLabel(t, lot.county)}</div>
                  </td>
                  <td>
                    <div className="row-title">{address}</div>
                    <div className="row-meta mono">
                      {lot.caseNumber} · {t("common.folio")} {lot.folio}
                    </div>
                    {lot.plaintiff ? <div className="row-meta">{lot.plaintiff}</div> : null}
                  </td>
                  <td>
                    <div className="money-stack">
                      <div className="primary">{usd(lot.openingBid)}</div>
                      <div className="secondary">{usd(lot.judgmentAmount)}</div>
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
                      <div className="row-meta mono">{usd(lot.spread)}</div>
                    ) : null}
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
                  <td className="mono">{lot.fillScore != null ? pct(lot.fillScore) : "—"}</td>
                </tr>
              );
            })}
            {sorted.length === 0 ? (
              <tr>
                <td colSpan={10} className="empty">
                  {t("lots.noMatch")}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <LotDrawer lot={selected} open={!!selected} onClose={() => setSelectedId(null)} />
    </>
  );
}
