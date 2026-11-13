import type { ReactNode } from "react";
import Link from "next/link";
import { formatWhen } from "@/lib/labels";
import { usd, ymd } from "@/lib/format";

type LayerRow = {
  id: string;
  name: string;
  status: string;
  fetchedAt: Date | null;
  error: string | null;
  payload: unknown;
};

type PropertyRow = {
  folio: string | null;
  addressLine: string | null;
  city: string | null;
  zip: string | null;
  ownerName: string | null;
  beds: number | null;
  baths: number | null;
  livingSqft: number | null;
  lotSqft: number | null;
  yearBuilt: number | null;
  zoning: string | null;
  dorUse: string | null;
  assessedValue: unknown;
  marketValue: unknown;
  lastSaleDate: Date | null;
  lastSalePrice: unknown;
  legalDescription: string | null;
  lat: number | null;
  lng: number | null;
} | null;

type SaleDoc = {
  id: string;
  title: string | null;
  sourceUrl: string | null;
  evidenceNote: string | null;
  meta: unknown;
};

type Labels = {
  folio: string;
  address: string;
  cityZip: string;
  owner: string;
  mailing: string;
  bedsBaths: string;
  floorsUnits: string;
  livingSqft: string;
  actualAdjustedSqft: string;
  lotSqft: string;
  yearBuilt: string;
  zoningDor: string;
  municipality: string;
  status: string;
  assessedMarket: string;
  landBuildingValue: string;
  lastSale: string;
  coordinates: string;
  floodZone: string;
  occupancyProxy: string;
  legal: string;
  enrichmentLayers: string;
  viewPullDetails: string;
  open: string;
  paMissing: string;
  sectionIdentity: string;
  sectionAssessments: string;
  sectionBenefits: string;
  sectionTaxable: string;
  sectionSales: string;
  sectionLand: string;
  sectionBuilding: string;
  sectionExtras: string;
  sectionRisk: string;
  year: string;
  marketValue: string;
  assessedValue: string;
  landValue: string;
  buildingValue: string;
  extraFeatureValue: string;
  description: string;
  type: string;
  value: string;
  countyExempt: string;
  countyTaxable: string;
  schoolExempt: string;
  schoolTaxable: string;
  cityExempt: string;
  cityTaxable: string;
  regionalExempt: string;
  regionalTaxable: string;
  saleDate: string;
  salePrice: string;
  instrument: string;
  orBookPage: string;
  grantor: string;
  grantee: string;
  qualification: string;
  landUse: string;
  zone: string;
  units: string;
  calcValue: string;
  buildingNo: string;
  actualArea: string;
  heatedArea: string;
  adjustedArea: string;
  pctGood: string;
  rcn: string;
  depreciated: string;
  empty: string;
};

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function asArray(v: unknown): Record<string, unknown>[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x) => x && typeof x === "object") as Record<string, unknown>[];
}

function str(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).replace(/\u0000/g, "").trim();
  return s || null;
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim()) {
    const n = Number(v.replace(/[,$]/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function money(v: unknown): string {
  return usd(num(v));
}

function orKey(book: string | null, page: string | null): string | null {
  if (!book || !page) return null;
  return `${book.replace(/\D/g, "")}-${page.replace(/\D/g, "")}`;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="run-pull-section dossier-section">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

function Empty({ label }: { label: string }) {
  return <p className="pull-empty muted">{label}</p>;
}

export function LotPropertyDossier({
  lotId,
  folio,
  propertyAddress,
  property,
  layers,
  saleDocs,
  floodText,
  occupancyText,
  labels,
}: {
  lotId: string;
  folio: string;
  propertyAddress: string | null;
  property: PropertyRow;
  layers: LayerRow[];
  saleDocs: SaleDoc[];
  floodText: string;
  occupancyText: string;
  labels: Labels;
}) {
  const paLayer = layers.find((l) => l.name === "pa_parcel");
  const occLayer = layers.find((l) => l.name === "occupancy_proxy");
  const pa = asRecord(paLayer?.payload);
  const occ = asRecord(occLayer?.payload);

  const land = asRecord(pa?.land);
  const propertyInfo = asRecord(pa?.propertyInfo);
  const mailing = asRecord(pa?.mailingAddress);
  const site = asRecord(pa?.siteAddress);
  const legalRaw = pa?.legalDescription;
  const legalObj = asRecord(legalRaw);
  const legal =
    str(legalObj?.Description) ||
    str(legalRaw) ||
    property?.legalDescription ||
    null;

  const owners = asArray(pa?.ownerInfos)
    .map((o) => str(o.Name))
    .filter(Boolean) as string[];
  const assessments = asArray(pa?.assessmentInfos).sort(
    (a, b) => (num(b.Year) ?? 0) - (num(a.Year) ?? 0),
  );
  const benefits = asArray(pa?.benefitInfos);
  const taxable = asArray(pa?.taxableInfos).sort(
    (a, b) => (num(b.Year) ?? 0) - (num(a.Year) ?? 0),
  );
  const sales = asArray(pa?.salesInfos).sort((a, b) => {
    const da = str(a.DateOfSale) ?? "";
    const db = str(b.DateOfSale) ?? "";
    return db.localeCompare(da);
  });
  const landlines = asArray(pa?.landlines);
  const buildings = asArray(pa?.buildingInfos);
  const extras = asArray(pa?.extraFeatureInfos);

  const saleDocByOr = new Map<string, SaleDoc>();
  for (const d of saleDocs) {
    const meta = asRecord(d.meta);
    const book = str(meta?.orBook) ?? str(meta?.book);
    const page = str(meta?.orPage) ?? str(meta?.page);
    const key = orKey(book, page);
    if (key) saleDocByOr.set(key, d);
  }

  const siteAddress =
    str(site?.Address) ||
    str(land?.address) ||
    property?.addressLine ||
    propertyAddress ||
    "—";
  const mailingLine = mailing
    ? [str(mailing.Address1), str(mailing.Address2), str(mailing.City), str(mailing.State), str(mailing.ZipCode)]
        .filter(Boolean)
        .join(", ")
    : null;
  const ownerLine =
    owners.length > 0
      ? owners.join(" · ")
      : property?.ownerName || str(land?.owner) || "—";
  const beds = num(propertyInfo?.BedroomCount) ?? property?.beds ?? num(land?.beds);
  const baths = num(propertyInfo?.BathroomCount) ?? property?.baths ?? num(land?.baths);
  const halfBath = num(propertyInfo?.HalfBathroomCount) ?? 0;
  const bathsDisplay =
    baths != null ? (halfBath > 0 ? `${baths}/${halfBath}` : String(baths)) : "—";
  const floors = num(propertyInfo?.FloorCount);
  const units = num(propertyInfo?.UnitCount);
  const living =
    num(propertyInfo?.BuildingHeatedArea) ?? property?.livingSqft ?? num(land?.buildingHeatedArea);
  const actual = num(propertyInfo?.BuildingActualArea) ?? num(propertyInfo?.BuildingGrossArea);
  const adjusted = num(propertyInfo?.BuildingEffectiveArea);
  const lotSize = num(propertyInfo?.LotSize) ?? property?.lotSqft ?? num(land?.lotSize);
  const yearBuilt =
    str(propertyInfo?.YearBuilt) ||
    (property?.yearBuilt != null ? String(property.yearBuilt) : null) ||
    (num(land?.yearBuilt) != null ? String(land?.yearBuilt) : null);
  const zoning =
    str(propertyInfo?.PrimaryZone) || property?.zoning || str(land?.zoning) || "—";
  const zoningDesc =
    str(propertyInfo?.PrimaryZoneDescription) || str(occ?.zoneDescription);
  const dor =
    str(propertyInfo?.DORCode) || property?.dorUse || str(land?.dorCode) || "—";
  const dorDesc =
    str(propertyInfo?.DORDescription) ||
    str(propertyInfo?.DORDescriptionCurrent) ||
    str(occ?.dorDescription) ||
    str(land?.dorDesc);
  const municipality =
    str(propertyInfo?.Municipality) || str(occ?.municipality) || property?.city || str(land?.city);
  const subdivision =
    str(propertyInfo?.SubdivisionDescription) || str(occ?.subdivision) || str(land?.subdivision);
  const status = str(propertyInfo?.Status);
  const assessed =
    num(pa?.assessedValue) ?? num(property?.assessedValue) ?? null;
  const market = num(pa?.justValue) ?? num(property?.marketValue) ?? null;
  const landVal = num(occ?.landValue) ?? num(land?.landValue);
  const bldgVal = num(occ?.buildingValue) ?? num(land?.buildingValue);

  if (!pa) {
    return (
      <div className="dossier">
        <p className="sub" style={{ marginTop: 0 }}>
          {labels.paMissing}
        </p>
        <dl className="kv">
          <dt>{labels.folio}</dt>
          <dd className="mono">{folio}</dd>
          <dt>{labels.address}</dt>
          <dd>{siteAddress}</dd>
          <dt>{labels.owner}</dt>
          <dd>{ownerLine}</dd>
          <dt>{labels.assessedMarket}</dt>
          <dd>
            {money(property?.assessedValue)} / {money(property?.marketValue)}
          </dd>
          <dt>{labels.floodZone}</dt>
          <dd>{floodText}</dd>
          <dt>{labels.occupancyProxy}</dt>
          <dd>{occupancyText}</dd>
          <dt>{labels.legal}</dt>
          <dd>{property?.legalDescription ?? "—"}</dd>
          <dt>{labels.enrichmentLayers}</dt>
          <dd>
            {layers.length === 0 ? <span className="muted">—</span> : null}
            {layers.map((l) => (
              <div key={l.id} className="muted">
                {l.name}: {l.status}
                {l.fetchedAt ? ` · ${formatWhen(l.fetchedAt)}` : ""}
              </div>
            ))}
            <div style={{ marginTop: 8 }}>
              <Link href={`/lots/${lotId}?tab=pulls`}>{labels.viewPullDetails}</Link>
            </div>
          </dd>
        </dl>
      </div>
    );
  }

  return (
    <div className="dossier">
      {paLayer?.fetchedAt ? (
        <p className="muted" style={{ marginTop: 0, fontSize: 12 }}>
          PA {paLayer.status}
          {paLayer.fetchedAt ? ` · ${formatWhen(paLayer.fetchedAt)}` : ""}
        </p>
      ) : null}

      <Section title={labels.sectionIdentity}>
        <dl className="kv">
          <dt>{labels.folio}</dt>
          <dd className="mono">{str(propertyInfo?.FolioNumber) || folio}</dd>
          <dt>{labels.address}</dt>
          <dd>{siteAddress}</dd>
          <dt>{labels.mailing}</dt>
          <dd>{mailingLine || "—"}</dd>
          <dt>{labels.owner}</dt>
          <dd>{ownerLine}</dd>
          <dt>{labels.cityZip}</dt>
          <dd>
            {[property?.city || str(land?.city) || str(site?.City), property?.zip || str(land?.zip) || str(site?.Zip)]
              .filter(Boolean)
              .join(" ") || "—"}
          </dd>
          <dt>{labels.municipality}</dt>
          <dd>
            {municipality ?? "—"}
            {subdivision ? <div className="muted">{subdivision}</div> : null}
          </dd>
          <dt>{labels.zoningDor}</dt>
          <dd>
            {zoning} / {dor}
            {zoningDesc ? <div className="muted">{zoningDesc}</div> : null}
            {dorDesc ? <div className="muted">{dorDesc}</div> : null}
          </dd>
          <dt>{labels.bedsBaths}</dt>
          <dd>
            {beds ?? "—"} / {bathsDisplay}
          </dd>
          <dt>{labels.floorsUnits}</dt>
          <dd>
            {floors ?? "—"} / {units ?? "—"}
          </dd>
          <dt>{labels.livingSqft}</dt>
          <dd>{living ?? "—"}</dd>
          <dt>{labels.actualAdjustedSqft}</dt>
          <dd>
            {actual ?? "—"} / {adjusted ?? "—"}
          </dd>
          <dt>{labels.lotSqft}</dt>
          <dd>{lotSize ?? "—"}</dd>
          <dt>{labels.yearBuilt}</dt>
          <dd>{yearBuilt ?? "—"}</dd>
          <dt>{labels.status}</dt>
          <dd>{status ?? "—"}</dd>
          <dt>{labels.assessedMarket}</dt>
          <dd>
            {money(assessed)} / {money(market)}
          </dd>
          <dt>{labels.landBuildingValue}</dt>
          <dd>
            {landVal != null || bldgVal != null
              ? `${money(landVal)} / ${money(bldgVal)}`
              : "—"}
          </dd>
          <dt>{labels.lastSale}</dt>
          <dd>
            {property?.lastSaleDate
              ? `${ymd(property.lastSaleDate)} · ${money(property.lastSalePrice)}`
              : "—"}
          </dd>
          <dt>{labels.coordinates}</dt>
          <dd className="mono">
            {property?.lat != null && property?.lng != null
              ? `${property.lat.toFixed(5)}, ${property.lng.toFixed(5)}`
              : land?.lat != null && land?.lng != null
                ? `${Number(land.lat).toFixed(5)}, ${Number(land.lng).toFixed(5)}`
                : "—"}
          </dd>
        </dl>
      </Section>

      <Section title={labels.sectionAssessments}>
        {assessments.length === 0 ? (
          <Empty label={labels.empty} />
        ) : (
          <div className="table-wrap">
            <table className="pull-table compact">
              <thead>
                <tr>
                  <th>{labels.year}</th>
                  <th>{labels.marketValue}</th>
                  <th>{labels.assessedValue}</th>
                  <th>{labels.landValue}</th>
                  <th>{labels.buildingValue}</th>
                  <th>{labels.extraFeatureValue}</th>
                </tr>
              </thead>
              <tbody>
                {assessments.map((row, i) => (
                  <tr key={`${str(row.Year)}-${i}`}>
                    <td className="mono">{str(row.Year) ?? "—"}</td>
                    <td className="mono">{money(row.TotalValue)}</td>
                    <td className="mono">{money(row.AssessedValue)}</td>
                    <td className="mono">{money(row.LandValue)}</td>
                    <td className="mono">{money(row.BuildingOnlyValue)}</td>
                    <td className="mono">{money(row.ExtraFeatureValue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section title={labels.sectionBenefits}>
        {benefits.length === 0 ? (
          <Empty label={labels.empty} />
        ) : (
          <div className="table-wrap">
            <table className="pull-table compact">
              <thead>
                <tr>
                  <th>{labels.year}</th>
                  <th>{labels.type}</th>
                  <th>{labels.description}</th>
                  <th>{labels.value}</th>
                </tr>
              </thead>
              <tbody>
                {benefits.map((row, i) => (
                  <tr key={`${str(row.TaxYear)}-${str(row.Type)}-${i}`}>
                    <td className="mono">{str(row.TaxYear) ?? "—"}</td>
                    <td>{str(row.Type) ?? "—"}</td>
                    <td>
                      {str(row.Url) ? (
                        <a href={String(row.Url)} target="_blank" rel="noreferrer">
                          {str(row.Description) ?? labels.open}
                        </a>
                      ) : (
                        str(row.Description) ?? "—"
                      )}
                    </td>
                    <td className="mono">{money(row.Value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section title={labels.sectionTaxable}>
        {taxable.length === 0 ? (
          <Empty label={labels.empty} />
        ) : (
          <div className="table-wrap">
            <table className="pull-table compact">
              <thead>
                <tr>
                  <th>{labels.year}</th>
                  <th>{labels.countyExempt}</th>
                  <th>{labels.countyTaxable}</th>
                  <th>{labels.schoolExempt}</th>
                  <th>{labels.schoolTaxable}</th>
                  <th>{labels.cityExempt}</th>
                  <th>{labels.cityTaxable}</th>
                  <th>{labels.regionalExempt}</th>
                  <th>{labels.regionalTaxable}</th>
                </tr>
              </thead>
              <tbody>
                {taxable.map((row, i) => (
                  <tr key={`${str(row.Year)}-${i}`}>
                    <td className="mono">{str(row.Year) ?? "—"}</td>
                    <td className="mono">{money(row.CountyExemptionValue)}</td>
                    <td className="mono">{money(row.CountyTaxableValue)}</td>
                    <td className="mono">{money(row.SchoolExemptionValue)}</td>
                    <td className="mono">{money(row.SchoolTaxableValue)}</td>
                    <td className="mono">{money(row.CityExemptionValue)}</td>
                    <td className="mono">{money(row.CityTaxableValue)}</td>
                    <td className="mono">{money(row.RegionalExemptionValue)}</td>
                    <td className="mono">{money(row.RegionalTaxableValue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section title={labels.sectionSales}>
        {sales.length === 0 ? (
          <Empty label={labels.empty} />
        ) : (
          <div className="table-wrap">
            <table className="pull-table compact">
              <thead>
                <tr>
                  <th>{labels.saleDate}</th>
                  <th>{labels.salePrice}</th>
                  <th>{labels.instrument}</th>
                  <th>{labels.orBookPage}</th>
                  <th>{labels.grantor}</th>
                  <th>{labels.grantee}</th>
                  <th>{labels.qualification}</th>
                </tr>
              </thead>
              <tbody>
                {sales.map((row, i) => {
                  const book = str(row.OfficialRecordBook);
                  const page = str(row.OfficialRecordPage);
                  const key = orKey(book, page);
                  const doc = key ? saleDocByOr.get(key) : undefined;
                  const orLabel =
                    book && page && book !== "00000" ? `OR ${book}/${page}` : "—";
                  return (
                    <tr key={`${str(row.SaleId) ?? i}-${str(row.DateOfSale)}`}>
                      <td className="mono nowrap">{str(row.DateOfSale) ?? "—"}</td>
                      <td className="mono">{money(row.SalePrice)}</td>
                      <td>{str(row.SaleInstrument) ?? "—"}</td>
                      <td className="mono">
                        {doc?.sourceUrl ? (
                          <a href={doc.sourceUrl} target="_blank" rel="noreferrer">
                            {orLabel}
                          </a>
                        ) : (
                          orLabel
                        )}
                      </td>
                      <td>
                        {[str(row.GrantorName1), str(row.GrantorName2)].filter(Boolean).join(" · ") ||
                          "—"}
                      </td>
                      <td>
                        {[str(row.GranteeName1), str(row.GranteeName2)].filter(Boolean).join(" · ") ||
                          "—"}
                      </td>
                      <td>
                        {str(row.QualificationDescription) || str(row.QualifiedFlag) || "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section title={labels.sectionLand}>
        {landlines.length === 0 ? (
          <Empty label={labels.empty} />
        ) : (
          <div className="table-wrap">
            <table className="pull-table compact">
              <thead>
                <tr>
                  <th>{labels.year}</th>
                  <th>{labels.landUse}</th>
                  <th>{labels.zone}</th>
                  <th>{labels.units}</th>
                  <th>{labels.calcValue}</th>
                </tr>
              </thead>
              <tbody>
                {landlines.map((row, i) => (
                  <tr key={`${str(row.RollYear)}-${i}`}>
                    <td className="mono">{str(row.RollYear) ?? "—"}</td>
                    <td>
                      {str(row.LandUse) || str(row.UseCode) || "—"}
                      {str(row.UnitType) ? (
                        <div className="pull-cell-sub">{str(row.UnitType)}</div>
                      ) : null}
                    </td>
                    <td>
                      {str(row.MuniZone) || str(row.PAZoneDescription) || "—"}
                      {str(row.MuniZoneDescription) ? (
                        <div className="pull-cell-sub">{str(row.MuniZoneDescription)}</div>
                      ) : null}
                    </td>
                    <td className="mono">{str(row.Units) ?? "—"}</td>
                    <td className="mono">{money(row.CalculatedValue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section title={labels.sectionBuilding}>
        {buildings.length === 0 ? (
          <Empty label={labels.empty} />
        ) : (
          <div className="table-wrap">
            <table className="pull-table compact">
              <thead>
                <tr>
                  <th>{labels.year}</th>
                  <th>{labels.buildingNo}</th>
                  <th>{labels.description}</th>
                  <th>{labels.actualArea}</th>
                  <th>{labels.heatedArea}</th>
                  <th>{labels.adjustedArea}</th>
                  <th>{labels.pctGood}</th>
                  <th>{labels.rcn}</th>
                  <th>{labels.depreciated}</th>
                </tr>
              </thead>
              <tbody>
                {buildings.map((row, i) => (
                  <tr key={`${str(row.RollYear)}-${str(row.BuildingNo)}-${str(row.SegNo)}-${i}`}>
                    <td className="mono">
                      {str(row.Actual) || str(row.Effective) || str(row.RollYear) || "—"}
                    </td>
                    <td className="mono">{str(row.BuildingNo) ?? "—"}</td>
                    <td>{str(row.improvementModelDesc) ?? "—"}</td>
                    <td className="mono">{str(row.ActualArea) ?? str(row.GrossArea) ?? "—"}</td>
                    <td className="mono">{str(row.HeatedArea) ?? "—"}</td>
                    <td className="mono">{str(row.EffectiveArea) ?? "—"}</td>
                    <td className="mono">
                      {num(row.PercentageGood) != null ? `${num(row.PercentageGood)}%` : "—"}
                    </td>
                    <td className="mono">{money(row.ReplacementCostNew)}</td>
                    <td className="mono">{money(row.DepreciatedValue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section title={labels.sectionExtras}>
        {extras.length === 0 ? (
          <Empty label={labels.empty} />
        ) : (
          <div className="table-wrap">
            <table className="pull-table compact">
              <thead>
                <tr>
                  <th>{labels.year}</th>
                  <th>{labels.description}</th>
                  <th>{labels.units}</th>
                  <th>{labels.value}</th>
                </tr>
              </thead>
              <tbody>
                {extras.map((row, i) => (
                  <tr key={`${str(row.RollYear)}-${str(row.Description)}-${i}`}>
                    <td className="mono">
                      {str(row.ActualYearBuilt) || str(row.RollYear) || "—"}
                    </td>
                    <td>{str(row.Description) ?? "—"}</td>
                    <td className="mono">{str(row.Units) ?? "—"}</td>
                    <td className="mono">{money(row.DepreciatedValue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section title={labels.sectionRisk}>
        <dl className="kv">
          <dt>{labels.floodZone}</dt>
          <dd>{floodText}</dd>
          <dt>{labels.occupancyProxy}</dt>
          <dd>{occupancyText}</dd>
          <dt>{labels.legal}</dt>
          <dd style={{ whiteSpace: "pre-wrap" }}>{legal?.replace(/\|/g, "\n") ?? "—"}</dd>
          <dt>{labels.enrichmentLayers}</dt>
          <dd>
            {layers.map((l) => (
              <div key={l.id} className="muted">
                {l.name}: {l.status}
                {l.fetchedAt ? ` · ${formatWhen(l.fetchedAt)}` : ""}
              </div>
            ))}
            <div style={{ marginTop: 8 }}>
              <Link href={`/lots/${lotId}?tab=pulls`}>{labels.viewPullDetails}</Link>
            </div>
          </dd>
        </dl>
      </Section>
    </div>
  );
}
