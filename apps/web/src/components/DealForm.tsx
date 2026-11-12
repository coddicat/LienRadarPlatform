"use client";

import { DealStatus } from "@lienradar/shared";
import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";
import { useI18n } from "@/components/I18nProvider";

const STATUSES = Object.values(DealStatus);

export function DealForm({
  lotId,
  initial,
}: {
  lotId: string;
  initial: { status: string; maxBid: number | null; notes: string | null; thesis: string | null } | null;
}) {
  const router = useRouter();
  const { t } = useI18n();
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    setMsg(null);
    const fd = new FormData(e.currentTarget);
    const res = await fetch("/api/deals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        lotId,
        status: fd.get("status"),
        maxBid: fd.get("maxBid") ? Number(fd.get("maxBid")) : null,
        notes: fd.get("notes"),
        thesis: fd.get("thesis"),
      }),
    });
    setPending(false);
    if (!res.ok) {
      setMsg(t("common.saveFailed"));
      return;
    }
    setMsg(t("common.saved"));
    router.refresh();
  }

  return (
    <form className="stack" onSubmit={onSubmit} style={{ maxWidth: 520 }}>
      <label>
        {t("common.status")}
        <select className="field" name="status" defaultValue={initial?.status ?? DealStatus.WATCHING}>
          {STATUSES.map((s) => (
            <option key={s} value={s}>{t(`dealStatuses.${s}`)}</option>
          ))}
        </select>
      </label>
      <label>
        {t("common.maxBid")}
        <input className="field" name="maxBid" type="number" step="1" defaultValue={initial?.maxBid ?? undefined} />
      </label>
      <label>
        {t("common.notes")}
        <textarea className="field" name="notes" rows={3} defaultValue={initial?.notes ?? ""} />
      </label>
      <label>
        {t("common.thesis")}
        <textarea className="field" name="thesis" rows={3} defaultValue={initial?.thesis ?? ""} />
      </label>
      <button className="btn" type="submit" disabled={pending}>
        {pending ? t("common.saving") : t("common.saveDeal")}
      </button>
      {msg ? <p className="muted">{msg}</p> : null}
    </form>
  );
}
