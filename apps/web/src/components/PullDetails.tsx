import { formatWhen } from "@/lib/labels";

function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function statusClass(status: string): string {
  const s = status.toUpperCase();
  if (s === "OK" || s === "PASS") return "ok";
  if (s === "ERROR" || s === "FAIL" || s === "STALE") return "bad";
  return "warn";
}

type Observation = {
  id: string;
  source: string;
  externalId: string | null;
  fetchedAt: Date;
  contentHash: string | null;
  payload: unknown;
};

type Layer = {
  id: string;
  name: string;
  status: string;
  fetchedAt: Date;
  error: string | null;
  payload: unknown;
};

type EventRow = {
  id: string;
  kind: string;
  message: string;
  payload: unknown;
  createdAt: Date;
};

export function PullDetails({
  observations,
  layers,
  events,
  labels,
}: {
  observations: Observation[];
  layers: Layer[];
  events: EventRow[];
  labels: {
    hint: string;
    observations: string;
    layers: string;
    events: string;
    empty: string;
    source: string;
    externalId: string;
    fetched: string;
    hash: string;
    payload: string;
    status: string;
    error: string;
    kind: string;
    message: string;
  };
}) {
  return (
    <div className="pull-details">
      <p className="sub" style={{ marginTop: 0 }}>
        {labels.hint}
      </p>

      <h2 style={{ fontSize: 16, marginBottom: 8 }}>{labels.layers}</h2>
      {layers.length === 0 ? <p className="muted">{labels.empty}</p> : null}
      <div className="pull-list">
        {layers.map((l) => (
          <details key={l.id} className="pull-item">
            <summary>
              <span className="mono">{l.name}</span>
              <span className={`pill ${statusClass(l.status)}`}>{l.status}</span>
              <span className="muted">{formatWhen(l.fetchedAt)}</span>
            </summary>
            <dl className="kv pull-meta">
              <dt>{labels.status}</dt>
              <dd>
                <span className={`pill ${statusClass(l.status)}`}>{l.status}</span>
              </dd>
              <dt>{labels.fetched}</dt>
              <dd>{formatWhen(l.fetchedAt)}</dd>
              {l.error ? (
                <>
                  <dt>{labels.error}</dt>
                  <dd className="muted">{l.error}</dd>
                </>
              ) : null}
              <dt>{labels.payload}</dt>
              <dd>
                <pre className="pull-json">{prettyJson(l.payload)}</pre>
              </dd>
            </dl>
          </details>
        ))}
      </div>

      <h2 style={{ fontSize: 16, margin: "24px 0 8px" }}>{labels.observations}</h2>
      {observations.length === 0 ? <p className="muted">{labels.empty}</p> : null}
      <div className="pull-list">
        {observations.map((o) => (
          <details key={o.id} className="pull-item">
            <summary>
              <span className="pill info">{o.source}</span>
              <span className="mono muted">{o.externalId ?? "—"}</span>
              <span className="muted">{formatWhen(o.fetchedAt)}</span>
            </summary>
            <dl className="kv pull-meta">
              <dt>{labels.source}</dt>
              <dd>{o.source}</dd>
              <dt>{labels.externalId}</dt>
              <dd className="mono">{o.externalId ?? "—"}</dd>
              <dt>{labels.fetched}</dt>
              <dd>{formatWhen(o.fetchedAt)}</dd>
              <dt>{labels.hash}</dt>
              <dd className="mono">{o.contentHash ?? "—"}</dd>
              <dt>{labels.payload}</dt>
              <dd>
                <pre className="pull-json">{prettyJson(o.payload)}</pre>
              </dd>
            </dl>
          </details>
        ))}
      </div>

      <h2 style={{ fontSize: 16, margin: "24px 0 8px" }}>{labels.events}</h2>
      {events.length === 0 ? <p className="muted">{labels.empty}</p> : null}
      <div className="pull-list">
        {events.map((e) => (
          <details key={e.id} className="pull-item">
            <summary>
              <span className="mono">{e.kind}</span>
              <span className="muted">{e.message}</span>
              <span className="muted">{formatWhen(e.createdAt)}</span>
            </summary>
            <dl className="kv pull-meta">
              <dt>{labels.kind}</dt>
              <dd className="mono">{e.kind}</dd>
              <dt>{labels.message}</dt>
              <dd>{e.message}</dd>
              <dt>{labels.fetched}</dt>
              <dd>{formatWhen(e.createdAt)}</dd>
              <dt>{labels.payload}</dt>
              <dd>
                <pre className="pull-json">{prettyJson(e.payload ?? null)}</pre>
              </dd>
            </dl>
          </details>
        ))}
      </div>
    </div>
  );
}
