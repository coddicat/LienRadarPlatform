"use client";

import { ACTIVE_COUNTIES } from "@lienradar/shared";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "@/components/I18nProvider";
import { ScheduleEditor, formatScheduleSummary } from "@/components/ScheduleEditor";
import { MultiSelect } from "@/components/ui/MultiSelect";
import { SearchBar } from "@/components/ui/SearchBar";
import { Switch } from "@/components/ui/Switch";
import { countyLabel, resourceCountySlug } from "@/lib/countyLabel";
import { parseCronToFriendly, type ScheduleKind } from "@/lib/cronFriendly";
import { formatDuration, formatWhen } from "@/lib/labels";

type JobRow = {
  id: string;
  key: string;
  name: string;
  description: string;
  cronExpr: string;
  timezone: string;
  enabled: boolean;
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
  lastCounts: Record<string, unknown> | null;
  nextRunAt: string | null;
  running: boolean;
  /** Counties this job touches (from SCHEDULED_JOBS.resourceKeys). */
  counties?: string[];
};

type ResourceRow = {
  id: string;
  key: string;
  name: string;
  kind: string;
  status: string;
  endpoint: string | null;
  detail: string | null;
  lastError: string | null;
  lastCheckedAt: string | null;
  lastSuccessAt: string | null;
};

const RESOURCE_HEALTH_FILTER = ["OK", "DEGRADED", "DOWN", "NOT_CONFIGURED", "NEVER_RUN"] as const;

type RunRow = {
  id: string;
  stage: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  counts: Record<string, unknown> | null;
  errorSummary: string | null;
  notes: string | null;
};

type Payload = {
  syncedAt: string;
  jobs: JobRow[];
  resources: ResourceRow[];
  runs: RunRow[];
};

function healthClass(status: string) {
  if (status === "OK" || status === "SUCCESS") return "ok";
  if (status === "DOWN" || status === "FAILED") return "bad";
  if (status === "NOT_CONFIGURED" || status === "NEVER_RUN" || status === "RUNNING") return "warn";
  return "warn";
}

function summaryText(counts: Record<string, unknown> | null | undefined): string {
  if (!counts || typeof counts !== "object") return "—";
  return Object.entries(counts)
    .map(([k, v]) => `${k}: ${String(v)}`)
    .join(" · ");
}

export function JobsConsole({
  initial,
  lotCount,
}: {
  initial: Payload;
  lotCount: number;
}) {
  const { t } = useI18n();
  const [data, setData] = useState<Payload>(initial);
  /** Keys currently kicking off a request — never locks the whole console. */
  const [pendingKeys, setPendingKeys] = useState<string[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [editCron, setEditCron] = useState<Record<string, string>>({});
  const [editingScheduleKey, setEditingScheduleKey] = useState<string | null>(null);
  const [live, setLive] = useState(true);
  const [jobQuery, setJobQuery] = useState("");
  const [filterState, setFilterState] = useState<string[]>([]);
  const [filterResult, setFilterResult] = useState<string[]>([]);
  const [filterCadence, setFilterCadence] = useState<string[]>([]);
  const [filterJobCounty, setFilterJobCounty] = useState<string[]>([]);
  const [filterResourceCounty, setFilterResourceCounty] = useState<string[]>([]);
  const [filterResourceStatus, setFilterResourceStatus] = useState<string[]>([]);

  const jobCountyFilterOptions = useMemo(() => {
    return (ACTIVE_COUNTIES as readonly string[]).map((value) => ({
      value,
      label: countyLabel(t, value),
    }));
  }, [t]);

  const resourceCountyFilterOptions = useMemo(() => {
    return [
      ...jobCountyFilterOptions,
      { value: "shared", label: t("admin.filterResourcesShared") },
    ];
  }, [jobCountyFilterOptions, t]);

  const filteredJobs = useMemo(() => {
    const q = jobQuery.trim().toLowerCase();
    return data.jobs.filter((j) => {
      if (q) {
        const hay = `${j.name} ${j.description} ${j.key}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }

      if (filterState.length) {
        const tags: string[] = [];
        if (j.running) tags.push("running");
        if (j.enabled) tags.push("automatic");
        else tags.push("paused");
        if (!filterState.some((s) => tags.includes(s))) return false;
      }

      if (filterResult.length) {
        const result = j.running
          ? "RUNNING"
          : j.lastStatus === "SUCCESS" || j.lastStatus === "PARTIAL" || j.lastStatus === "FAILED"
            ? j.lastStatus
            : "NEVER_RUN";
        if (!filterResult.includes(result)) return false;
      }

      if (filterCadence.length) {
        const kind: ScheduleKind = parseCronToFriendly(j.cronExpr).kind;
        if (!filterCadence.includes(kind)) return false;
      }

      if (filterJobCounty.length) {
        const counties = j.counties?.length ? j.counties : [...ACTIVE_COUNTIES];
        if (!filterJobCounty.some((c) => counties.includes(c))) return false;
      }

      return true;
    });
  }, [data.jobs, jobQuery, filterState, filterResult, filterCadence, filterJobCounty]);

  const hasJobFilters = Boolean(
    jobQuery.trim() ||
      filterState.length ||
      filterResult.length ||
      filterCadence.length ||
      filterJobCounty.length,
  );

  function clearJobFilters() {
    setJobQuery("");
    setFilterState([]);
    setFilterResult([]);
    setFilterCadence([]);
    setFilterJobCounty([]);
  }

  const filteredResources = useMemo(() => {
    return data.resources.filter((r) => {
      const county = resourceCountySlug(r.key, r.name);
      if (filterResourceCounty.length && !filterResourceCounty.includes(county)) return false;
      if (filterResourceStatus.length && !filterResourceStatus.includes(r.status)) return false;
      return true;
    });
  }, [data.resources, filterResourceCounty, filterResourceStatus]);

  const hasResourceFilters = Boolean(filterResourceCounty.length || filterResourceStatus.length);

  function clearResourceFilters() {
    setFilterResourceCounty([]);
    setFilterResourceStatus([]);
  }

  function isPending(key: string) {
    return pendingKeys.includes(key);
  }

  function addPending(key: string) {
    setPendingKeys((prev) => (prev.includes(key) ? prev : [...prev, key]));
  }

  function removePending(key: string) {
    setPendingKeys((prev) => prev.filter((k) => k !== key));
  }

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/jobs", { cache: "no-store" });
      if (!res.ok) return;
      const json = (await res.json()) as Payload;
      setData(json);
    } catch {
      /* keep last good snapshot */
    }
  }, []);

  // Poll faster while anything is RUNNING so the Run All button re-enables promptly.
  const anyRunning = data.jobs.some((j) => j.running) || data.runs.some((r) => r.status === "RUNNING");
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!live) return;
    const ms = anyRunning ? 2000 : 5000;
    const id = setInterval(() => {
      void refresh();
    }, ms);
    return () => clearInterval(id);
  }, [live, refresh, anyRunning]);

  // Keep elapsed timers updating between polls.
  useEffect(() => {
    if (!anyRunning) return;
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [anyRunning]);

  async function patchJob(key: string, body: Record<string, unknown>) {
    addPending(key);
    setMsg(null);
    try {
      const res = await fetch("/api/jobs", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key, ...body }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMsg(`${t("common.failed")}: ${json.error ?? "error"}`);
        return false;
      }
      setMsg(t("common.saved"));
      await refresh();
      return true;
    } finally {
      removePending(key);
    }
  }

  async function runJob(job: string) {
    addPending(job);
    setMsg(null);
    const startedAt = new Date().toISOString();
    const allRefreshKeys = new Set([
      "calendar_6h",
      "enrich_folio_6h",
      "enrich_pa_6h",
      "enrich_muni_6h",
      "enrich_flood_6h",
      "enrich_clerk_nightly",
      "enrich_tax_nightly",
      "enrich_or_nightly",
      "reo_daily",
      "method_nightly",
    ]);
    // Optimistic: mark target job(s) RUNNING immediately (esp. "Refresh everything").
    setData((prev) => ({
      ...prev,
      jobs: prev.jobs.map((j) => {
        const hit = job === "all" ? allRefreshKeys.has(j.key) : j.key === job;
        if (!hit) return j;
        return {
          ...j,
          running: true,
          lastStatus: "RUNNING",
          lastStartedAt: startedAt,
          lastError: null,
        };
      }),
    }));
    try {
      const res = await fetch("/api/ingest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ job, async: true }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMsg(`${t("common.failed")}: ${json.error ?? "error"}`);
        await refresh();
        return;
      }
      setMsg(
        json.accepted
          ? job === "all"
            ? t("admin.runAllStarted")
            : `${t("admin.runStarted")}: ${job}`
          : `${t("common.ok")}: ${typeof json.result === "object" ? summaryText(json.result) : t("admin.runFinished")}`,
      );
      // Don't await a long poll here — clear pending so the button unlocks; live sync tracks finish.
      void refresh();
    } catch (e) {
      setMsg(`${t("common.failed")}: ${e instanceof Error ? e.message : String(e)}`);
      await refresh();
    } finally {
      removePending(job);
    }
  }

  const down = data.resources.filter((r) => r.status === "DOWN").length;
  const notConfigured = data.resources.filter((r) => r.status === "NOT_CONFIGURED").length;
  const ok = data.resources.filter((r) => r.status === "OK").length;
  const running = data.jobs.filter((j) => j.running).length;
  // Button stays in Running while the kickoff is in flight OR while any job is still RUNNING.
  // After live poll shows all finished, it re-enables without a full page reload.
  const refreshAllBusy = isPending("all") || running > 0;

  return (
    <div className="jobs-console">
      <div className="callout">{t("admin.partnerTip")}</div>

      <div className="cards">
        <div className="card">
          <div className="label">{t("admin.lotsInDb")}</div>
          <div className="value">{lotCount}</div>
        </div>
        <div className="card">
          <div className="label">{t("admin.resourcesOk")}</div>
          <div className="value" style={{ color: "var(--ok)" }}>{ok}</div>
        </div>
        <div className="card">
          <div className="label">{t("admin.down")}</div>
          <div className="value" style={{ color: "var(--bad)" }}>{down}</div>
        </div>
        <div className="card">
          <div className="label">{t("admin.notConfigured")}</div>
          <div className="value" style={{ color: "var(--warn)" }}>{notConfigured}</div>
        </div>
        <div className="card">
          <div className="label">{t("admin.runningNow")}</div>
          <div className="value" style={{ color: running ? "var(--warn)" : "inherit" }}>{running}</div>
        </div>
      </div>

      <div className="panel panel-pad" style={{ marginBottom: 14 }}>
        <div className="jobs-toolbar">
          <div>
            <h2 style={{ marginTop: 0, marginBottom: 4 }}>{t("admin.controlCenter")}</h2>
            <p className="muted" style={{ margin: 0, fontSize: 13 }}>
              {t("admin.liveSync")}: {live ? t("admin.liveOn") : t("admin.liveOff")}
              {data.syncedAt ? ` · ${formatWhen(data.syncedAt)}` : ""}
            </p>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button type="button" className="btn secondary" onClick={() => setLive((v) => !v)}>
              {live ? t("admin.pauseSync") : t("admin.resumeSync")}
            </button>
            <button type="button" className="btn secondary" onClick={() => void refresh()}>
              {t("admin.refreshNow")}
            </button>
            <button
              type="button"
              className="btn"
              disabled={refreshAllBusy}
              onClick={() => void runJob("all")}
              title={running > 0 ? t("admin.runInBackground") : undefined}
            >
              {refreshAllBusy ? t("health.RUNNING") : t("common.runAll")}
            </button>
          </div>
        </div>
        {msg ? <p className="muted" style={{ marginBottom: 0 }}>{msg}</p> : null}
      </div>

      <section className="panel schedule-panel" style={{ marginBottom: 14 }}>
        <div className="schedule-panel-head">
          <div>
            <h2>{t("admin.scheduledJobs")}</h2>
            <p>
              {filteredJobs.length === data.jobs.length
                ? `${data.jobs.length} ${t("admin.jobsShown")}`
                : `${filteredJobs.length} / ${data.jobs.length} ${t("admin.jobsShown")}`}
            </p>
          </div>
        </div>

        <div className="filter-panel schedule-filter-panel">
          <div className="filter-panel-search">
            <span className="ui-field-label">{t("admin.filterJobsSearch")}</span>
            <SearchBar
              id="job-q"
              value={jobQuery}
              placeholder={t("admin.filterJobsSearchPh")}
              onChange={setJobQuery}
            />
          </div>
          <div className="filter-panel-grid filter-panel-grid-lots">
            <MultiSelect
              label={t("admin.filterJobsCounty")}
              allLabel={t("admin.filterJobsCountyAny")}
              clearLabel={t("common.clearFilters")}
              value={filterJobCounty}
              onChange={setFilterJobCounty}
              options={jobCountyFilterOptions}
            />
            <MultiSelect
              label={t("admin.filterJobsState")}
              allLabel={t("admin.filterJobsStateAny")}
              clearLabel={t("common.clearFilters")}
              value={filterState}
              onChange={setFilterState}
              options={[
                { value: "automatic", label: t("admin.schedulerOn") },
                { value: "paused", label: t("admin.schedulerOff") },
                { value: "running", label: t("health.RUNNING") },
              ]}
            />
            <MultiSelect
              label={t("admin.filterJobsResult")}
              allLabel={t("admin.filterJobsResultAny")}
              clearLabel={t("common.clearFilters")}
              value={filterResult}
              onChange={setFilterResult}
              options={[
                { value: "SUCCESS", label: t("health.SUCCESS") },
                { value: "PARTIAL", label: t("health.PARTIAL") },
                { value: "FAILED", label: t("health.FAILED") },
                { value: "NEVER_RUN", label: t("common.neverRun") },
              ]}
            />
            <MultiSelect
              label={t("admin.filterJobsCadence")}
              allLabel={t("admin.filterJobsCadenceAny")}
              clearLabel={t("common.clearFilters")}
              value={filterCadence}
              onChange={setFilterCadence}
              options={[
                { value: "every_minutes", label: t("admin.scheduleEveryMinutes") },
                { value: "every_hours", label: t("admin.scheduleEveryHours") },
                { value: "daily", label: t("admin.scheduleDaily") },
                { value: "weekdays", label: t("admin.scheduleWeekdays") },
                { value: "custom", label: t("admin.scheduleCustom") },
              ]}
            />
          </div>
          {hasJobFilters ? (
            <div className="filter-panel-actions">
              <button type="button" className="btn secondary" onClick={clearJobFilters}>
                {t("common.clearFilters")}
              </button>
            </div>
          ) : null}
        </div>

        <div className="schedule-list" role="list">
          <div className="schedule-list-header" aria-hidden>
            <span>{t("common.job")}</span>
            <span>{t("common.cron")}</span>
            <span>{t("admin.nextRun")}</span>
            <span>{t("common.lastRun")}</span>
            <span>{t("common.actions")}</span>
          </div>

          {filteredJobs.map((j) => {
            const cronValue = editCron[j.key] ?? j.cronExpr;
            const editing = editingScheduleKey === j.key;
            const dirty = cronValue !== j.cronExpr;
            const successSummary =
              j.lastStatus === "SUCCESS" || j.lastStatus === "PARTIAL"
                ? summaryText(j.lastCounts)
                : null;
            const duration = j.running
              ? formatDuration(j.lastStartedAt)
              : j.lastFinishedAt &&
                  j.lastStartedAt &&
                  new Date(j.lastFinishedAt).getTime() >= new Date(j.lastStartedAt).getTime()
                ? formatDuration(j.lastStartedAt, j.lastFinishedAt)
                : null;
            const statusLabel = j.lastStatus
              ? t(`health.${j.lastStatus}`) !== `health.${j.lastStatus}`
                ? t(`health.${j.lastStatus}`)
                : j.lastStatus
              : t("common.neverRun");
            const resultTone = j.running
              ? "warn"
              : healthClass(j.lastStatus ?? "NEVER_RUN");

            return (
              <div
                key={j.id}
                role="listitem"
                className={`schedule-row ${j.running ? "is-running" : ""} ${j.enabled ? "" : "is-paused"} ${editing ? "is-open" : ""}`}
              >
                <div className="schedule-row-main">
                  <div className="schedule-row-job">
                    <span className={`schedule-dot ${resultTone}`} title={j.running ? t("health.RUNNING") : statusLabel} />
                    <div className="schedule-row-copy">
                      <div className="schedule-row-name">{j.name}</div>
                      <div className="schedule-row-desc">{j.description}</div>
                      {j.counties?.length ? (
                        <div className="schedule-row-counties">
                          {j.counties.map((c) => (
                            <span key={c} className="pill neutral">
                              {countyLabel(t, c)}
                            </span>
                          ))}
                        </div>
                      ) : null}
                      {j.lastError ? (
                        <div className="schedule-row-alert">{j.lastError}</div>
                      ) : successSummary && !editing ? (
                        <div className="schedule-row-hint">{successSummary}</div>
                      ) : null}
                    </div>
                  </div>

                  <div className="schedule-row-cell">
                    <span className="schedule-mobile-label">{t("common.cron")}</span>
                    <strong>{formatScheduleSummary(t, j.cronExpr)}</strong>
                  </div>

                  <div className="schedule-row-cell">
                    <span className="schedule-mobile-label">{t("admin.nextRun")}</span>
                    <strong>
                      {j.enabled
                        ? j.nextRunAt
                          ? formatWhen(j.nextRunAt)
                          : "—"
                        : t("admin.schedulerStopped")}
                    </strong>
                  </div>

                  <div className="schedule-row-cell">
                    <span className="schedule-mobile-label">{t("common.lastRun")}</span>
                    <strong>
                      {j.lastStartedAt ? formatWhen(j.lastStartedAt) : t("common.neverRun")}
                    </strong>
                    {duration ? (
                      <span className="schedule-row-sub">
                        {j.running ? t("admin.elapsed") : t("admin.took")} {duration}
                      </span>
                    ) : null}
                    <span className={`pill ${resultTone} schedule-result-pill`}>
                      {j.running ? t("health.RUNNING") : statusLabel}
                    </span>
                  </div>

                  <div className="schedule-row-actions">
                    <div className="schedule-toggle">
                      <Switch
                        checked={j.enabled}
                        disabled={isPending(j.key)}
                        label={j.enabled ? t("admin.schedulerOn") : t("admin.schedulerOff")}
                        onChange={(next) => void patchJob(j.key, { enabled: next })}
                      />
                      <span className="schedule-toggle-label">
                        {j.enabled ? t("admin.schedulerOn") : t("admin.schedulerOff")}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="btn secondary"
                      disabled={isPending(j.key) || j.running}
                      onClick={() => void runJob(j.key)}
                      title={j.running ? t("admin.runInBackground") : undefined}
                    >
                      {j.running || isPending(j.key) ? t("health.RUNNING") : t("admin.runOnce")}
                    </button>
                    <button
                      type="button"
                      className={`btn ghost ${editing ? "is-active-ghost" : ""}`}
                      disabled={isPending(j.key)}
                      onClick={() => {
                        if (editing) {
                          setEditingScheduleKey(null);
                          setEditCron((prev) => {
                            const copy = { ...prev };
                            delete copy[j.key];
                            return copy;
                          });
                          return;
                        }
                        setEditingScheduleKey(j.key);
                        setEditCron((prev) => ({ ...prev, [j.key]: j.cronExpr }));
                      }}
                    >
                      {editing ? t("admin.cancelEditSchedule") : t("admin.editSchedule")}
                    </button>
                  </div>
                </div>

                {editing ? (
                  <div className="schedule-row-editor">
                    <ScheduleEditor
                      value={cronValue}
                      timezone={j.timezone}
                      disabled={isPending(j.key)}
                      dirty={dirty}
                      onChange={(next) =>
                        setEditCron((prev) => ({ ...prev, [j.key]: next }))
                      }
                      onCancel={() => {
                        setEditingScheduleKey(null);
                        setEditCron((prev) => {
                          const copy = { ...prev };
                          delete copy[j.key];
                          return copy;
                        });
                      }}
                      onSave={() => {
                        void patchJob(j.key, { cronExpr: cronValue }).then((ok) => {
                          if (ok) {
                            setEditingScheduleKey(null);
                            setEditCron((prev) => {
                              const copy = { ...prev };
                              delete copy[j.key];
                              return copy;
                            });
                          }
                        });
                      }}
                    />
                  </div>
                ) : null}
              </div>
            );
          })}

          {data.jobs.length === 0 ? (
            <div className="schedule-empty">{t("admin.noJobs")}</div>
          ) : filteredJobs.length === 0 ? (
            <div className="schedule-empty">
              <p>{t("admin.noJobsMatch")}</p>
              <button type="button" className="btn secondary" onClick={clearJobFilters}>
                {t("common.clearFilters")}
              </button>
            </div>
          ) : null}
        </div>
      </section>

      <div className="panel" style={{ marginBottom: 14 }}>
        <div className="panel-title">
          <strong>{t("admin.dataResources")}</strong>
          <span className="muted" style={{ fontSize: 13 }}>
            {filteredResources.length === data.resources.length
              ? `${data.resources.length}`
              : `${filteredResources.length} / ${data.resources.length} ${t("admin.resourcesShown")}`}
          </span>
        </div>

        <div className="filter-panel schedule-filter-panel" style={{ marginBottom: 12 }}>
          <div className="filter-panel-grid filter-panel-grid-3">
            <MultiSelect
              label={t("admin.filterResourcesCounty")}
              allLabel={t("admin.filterResourcesCountyAny")}
              clearLabel={t("common.clearFilters")}
              value={filterResourceCounty}
              onChange={setFilterResourceCounty}
              options={resourceCountyFilterOptions}
            />
            <MultiSelect
              label={t("admin.filterResourcesStatus")}
              allLabel={t("admin.filterResourcesStatusAny")}
              clearLabel={t("common.clearFilters")}
              value={filterResourceStatus}
              onChange={setFilterResourceStatus}
              options={RESOURCE_HEALTH_FILTER.map((value) => ({
                value,
                label:
                  t(`health.${value}`) !== `health.${value}` ? t(`health.${value}`) : value.replaceAll("_", " "),
              }))}
            />
          </div>
          {hasResourceFilters ? (
            <div className="filter-panel-actions">
              <button type="button" className="btn secondary" onClick={clearResourceFilters}>
                {t("common.clearFilters")}
              </button>
            </div>
          ) : null}
        </div>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t("common.resource")}</th>
                <th>{t("admin.colCounty")}</th>
                <th>{t("common.kind")}</th>
                <th>{t("common.status")}</th>
                <th>{t("common.checked")}</th>
                <th>{t("common.lastSuccess")}</th>
                <th>{t("common.detail")}</th>
              </tr>
            </thead>
            <tbody>
              {filteredResources.map((r) => {
                const county = resourceCountySlug(r.key, r.name);
                return (
                <tr key={r.id}>
                  <td>
                    <div className="strong">{r.name}</div>
                    {r.endpoint ? (
                      <div className="row-meta">
                        <a href={r.endpoint} target="_blank" rel="noreferrer">
                          {t("lotDetail.open")}
                        </a>
                      </div>
                    ) : null}
                  </td>
                  <td>
                    <span className="pill neutral">
                      {county === "shared"
                        ? t("admin.filterResourcesShared")
                        : countyLabel(t, county)}
                    </span>
                  </td>
                  <td className="muted">{r.kind.replaceAll("_", " ")}</td>
                  <td>
                    <span className={`pill ${healthClass(r.status)}`}>
                      {t(`health.${r.status}`) !== `health.${r.status}` ? t(`health.${r.status}`) : r.status}
                    </span>
                  </td>
                  <td className="muted" style={{ fontSize: 12 }}>
                    {r.lastCheckedAt ? formatWhen(r.lastCheckedAt) : "—"}
                  </td>
                  <td className="muted" style={{ fontSize: 12 }}>
                    {r.lastSuccessAt ? formatWhen(r.lastSuccessAt) : "—"}
                  </td>
                  <td className="muted">
                    <div>{r.detail ?? "—"}</div>
                    {r.lastError ? <div style={{ color: "var(--bad)" }}>{r.lastError}</div> : null}
                  </td>
                </tr>
                );
              })}
              {data.resources.length === 0 ? (
                <tr>
                  <td colSpan={7} className="empty">
                    {t("dashboard.noResources")}
                  </td>
                </tr>
              ) : filteredResources.length === 0 ? (
                <tr>
                  <td colSpan={7} className="empty">
                    <p>{t("admin.noResourcesMatch")}</p>
                    <button type="button" className="btn secondary" onClick={clearResourceFilters}>
                      {t("common.clearFilters")}
                    </button>
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <div className="panel-title">
          <strong>{t("admin.ingestLog")}</strong>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t("common.started")}</th>
                <th>{t("admin.duration")}</th>
                <th>{t("common.stage")}</th>
                <th>{t("common.lastStatus")}</th>
                <th>{t("admin.summaryOrError")}</th>
              </tr>
            </thead>
            <tbody>
              {data.runs.map((r) => {
                const runDuration =
                  r.status === "RUNNING"
                    ? formatDuration(r.startedAt)
                    : formatDuration(r.startedAt, r.finishedAt);
                return (
                <tr key={r.id}>
                  <td className="muted" style={{ fontSize: 12 }}>
                    {formatWhen(r.startedAt)}
                    {r.finishedAt ? (
                      <div className="row-meta">{t("admin.finished")}: {formatWhen(r.finishedAt)}</div>
                    ) : null}
                  </td>
                  <td className="muted mono" style={{ fontSize: 12, whiteSpace: "nowrap" }}>
                    {runDuration ? (
                      <span>
                        {r.status === "RUNNING" ? t("admin.elapsed") : t("admin.took")}: {runDuration}
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td>{r.stage.replaceAll("_", " ")}</td>
                  <td>
                    <span className={`pill ${healthClass(r.status)}`}>
                      {t(`health.${r.status}`) !== `health.${r.status}` ? t(`health.${r.status}`) : r.status}
                    </span>
                  </td>
                  <td className="muted" style={{ fontSize: 12 }}>
                    {r.errorSummary ? (
                      <div style={{ color: "var(--bad)" }}>{r.errorSummary}</div>
                    ) : (
                      <div>{summaryText(r.counts)}</div>
                    )}
                    {r.notes ? <div className="row-meta">{r.notes}</div> : null}
                  </td>
                </tr>
                );
              })}
              {data.runs.length === 0 ? (
                <tr>
                  <td colSpan={5} className="empty">
                    {t("admin.noRuns")}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
