"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/components/I18nProvider";
import { RunPullTables, type RunPullPayload } from "@/components/RunPullTables";

export function RunPullPageClient({ runId }: { runId: string }) {
  const { t } = useI18n();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<RunPullPayload | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const res = await fetch(`/api/jobs/runs/${runId}`);
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
        if (!cancelled) setData(json as RunPullPayload);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [runId]);

  if (loading) return <p className="muted">{t("common.loading")}</p>;
  if (error) return <p style={{ color: "var(--bad)" }}>{error}</p>;
  if (!data) return <p className="muted">{t("admin.pulledEmpty")}</p>;
  return <RunPullTables data={data} />;
}
