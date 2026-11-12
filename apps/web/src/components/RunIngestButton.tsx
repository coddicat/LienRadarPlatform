"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useI18n } from "@/components/I18nProvider";

export function RunIngestButton({ jobs }: { jobs: Array<{ key: string; name: string }> }) {
  const router = useRouter();
  const { t } = useI18n();
  const [pending, setPending] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function run(job: string) {
    setPending(true);
    setMsg(null);
    const res = await fetch("/api/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ job }),
    });
    const json = await res.json().catch(() => ({}));
    setPending(false);
    if (!res.ok) {
      setMsg(`${t("common.failed")}: ${json.error ?? "unknown error"}`);
    } else {
      setMsg(t("common.ok"));
    }
    router.refresh();
  }

  return (
    <div className="stack">
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button className="btn" disabled={pending} type="button" onClick={() => run("all")}>
          {t("common.runAll")}
        </button>
        {jobs.map((j) => (
          <button
            key={j.key}
            className="btn secondary"
            disabled={pending}
            type="button"
            title={j.key}
            onClick={() => run(j.key)}
          >
            {j.name}
          </button>
        ))}
      </div>
      {msg ? <p className="muted">{msg}</p> : null}
    </div>
  );
}
