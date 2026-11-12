"use client";

import { ACTIVE_COUNTIES, AuctionChannel, AuctionStatus, TimeBucket } from "@lienradar/shared";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useI18n } from "@/components/I18nProvider";
import { MultiSelect } from "@/components/ui/MultiSelect";
import { SearchBar } from "@/components/ui/SearchBar";

const ALL_STATUSES = Object.values(AuctionStatus);

export type LotsFilterValues = {
  q: string;
  county: string[];
  status: string[];
  bucket: string[];
  channel: string[];
  gate: string[];
  opportunity: string[];
};

function joinParam(values: string[]) {
  return values.filter(Boolean).join(",");
}

function buildLotsHref(next: LotsFilterValues) {
  const qs = new URLSearchParams();
  if (next.q.trim()) qs.set("q", next.q.trim());
  const county = joinParam(next.county);
  const status = joinParam(next.status);
  const bucket = joinParam(next.bucket);
  const channel = joinParam(next.channel);
  const gate = joinParam(next.gate);
  const opportunity = joinParam(next.opportunity);
  if (county) qs.set("county", county);
  if (status) qs.set("status", status);
  if (bucket) qs.set("bucket", bucket);
  if (channel) qs.set("channel", channel);
  if (gate) qs.set("gate", gate);
  if (opportunity) qs.set("opportunity", opportunity);
  const s = qs.toString();
  return s ? `/lots?${s}` : "/lots";
}

export function LotsFilters({
  initial,
  countyOptions,
}: {
  initial: LotsFilterValues;
  /** Counties that currently have lots — shown first. */
  countyOptions?: string[];
}) {
  const { t } = useI18n();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [q, setQ] = useState(initial.q);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setQ(initial.q);
  }, [initial.q]);

  const countySelectOptions = useMemo(() => {
    // Only active South Florida counties + any counties that already have lots in DB.
    const present = new Set((countyOptions ?? []).filter(Boolean));
    const active = ACTIVE_COUNTIES as readonly string[];
    const ordered = [
      ...active.filter((c) => present.has(c)),
      ...active.filter((c) => !present.has(c)),
      ...[...present].filter((c) => !active.includes(c)),
    ];
    const seen = new Set<string>();
    const uniq: string[] = [];
    for (const c of ordered) {
      if (seen.has(c)) continue;
      seen.add(c);
      uniq.push(c);
    }
    return uniq.map((value) => {
      const key = `counties.${value}`;
      const translated = t(key);
      const base = translated === key ? titleCounty(value) : translated;
      return { value, label: base };
    });
  }, [countyOptions, t]);

  function navigate(next: LotsFilterValues) {
    startTransition(() => {
      router.replace(buildLotsHref(next), { scroll: false });
    });
  }

  function current(): LotsFilterValues {
    return {
      q,
      county: initial.county,
      status: initial.status,
      bucket: initial.bucket,
      channel: initial.channel,
      gate: initial.gate,
      opportunity: initial.opportunity,
    };
  }

  function patch(partial: Partial<LotsFilterValues>) {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    const next = { ...current(), ...partial };
    if ("q" in partial) setQ(partial.q ?? "");
    navigate(next);
  }

  function onSearchChange(value: string) {
    setQ(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      navigate({ ...current(), q: value });
    }, 300);
  }

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const hasFilters = Boolean(
    q.trim() ||
      initial.county.length ||
      initial.channel.length ||
      initial.bucket.length ||
      initial.gate.length ||
      initial.status.length ||
      initial.opportunity.length,
  );

  return (
    <div className="filter-panel" data-pending={pending ? "1" : "0"}>
      <div className="filter-panel-search">
        <span className="ui-field-label">{t("lots.filterSearch")}</span>
        <SearchBar
          id="q"
          value={q}
          placeholder={t("lots.searchPlaceholder")}
          onChange={onSearchChange}
        />
      </div>

      <div className="filter-panel-grid filter-panel-grid-lots">
        <MultiSelect
          label={t("lots.filterCounty")}
          allLabel={t("counties.all")}
          clearLabel={t("common.clearFilters")}
          value={initial.county}
          onChange={(county) => patch({ county })}
          options={countySelectOptions}
        />
        <MultiSelect
          label={t("lots.filterType")}
          allLabel={t("channels.all")}
          clearLabel={t("common.clearFilters")}
          value={initial.channel}
          onChange={(channel) => patch({ channel })}
          options={[
            { value: AuctionChannel.TAX_DEED, label: t("channels.TAX_DEED") },
            { value: AuctionChannel.FORECLOSURE, label: t("channels.FORECLOSURE") },
            { value: AuctionChannel.BANK_REO, label: t("channels.BANK_REO") },
          ]}
        />
        <MultiSelect
          label={t("lots.filterTiming")}
          allLabel={t("buckets.all")}
          clearLabel={t("common.clearFilters")}
          value={initial.bucket}
          onChange={(bucket) => patch({ bucket })}
          options={[
            { value: TimeBucket.FUTURE, label: t("buckets.FUTURE") },
            { value: TimeBucket.CURRENT, label: t("buckets.CURRENT") },
            { value: TimeBucket.PAST, label: t("buckets.PAST") },
          ]}
        />
        <MultiSelect
          label={t("lots.filterDecision")}
          allLabel={t("gateFilter.any")}
          clearLabel={t("common.clearFilters")}
          value={initial.gate}
          onChange={(gate) => patch({ gate })}
          options={[
            { value: "allowed", label: t("gateFilter.allowed") },
            { value: "blocked", label: t("gateFilter.blocked") },
            { value: "pending", label: t("gateFilter.pending") },
          ]}
        />
        <MultiSelect
          label={t("lots.filterOpportunity")}
          allLabel={t("lots.opportunityAny")}
          clearLabel={t("common.clearFilters")}
          value={initial.opportunity}
          onChange={(opportunity) => patch({ opportunity })}
          options={[
            { value: "discount", label: t("lots.opportunityDiscount") },
            { value: "ready", label: t("lots.opportunityReady") },
          ]}
        />
        <MultiSelect
          label={t("lots.filterSaleStatus")}
          allLabel={t("statuses.all")}
          clearLabel={t("common.clearFilters")}
          value={initial.status}
          onChange={(status) => patch({ status })}
          options={ALL_STATUSES.map((s) => ({
            value: s,
            label: t(`statuses.${s}`),
          }))}
        />
      </div>

      {hasFilters ? (
        <div className="filter-panel-actions">
          <Link className="btn secondary" href="/lots">
            {t("common.clearFilters")}
          </Link>
        </div>
      ) : null}
    </div>
  );
}

function titleCounty(slug: string) {
  return slug
    .split("-")
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(" ");
}
