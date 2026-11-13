"use client";

import { useI18n } from "@/components/I18nProvider";

/** Opens the compact pulled-data tables page in a new browser tab. */
export function RunPullDetails({ runId }: { runId: string }) {
  const { t } = useI18n();
  return (
    <div className="run-pulls" style={{ marginTop: 8 }}>
      <a
        className="btn ghost"
        href={`/admin/runs/${runId}`}
        target="_blank"
        rel="noopener noreferrer"
      >
        {t("admin.showPulledData")} ↗
      </a>
    </div>
  );
}
