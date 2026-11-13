import { prisma } from "@lienradar/db";
import { getServerSession } from "next-auth";
import Link from "next/link";
import { notFound } from "next/navigation";
import { GatePill } from "@/components/GatePill";
import { Shell } from "@/components/Shell";
import { StatusPill } from "@/components/StatusPill";
import { DealForm } from "@/components/DealForm";
import { ManualDdForm } from "@/components/ManualDdForm";
import { PropertyMap } from "@/components/PropertyMap";
import { LotPropertyDossier } from "@/components/LotPropertyDossier";
import { PullDetails } from "@/components/PullDetails";
import { authOptions } from "@/lib/auth";
import { dealValue, discountPct, num, spreadUsd } from "@/lib/dealMetrics";
import { countyLabel } from "@/lib/countyLabel";
import { pct, usd, ymd } from "@/lib/format";
import { formatWhen } from "@/lib/labels";
import { getI18n } from "@/lib/i18n";
import { applyMethodToLot, getUserMethodSettings } from "@/lib/methodSettings";

export const dynamic = "force-dynamic";

export default async function LotDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string } | undefined)?.id;
  const methodSettings = await getUserMethodSettings(userId);
  const { t } = await getI18n();
  const { id } = await params;
  const sp = await searchParams;
  const tab = typeof sp.tab === "string" ? sp.tab : "gate";

  const lot = await prisma.lot.findUnique({
    where: { id },
    include: {
      property: true,
      auctionEvent: true,
      documents: true,
      debts: { orderBy: { category: "asc" } },
      mortgages: true,
      risks: { orderBy: { code: "asc" } },
      events: { orderBy: { createdAt: "desc" }, take: 50 },
      observations: { orderBy: { fetchedAt: "desc" }, take: 50 },
      layers: {
        select: { id: true, name: true, status: true, fetchedAt: true, error: true, payload: true },
        orderBy: { fetchedAt: "desc" },
      },
      deals: session?.user ? { where: { userId: (session.user as { id?: string }).id } } : false,
    },
  });
  if (!lot) notFound();

  const floodLayer = lot.layers.find((l) => l.name === "flood");
  const floodPayload =
    floodLayer?.payload && typeof floodLayer.payload === "object"
      ? (floodLayer.payload as { zone?: string | null; subtype?: string | null; sfha?: boolean | null; source?: string | null })
      : null;
  const floodRisk = lot.risks.find((r) => r.code === "flood");
  const occupancyRisk = lot.risks.find((r) => r.code === "occupancy");
  const occupancyLayer = lot.layers.find((l) => l.name === "occupancy_proxy");
  const occupancyPayload =
    occupancyLayer?.payload && typeof occupancyLayer.payload === "object"
      ? (occupancyLayer.payload as {
          guess?: string | null;
          evidence?: string | null;
          dorDescription?: string | null;
          zoneDescription?: string | null;
          municipality?: string | null;
          subdivision?: string | null;
          landValue?: number | null;
          buildingValue?: number | null;
          building?: {
            improvementModelDesc?: string | null;
            percentageGood?: number | null;
            replacementCostNew?: number | null;
            depreciatedValue?: number | null;
            heatedArea?: number | null;
            rollYear?: number | null;
          } | null;
          salesWithOr?: Array<{
            dateOfSale?: string | null;
            salePrice?: number | null;
            instrument?: string | null;
            orBook?: string | null;
            orPage?: string | null;
            grantor?: string | null;
            grantee?: string | null;
            qualifiedFlag?: string | null;
            qualificationDescription?: string | null;
          }>;
        })
      : null;
  const paSaleDocs = lot.documents.filter((d) => d.docType === "pa_sale_or");

  const method = applyMethodToLot(lot, methodSettings);
  const barriers = method.barriers;
  const needsDd = method.needsDd;
  const decisionLabel = method.bidAllowed
    ? t("lotDetail.decisionReady")
    : needsDd
      ? t("lotDetail.decisionReview")
      : t("lotDetail.decisionBlocked");
  const decisionColor = method.bidAllowed
    ? "var(--ok)"
    : needsDd
      ? "var(--warn)"
      : "var(--bad)";

  const tabs = [
    ["gate", t("lotDetail.tabs.gate")],
    ["auction", t("lotDetail.tabs.auction")],
    ["property", t("lotDetail.tabs.property")],
    ["pulls", t("lotDetail.tabs.pulls")],
    ["money", t("lotDetail.tabs.money")],
    ["debts", t("lotDetail.tabs.debts")],
    ["mortgage", t("lotDetail.tabs.mortgage")],
    ["docs", t("lotDetail.tabs.docs")],
    ["risks", t("lotDetail.tabs.risks")],
    ["ceiling", t("lotDetail.tabs.ceiling")],
    ["deal", t("lotDetail.tabs.deal")],
    ["dd", t("lotDetail.tabs.dd")],
  ] as const;

  const deal = Array.isArray(lot.deals) ? lot.deals[0] : null;
  const address = lot.propertyAddress ?? lot.property?.addressLine ?? lot.caseNumber;
  const opening = num(lot.openingBid);
  const value = dealValue(lot);
  const discount = discountPct(opening, value);
  const spread = spreadUsd(opening, value);

  return (
    <Shell active="lots" email={session?.user?.email}>
      <p className="muted" style={{ marginTop: 0 }}><Link href="/lots">{t("common.backToLots")}</Link></p>
      <h1>{address}</h1>
      <div className="meta-line">
        <StatusPill status={lot.status} label={t(`statuses.${lot.status}`)} />
        <span className="pill info">{t(`channels.${lot.channel}`)}</span>
        <span className="pill neutral">{countyLabel(t, lot.county)}</span>
        <span className="muted mono">{lot.caseNumber}</span>
        <span className="muted">{t("common.folio")} {lot.folio}</span>
        <span className="muted">{t("common.sale")}: {ymd(lot.saleDate)}</span>
      </div>
      <p className="sub">{t("lotDetail.summaryHint")}</p>

      <div className="lot-hero-grid">
        <PropertyMap
          address={address}
          lat={lot.property?.lat}
          lng={lot.property?.lng}
          title={address}
          className="lot-hero-map"
        />
        <div className="cards" style={{ marginBottom: 0 }}>
          <div className="card">
            <div className="label">{t("lotDetail.bidAllowed")}</div>
            <div className="value" style={{ color: decisionColor, fontSize: 22 }}>{decisionLabel}</div>
            <div className="hint" style={{ marginTop: 8 }}>
              <GatePill
                hasGate
                bidAllowed={method.bidAllowed}
                needsDd={needsDd}
                allowedLabel={t("common.allowed")}
                blockedLabel={t("common.blocked")}
                pendingLabel={t("common.pending")}
                needsDdLabel={t("common.needsDd")}
              />
            </div>
          </div>
          <div className="card">
            <div className="label">{t("lots.colOpening")}</div>
            <div className="value" style={{ fontSize: 22 }}>{usd(opening)}</div>
            <div className="hint">{t("lots.colValue")}: {usd(value)}</div>
          </div>
          <div className="card">
            <div className="label">{t("lots.colDiscount")}</div>
            <div className="value" style={{ fontSize: 22, color: discount != null && discount >= method.hotDiscountPct ? "var(--ok)" : undefined }}>
              {discount != null ? pct(discount) : "—"}
            </div>
            <div className="hint">{spread != null ? `~${usd(spread)}` : t("lots.discountHint")}</div>
          </div>
          <div className="card">
            <div className="label">{t("lotDetail.fillScore")}</div>
            <div className="value">{pct(method.fillScore)}</div>
          </div>
          <div className="card">
            <div className="label">{t("lotDetail.riskClosed")}</div>
            <div className="value">{method.riskClosed ? t("common.yes") : t("common.no")}</div>
          </div>
          <div className="card">
            <div className="label">{t("lotDetail.ceiling")}</div>
            <div className="value" style={{ fontSize: 22 }}>{usd(method.ceiling)}</div>
          </div>
        </div>
      </div>

      <div className="tabs">
        {tabs.map(([key, label]) => (
          <Link key={key} href={`/lots/${lot.id}?tab=${key}`} className={tab === key ? "active" : undefined}>
            {label}
          </Link>
        ))}
      </div>

      <div className="panel panel-pad">
        {tab === "gate" ? (
          <div>
            <h2>{t("lotDetail.bidBarriers")}</h2>
            <p className="sub">{t("lotDetail.bidBarriersHint")}</p>
            {barriers.length === 0 ? <p className="muted">{t("lotDetail.noBarriers")}</p> : null}
            {barriers.map((b) => (
              <div key={b.code} className={`barrier ${b.severity === "warn" ? "warn" : ""}`}>
                <div className="code">{b.code.replaceAll("_", " ")}</div>
                <div>{b.message}</div>
              </div>
            ))}
            <p className="muted" style={{ fontSize: 12, marginTop: 16 }}>
              {t("lotDetail.method")}: {method.methodVersion} · {t("settings.title")}
            </p>
          </div>
        ) : null}

        {tab === "auction" ? (
          <dl className="kv">
            <dt>{t("common.channel")}</dt><dd>{t(`channels.${lot.channel}`)}</dd>
            <dt>{t("lotDetail.source")}</dt><dd>{lot.auctionEvent?.source ?? "—"}</dd>
            <dt>{t("lotDetail.saleDate")}</dt><dd>{ymd(lot.saleDate)}</dd>
            <dt>{t("common.status")}</dt>
            <dd><StatusPill status={lot.status} label={t(`statuses.${lot.status}`)} /></dd>
            {lot.certificateNumber ? (
              <>
                <dt>{t("lotDetail.certificate")}</dt><dd className="mono">{lot.certificateNumber}</dd>
              </>
            ) : null}
            {lot.taxDeedNumber ? (
              <>
                <dt>{t("lotDetail.taxDeed")}</dt><dd className="mono">{lot.taxDeedNumber}</dd>
              </>
            ) : null}
            {lot.documents.filter((d) => d.docType.startsWith("auction_")).length ? (
              <>
                <dt>{t("lotDetail.auctionLinks")}</dt>
                <dd>
                  {lot.documents
                    .filter((d) => d.docType.startsWith("auction_"))
                    .map((d) => (
                      <div key={d.id} style={{ marginBottom: 6 }}>
                        <span className="muted">{d.docType.replace(/^auction_/, "").replaceAll("_", " ")}: </span>
                        {d.sourceUrl ? (
                          <a href={d.sourceUrl} target="_blank" rel="noreferrer">
                            {d.title || t("lotDetail.open")}
                          </a>
                        ) : (
                          d.title || "—"
                        )}
                      </div>
                    ))}
                </dd>
              </>
            ) : null}
            {lot.outcomeText ? (
              <>
                <dt>{t("lotDetail.outcome")}</dt>
                <dd>{lot.outcomeText}{lot.outcomeCategory ? ` · ${lot.outcomeCategory}` : ""}</dd>
              </>
            ) : null}
            <dt>{t("lotDetail.plaintiff")}</dt><dd>{lot.plaintiff ?? "—"}</dd>
            <dt>{t("lotDetail.sourceUrl")}</dt>
            <dd>{lot.sourceUrl ? <a href={lot.sourceUrl} target="_blank" rel="noreferrer">{t("lotDetail.open")}</a> : "—"}</dd>
            <dt>{t("lotDetail.purchaseConfirmed")}</dt>
            <dd>{lot.purchaseConfirmed ? t("common.yesShort") : t("lotDetail.purchaseConfirmedNo")}</dd>
            <dt>{t("lotDetail.timeline")}</dt>
            <dd>
              {lot.events.length === 0 ? <span className="muted">—</span> : null}
              {lot.events.map((e) => (
                <div key={e.id} className="muted" style={{ marginBottom: 6 }}>
                  <span>{formatWhen(e.createdAt)}</span> · {e.kind}: {e.message}
                </div>
              ))}
            </dd>
          </dl>
        ) : null}

        {tab === "property" ? (
          <LotPropertyDossier
            lotId={lot.id}
            folio={lot.folio}
            propertyAddress={lot.propertyAddress}
            property={lot.property}
            layers={lot.layers}
            saleDocs={paSaleDocs}
            floodText={
              floodPayload?.zone
                ? `${floodPayload.zone}${floodPayload.subtype ? ` · ${floodPayload.subtype}` : ""}${
                    floodPayload.sfha != null ? ` · SFHA ${floodPayload.sfha ? "yes" : "no"}` : ""
                  }${floodPayload.source ? ` · ${floodPayload.source}` : ""}`
                : floodRisk?.evidence ?? "—"
            }
            occupancyText={
              occupancyPayload?.guess
                ? `${occupancyPayload.guess.replaceAll("_", " ")}${
                    occupancyPayload.evidence ? ` — ${occupancyPayload.evidence}` : ""
                  }`
                : occupancyRisk?.evidence ?? "—"
            }
            labels={{
              folio: t("common.folio"),
              address: t("common.address"),
              cityZip: t("lotDetail.cityZip"),
              owner: t("lotDetail.owner"),
              mailing: t("lotDetail.mailing"),
              bedsBaths: t("lotDetail.bedsBaths"),
              floorsUnits: t("lotDetail.floorsUnits"),
              livingSqft: t("lotDetail.livingSqft"),
              actualAdjustedSqft: t("lotDetail.actualAdjustedSqft"),
              lotSqft: t("lotDetail.lotSqft"),
              yearBuilt: t("lotDetail.yearBuilt"),
              zoningDor: t("lotDetail.zoningDor"),
              municipality: t("lotDetail.municipality"),
              status: t("common.status"),
              assessedMarket: t("lotDetail.assessedMarket"),
              landBuildingValue: t("lotDetail.landBuildingValue"),
              lastSale: t("lotDetail.lastSale"),
              coordinates: t("lotDetail.coordinates"),
              floodZone: t("lotDetail.floodZone"),
              occupancyProxy: t("lotDetail.occupancyProxy"),
              legal: t("lotDetail.legal"),
              enrichmentLayers: t("lotDetail.enrichmentLayers"),
              viewPullDetails: t("lotDetail.viewPullDetails"),
              open: t("lotDetail.open"),
              paMissing: t("lotDetail.paMissing"),
              sectionIdentity: t("lotDetail.sectionIdentity"),
              sectionAssessments: t("lotDetail.sectionAssessments"),
              sectionBenefits: t("lotDetail.sectionBenefits"),
              sectionTaxable: t("lotDetail.sectionTaxable"),
              sectionSales: t("lotDetail.sectionSales"),
              sectionLand: t("lotDetail.sectionLand"),
              sectionBuilding: t("lotDetail.sectionBuilding"),
              sectionExtras: t("lotDetail.sectionExtras"),
              sectionRisk: t("lotDetail.sectionRisk"),
              year: t("lotDetail.year"),
              marketValue: t("lotDetail.marketValue"),
              assessedValue: t("lotDetail.assessedValue"),
              landValue: t("lotDetail.landValue"),
              buildingValue: t("lotDetail.buildingValue"),
              extraFeatureValue: t("lotDetail.extraFeatureValue"),
              description: t("lotDetail.description"),
              type: t("lotDetail.type"),
              value: t("lotDetail.value"),
              countyExempt: t("lotDetail.countyExempt"),
              countyTaxable: t("lotDetail.countyTaxable"),
              schoolExempt: t("lotDetail.schoolExempt"),
              schoolTaxable: t("lotDetail.schoolTaxable"),
              cityExempt: t("lotDetail.cityExempt"),
              cityTaxable: t("lotDetail.cityTaxable"),
              regionalExempt: t("lotDetail.regionalExempt"),
              regionalTaxable: t("lotDetail.regionalTaxable"),
              saleDate: t("lotDetail.saleDate"),
              salePrice: t("lotDetail.salePrice"),
              instrument: t("lotDetail.instrument"),
              orBookPage: t("lotDetail.orBookPage"),
              grantor: t("lotDetail.grantor"),
              grantee: t("lotDetail.grantee"),
              qualification: t("lotDetail.qualification"),
              landUse: t("lotDetail.landUse"),
              zone: t("lotDetail.zone"),
              units: t("lotDetail.units"),
              calcValue: t("lotDetail.calcValue"),
              buildingNo: t("lotDetail.buildingNo"),
              actualArea: t("lotDetail.actualArea"),
              heatedArea: t("lotDetail.heatedArea"),
              adjustedArea: t("lotDetail.adjustedArea"),
              pctGood: t("lotDetail.pctGood"),
              rcn: t("lotDetail.rcn"),
              depreciated: t("lotDetail.depreciated"),
              empty: t("lotDetail.empty"),
            }}
          />
        ) : null}

        {tab === "pulls" ? (
          <PullDetails
            observations={lot.observations}
            layers={lot.layers}
            events={lot.events}
            labels={{
              hint: t("lotDetail.pullsHint"),
              observations: t("lotDetail.pullObservations"),
              layers: t("lotDetail.pullLayers"),
              events: t("lotDetail.pullEvents"),
              empty: t("lotDetail.pullsEmpty"),
              source: t("lotDetail.source"),
              externalId: t("lotDetail.pullExternalId"),
              fetched: t("lotDetail.pullFetched"),
              hash: t("lotDetail.pullHash"),
              payload: t("lotDetail.pullPayload"),
              status: t("common.status"),
              error: t("lotDetail.pullError"),
              kind: t("lotDetail.pullKind"),
              message: t("lotDetail.pullMessage"),
            }}
          />
        ) : null}

        {tab === "money" ? (
          <dl className="kv">
            <dt>{t("moneyLabels.openingBid")}</dt><dd className="mono">{usd(lot.openingBid)}</dd>
            <dt>{t("moneyLabels.judgmentAmount")}</dt><dd className="mono">{usd(lot.judgmentAmount)}</dd>
            <dt>{t("moneyLabels.plaintiffMaxBid")}</dt><dd className="mono">{usd(lot.plaintiffMaxBid)}</dd>
            <dt>{t("moneyLabels.highBid")}</dt><dd className="mono">{usd(lot.highBid)}</dd>
            <dt>{t("moneyLabels.winningBid")}</dt><dd className="mono">{usd(lot.winningBid)}</dd>
            <dt>{t("moneyLabels.confirmedSalePrice")}</dt><dd className="mono">{usd(lot.confirmedSalePrice)}</dd>
            <dt>{t("lotDetail.assessedLot")}</dt><dd className="mono">{usd(lot.assessedValue)}</dd>
          </dl>
        ) : null}

        {tab === "debts" ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t("lotDetail.category")}</th>
                  <th>{t("lotDetail.holder")}</th>
                  <th>{t("lotDetail.amount")}</th>
                  <th>{t("lotDetail.amountKind")}</th>
                  <th>{t("lotDetail.scoped")}</th>
                  <th>{t("lotDetail.evidence")}</th>
                </tr>
              </thead>
              <tbody>
                {lot.debts.map((d) => (
                  <tr key={d.id}>
                    <td>{d.category.replaceAll("_", " ")}</td>
                    <td>{d.holder ?? "—"}</td>
                    <td className="mono">{usd(d.amount)}{d.futureDues != null ? ` · future ${usd(d.futureDues)}` : ""}</td>
                    <td>
                      <span className={`pill ${d.amountKind === "UNKNOWN" ? "bad" : d.amountKind === "EXACT_FROM_DOC" ? "ok" : "warn"}`}>
                        {d.amountKind === "EXACT_FROM_DOC"
                          ? t("dd.amountExact")
                          : d.amountKind === "ESTIMATED_SCENARIO"
                            ? t("dd.amountEstimated")
                            : t("dd.amountUnknown")}
                      </span>
                    </td>
                    <td>{d.searchScoped ? t("common.yesShort") : t("common.noShort")}</td>
                    <td className="muted">{d.evidenceNote ?? "—"}</td>
                  </tr>
                ))}
                {lot.debts.length === 0 ? <tr><td colSpan={6} className="empty">—</td></tr> : null}
              </tbody>
            </table>
          </div>
        ) : null}

        {tab === "mortgage" ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t("lotDetail.rank")}</th>
                  <th>{t("lotDetail.lender")}</th>
                  <th>{t("lotDetail.balance")}</th>
                  <th>{t("lotDetail.satisfied")}</th>
                  <th>{t("lotDetail.evidence")}</th>
                </tr>
              </thead>
              <tbody>
                {lot.mortgages.map((m) => (
                  <tr key={m.id}>
                    <td>
                      <span className={`pill ${m.rankLevel === "L2_PROVEN" ? "ok" : "warn"}`}>
                        {m.rankLevel === "L2_PROVEN" ? t("dd.amountExact") : t("dd.amountEstimated")}
                      </span>
                    </td>
                    <td>{m.lender ?? "—"}</td>
                    <td className="mono">{usd(m.estimatedBalance)}</td>
                    <td>{m.satisfied == null ? t("lotDetail.unknown") : m.satisfied ? t("common.yesShort") : t("common.noShort")}</td>
                    <td className="muted">{m.evidenceNote ?? "—"}</td>
                  </tr>
                ))}
                {lot.mortgages.length === 0 ? <tr><td colSpan={5} className="empty">—</td></tr> : null}
              </tbody>
            </table>
          </div>
        ) : null}

        {tab === "docs" ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t("lotDetail.type")}</th>
                  <th>{t("lotDetail.title")}</th>
                  <th>{t("lotDetail.scope")}</th>
                  <th>{t("lotDetail.link")}</th>
                </tr>
              </thead>
              <tbody>
                {lot.documents.map((d) => (
                  <tr key={d.id}>
                    <td>{d.docType}</td>
                    <td>{d.title ?? "—"}</td>
                    <td className="muted">{d.searchScope ?? "—"}</td>
                    <td>{d.sourceUrl ? <a href={d.sourceUrl} target="_blank" rel="noreferrer">{t("lotDetail.open")}</a> : "—"}</td>
                  </tr>
                ))}
                {lot.documents.length === 0 ? <tr><td colSpan={4} className="empty">—</td></tr> : null}
              </tbody>
            </table>
          </div>
        ) : null}

        {tab === "risks" ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t("lotDetail.code")}</th>
                  <th>{t("lotDetail.result")}</th>
                  <th>{t("lotDetail.blocksBid")}</th>
                  <th>{t("lotDetail.evidence")}</th>
                </tr>
              </thead>
              <tbody>
                {lot.risks.map((r) => (
                  <tr key={r.id}>
                    <td>{r.code.replaceAll("_", " ")}</td>
                    <td>
                      <span className={`pill ${r.result === "PASS" ? "ok" : r.result === "FAIL" ? "bad" : "warn"}`}>
                        {r.result === "PASS"
                          ? t("dd.riskPass")
                          : r.result === "FAIL"
                            ? t("dd.riskFail")
                            : r.result === "NOT_APPLICABLE"
                              ? t("dd.riskNa")
                              : t("dd.riskUnknown")}
                      </span>
                    </td>
                    <td>{r.blocksBid ? t("common.yesShort") : t("common.noShort")}</td>
                    <td className="muted">{r.evidence ?? "—"}</td>
                  </tr>
                ))}
                {lot.risks.length === 0 ? <tr><td colSpan={4} className="empty">—</td></tr> : null}
              </tbody>
            </table>
          </div>
        ) : null}

        {tab === "ceiling" ? (
          <dl className="kv">
            <dt>{t("lotDetail.ceiling")}</dt><dd className="mono">{usd(method.ceiling)}</dd>
            <dt>{t("lotDetail.paramsVersion")}</dt><dd>{method.ceilingParamsVersion}</dd>
            <dt>{t("lotDetail.assumptions")}</dt>
            <dd>
              <pre style={{ whiteSpace: "pre-wrap", margin: 0, fontSize: 12, background: "var(--head)", padding: 12, borderRadius: 8 }}>
                {JSON.stringify(method.ceilingAssumptions, null, 2)}
              </pre>
            </dd>
          </dl>
        ) : null}

        {tab === "deal" ? (
          <DealForm lotId={lot.id} initial={deal ? { status: deal.status, maxBid: deal.maxBid ? Number(deal.maxBid) : null, notes: deal.notes, thesis: deal.thesis } : null} />
        ) : null}

        {tab === "dd" ? <ManualDdForm lotId={lot.id} /> : null}
      </div>
    </Shell>
  );
}
