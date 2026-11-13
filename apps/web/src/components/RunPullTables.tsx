"use client";

import Link from "next/link";
import { useI18n } from "@/components/I18nProvider";
import { formatWhen } from "@/lib/labels";

export type RunPullPayload = {
  run: {
    id: string;
    stage: string;
    status: string;
    startedAt: string;
    finishedAt: string | null;
    counts?: unknown;
    errorSummary?: string | null;
    notes?: string | null;
  };
  window: { from: string; to: string };
  observations: Array<{
    id: string;
    source: string;
    externalId: string | null;
    fetchedAt: string;
    lotId: string | null;
    caseNumber: string | null;
    folio: string | null;
    county: string | null;
    channel: string | null;
    address: string | null;
    saleDate: string | null;
    summary: string;
    payload: unknown;
  }>;
  layers: Array<{
    id: string;
    name: string;
    status: string;
    fetchedAt: string;
    error: string | null;
    lotId: string | null;
    caseNumber: string | null;
    folio: string | null;
    county: string | null;
    channel: string | null;
    address: string | null;
    summary: string;
    payload: unknown;
  }>;
  documents: Array<{
    id: string;
    docType: string;
    title: string | null;
    sourceUrl: string | null;
    evidenceNote: string | null;
    updatedAt: string;
    lotId: string | null;
    caseNumber: string | null;
    folio: string | null;
    address: string | null;
  }>;
  lotEvents: Array<{
    id: string;
    kind: string;
    message: string;
    createdAt: string;
    lotId: string | null;
    caseNumber: string | null;
    folio: string | null;
    address: string | null;
  }>;
};

function JsonCell({ value }: { value: unknown }) {
  return (
    <details className="pull-json-details">
      <summary>JSON</summary>
      <pre className="pull-json compact">{JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}

function LotCell({
  lotId,
  caseNumber,
  folio,
  address,
}: {
  lotId: string | null;
  caseNumber: string | null;
  folio: string | null;
  address: string | null;
}) {
  if (!lotId) return <span className="muted">—</span>;
  return (
    <div className="pull-lot-cell">
      <Link href={`/lots/${lotId}?tab=pulls`} target="_blank" rel="noreferrer">
        {caseNumber || lotId.slice(0, 10)}
      </Link>
      {address ? <div className="pull-cell-sub truncate" title={address}>{address}</div> : null}
      {folio ? <div className="pull-cell-sub mono">{folio}</div> : null}
    </div>
  );
}

function Empty({ label }: { label: string }) {
  return <p className="pull-empty muted">{label}</p>;
}

export function RunPullTables({ data }: { data: RunPullPayload }) {
  const { t } = useI18n();

  return (
    <div className="run-pull-page">
      <div className="run-pull-meta muted">
        <span>
          {t("admin.pulledWindow")}: {formatWhen(data.window.from)} → {formatWhen(data.window.to)}
        </span>
        <span>
          {t("common.stage")}: <strong>{data.run.stage}</strong>
        </span>
        <span>
          {t("common.lastStatus")}: <strong>{data.run.status}</strong>
        </span>
      </div>

      <section className="run-pull-section">
        <h2>
          {t("admin.pulledLayers")} <span className="muted">({data.layers.length})</span>
        </h2>
        {data.layers.length === 0 ? (
          <Empty label={t("admin.pulledEmpty")} />
        ) : (
          <div className="table-wrap">
            <table className="pull-table compact">
              <thead>
                <tr>
                  <th>{t("common.when")}</th>
                  <th>{t("admin.layer")}</th>
                  <th>{t("common.lastStatus")}</th>
                  <th>{t("common.case")}</th>
                  <th>{t("admin.pulledSummary")}</th>
                  <th>{t("lotDetail.pullPayload")}</th>
                </tr>
              </thead>
              <tbody>
                {data.layers.map((l) => (
                  <tr key={l.id}>
                    <td className="mono nowrap">{formatWhen(l.fetchedAt)}</td>
                    <td className="mono">{l.name}</td>
                    <td>
                      <span
                        className={`pill ${
                          l.status === "OK" ? "ok" : l.status === "FAILED" ? "bad" : "warn"
                        }`}
                      >
                        {l.status}
                      </span>
                      {l.error ? (
                        <div className="pull-cell-sub truncate" title={l.error}>
                          {l.error}
                        </div>
                      ) : null}
                    </td>
                    <td>
                      <LotCell
                        lotId={l.lotId}
                        caseNumber={l.caseNumber}
                        folio={l.folio}
                        address={l.address}
                      />
                    </td>
                    <td className="pull-summary" title={l.summary}>
                      {l.summary}
                    </td>
                    <td>
                      <JsonCell value={l.payload} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="run-pull-section">
        <h2>
          {t("admin.pulledObservations")}{" "}
          <span className="muted">({data.observations.length})</span>
        </h2>
        {data.observations.length === 0 ? (
          <Empty label={t("admin.pulledEmpty")} />
        ) : (
          <div className="table-wrap">
            <table className="pull-table compact">
              <thead>
                <tr>
                  <th>{t("common.when")}</th>
                  <th>{t("lotDetail.source")}</th>
                  <th>{t("common.case")}</th>
                  <th>{t("common.folio")}</th>
                  <th>{t("admin.pulledSummary")}</th>
                  <th>{t("lotDetail.pullPayload")}</th>
                </tr>
              </thead>
              <tbody>
                {data.observations.map((o) => (
                  <tr key={o.id}>
                    <td className="mono nowrap">{formatWhen(o.fetchedAt)}</td>
                    <td>
                      <span className="pill info">{o.source}</span>
                      {o.externalId ? (
                        <div className="pull-cell-sub mono truncate" title={o.externalId}>
                          {o.externalId}
                        </div>
                      ) : null}
                    </td>
                    <td>
                      <LotCell
                        lotId={o.lotId}
                        caseNumber={o.caseNumber}
                        folio={null}
                        address={o.address}
                      />
                    </td>
                    <td className="mono">{o.folio ?? "—"}</td>
                    <td className="pull-summary" title={o.summary}>
                      {o.summary}
                    </td>
                    <td>
                      <JsonCell value={o.payload} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="run-pull-section">
        <h2>
          {t("admin.pulledDocuments")} <span className="muted">({data.documents.length})</span>
        </h2>
        {data.documents.length === 0 ? (
          <Empty label={t("admin.pulledEmpty")} />
        ) : (
          <div className="table-wrap">
            <table className="pull-table compact">
              <thead>
                <tr>
                  <th>{t("common.when")}</th>
                  <th>{t("lotDetail.type")}</th>
                  <th>{t("lotDetail.title")}</th>
                  <th>{t("common.case")}</th>
                  <th>{t("lotDetail.link")}</th>
                </tr>
              </thead>
              <tbody>
                {data.documents.map((d) => (
                  <tr key={d.id}>
                    <td className="mono nowrap">{formatWhen(d.updatedAt)}</td>
                    <td className="mono">{d.docType}</td>
                    <td>
                      <div className="truncate" title={d.title ?? undefined}>
                        {d.title ?? "—"}
                      </div>
                      {d.evidenceNote ? (
                        <div className="pull-cell-sub truncate" title={d.evidenceNote}>
                          {d.evidenceNote}
                        </div>
                      ) : null}
                    </td>
                    <td>
                      <LotCell
                        lotId={d.lotId}
                        caseNumber={d.caseNumber}
                        folio={d.folio}
                        address={d.address}
                      />
                    </td>
                    <td>
                      {d.sourceUrl ? (
                        <a href={d.sourceUrl} target="_blank" rel="noreferrer">
                          {t("lotDetail.open")}
                        </a>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="run-pull-section">
        <h2>
          {t("admin.pulledEvents")} <span className="muted">({data.lotEvents.length})</span>
        </h2>
        {data.lotEvents.length === 0 ? (
          <Empty label={t("admin.pulledEmpty")} />
        ) : (
          <div className="table-wrap">
            <table className="pull-table compact">
              <thead>
                <tr>
                  <th>{t("common.when")}</th>
                  <th>{t("lotDetail.pullKind")}</th>
                  <th>{t("lotDetail.pullMessage")}</th>
                  <th>{t("common.case")}</th>
                </tr>
              </thead>
              <tbody>
                {data.lotEvents.map((e) => (
                  <tr key={e.id}>
                    <td className="mono nowrap">{formatWhen(e.createdAt)}</td>
                    <td className="mono">{e.kind}</td>
                    <td className="pull-summary" title={e.message}>
                      {e.message}
                    </td>
                    <td>
                      <LotCell
                        lotId={e.lotId}
                        caseNumber={e.caseNumber}
                        folio={e.folio}
                        address={e.address}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
