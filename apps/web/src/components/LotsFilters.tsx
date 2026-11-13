"use client";

import { ACTIVE_COUNTIES, AuctionChannel, AuctionStatus, TimeBucket } from "@lienradar/shared";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useI18n } from "@/components/I18nProvider";
import { MultiSelect } from "@/components/ui/MultiSelect";
import { SearchBar } from "@/components/ui/SearchBar";
import { countyLabel } from "@/lib/countyLabel";

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

export type LotsBoardStats = {
  today: number;
  upcoming: number;
  ready: number;
  review: number;
  blocked: number;
  hot: number;
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

function sameSet(a: string[], b: string[]) {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  return b.every((x) => s.has(x));
}

function presetActive(
  initial: LotsFilterValues,
  preset: Partial<LotsFilterValues>,
): boolean {
  const keys = Object.keys(preset) as (keyof LotsFilterValues)[];
  return keys.every((k) => {
    const want = preset[k];
    if (typeof want === "string") return initial[k] === want;
    if (Array.isArray(want)) return sameSet(initial[k] as string[], want);
    return true;
  });
}

export function LotsFilters({
  initial,
  countyOptions,
  boardStats,
}: {
  initial: LotsFilterValues;
  /** Counties that currently have lots — shown first. */
  countyOptions?: string[];
  boardStats?: LotsBoardStats;
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
    return uniq.map((value) => ({
      value,
      label: countyLabel(t, value),
    }));
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

  const presets: Array<{
    key: string;
    href: string;
    label: string;
    count?: number;
    match: Partial<LotsFilterValues>;
  }> = [
    {
      key: "today",
      href: "/lots?bucket=CURRENT",
      label: t("lots.presetToday"),
      count: boardStats?.today,
      match: { bucket: ["CURRENT"], gate: [], opportunity: [], channel: [], status: [], county: [], q: "" },
    },
    {
      key: "upcoming",
      href: "/lots?bucket=FUTURE",
      label: t("lots.presetUpcoming"),
      count: boardStats?.upcoming,
      match: { bucket: ["FUTURE"], gate: [], opportunity: [], channel: [], status: [], county: [], q: "" },
    },
    {
      key: "ready",
      href: "/lots?gate=allowed",
      label: t("lots.presetReady"),
      count: boardStats?.ready,
      match: { gate: ["allowed"], opportunity: [], bucket: [], channel: [], status: [], county: [], q: "" },
    },
    {
      key: "hot",
      href: "/lots?opportunity=discount",
      label: t("lots.presetHot"),
      count: boardStats?.hot,
      match: {
        opportunity: ["discount"],
        gate: [],
        bucket: [],
        channel: [],
        status: [],
        county: [],
        q: "",
      },
    },
    {
      key: "review",
      href: "/lots?gate=pending",
      label: t("lots.presetReview"),
      count: boardStats?.review,
      match: { gate: ["pending"], opportunity: [], bucket: [], channel: [], status: [], county: [], q: "" },
    },
    {
      key: "fc",
      href: "/lots?channel=FORECLOSURE&bucket=FUTURE,CURRENT",
      label: t("channels.FORECLOSURE"),
      match: {
        channel: ["FORECLOSURE"],
        bucket: ["FUTURE", "CURRENT"],
        gate: [],
        opportunity: [],
        status: [],
        county: [],
        q: "",
      },
    },
    {
      key: "td",
      href: "/lots?channel=TAX_DEED&bucket=FUTURE,CURRENT",
      label: t("channels.TAX_DEED"),
      match: {
        channel: ["TAX_DEED"],
        bucket: ["FUTURE", "CURRENT"],
        gate: [],
        opportunity: [],
        status: [],
        county: [],
        q: "",
      },
    },
  ];

  const chips: Array<{ key: string; label: string; clear: Partial<LotsFilterValues> }> = [];
  if (q.trim()) chips.push({ key: "q", label: `“${q.trim()}”`, clear: { q: "" } });
  for (const c of initial.county) {
    chips.push({
      key: `county-${c}`,
      label: countyLabel(t, c),
      clear: { county: initial.county.filter((x) => x !== c) },
    });
  }
  for (const c of initial.channel) {
    chips.push({
      key: `channel-${c}`,
      label: t(`channels.${c}`),
      clear: { channel: initial.channel.filter((x) => x !== c) },
    });
  }
  for (const b of initial.bucket) {
    chips.push({
      key: `bucket-${b}`,
      label: t(`buckets.${b}`),
      clear: { bucket: initial.bucket.filter((x) => x !== b) },
    });
  }
  for (const g of initial.gate) {
    chips.push({
      key: `gate-${g}`,
      label: t(`gateFilter.${g}`),
      clear: { gate: initial.gate.filter((x) => x !== g) },
    });
  }
  for (const o of initial.opportunity) {
    chips.push({
      key: `opp-${o}`,
      label: o === "discount" ? t("lots.opportunityDiscount") : t("lots.opportunityReady"),
      clear: { opportunity: initial.opportunity.filter((x) => x !== o) },
    });
  }
  for (const s of initial.status) {
    chips.push({
      key: `status-${s}`,
      label: t(`statuses.${s}`),
      clear: { status: initial.status.filter((x) => x !== s) },
    });
  }

  return (
    <div className="filter-panel" data-pending={pending ? "1" : "0"}>
      {boardStats ? (
        <div className="lots-board-stats">
          <Link href="/lots?bucket=CURRENT" className="lots-stat">
            <span className="lots-stat-n">{boardStats.today}</span>
            <span className="lots-stat-l">{t("lots.statToday")}</span>
          </Link>
          <Link href="/lots?bucket=FUTURE" className="lots-stat">
            <span className="lots-stat-n">{boardStats.upcoming}</span>
            <span className="lots-stat-l">{t("lots.statUpcoming")}</span>
          </Link>
          <Link href="/lots?gate=allowed" className="lots-stat ok">
            <span className="lots-stat-n">{boardStats.ready}</span>
            <span className="lots-stat-l">{t("lots.statReady")}</span>
          </Link>
          <Link href="/lots?opportunity=discount" className="lots-stat ok">
            <span className="lots-stat-n">{boardStats.hot}</span>
            <span className="lots-stat-l">{t("lots.statHot")}</span>
          </Link>
          <Link href="/lots?gate=pending" className="lots-stat warn">
            <span className="lots-stat-n">{boardStats.review}</span>
            <span className="lots-stat-l">{t("lots.statReview")}</span>
          </Link>
          <Link href="/lots?gate=blocked" className="lots-stat bad">
            <span className="lots-stat-n">{boardStats.blocked}</span>
            <span className="lots-stat-l">{t("lots.statBlocked")}</span>
          </Link>
        </div>
      ) : null}

      <div className="lots-presets" aria-label={t("lots.presetsLabel")}>
        {presets.map((p) => {
          const active = presetActive(initial, p.match) && !initial.q.trim();
          return (
            <Link
              key={p.key}
              href={p.href}
              className={`lots-preset ${active ? "active" : ""}`}
              scroll={false}
            >
              {p.label}
              {p.count != null ? <span className="n">{p.count}</span> : null}
            </Link>
          );
        })}
      </div>

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

      {chips.length ? (
        <div className="lots-active-filters">
          <span className="lots-active-label">{t("lots.activeFilters")}</span>
          {chips.map((chip) => (
            <button
              key={chip.key}
              type="button"
              className="lots-filter-chip"
              onClick={() => patch(chip.clear)}
            >
              {chip.label}
              <span aria-hidden>×</span>
            </button>
          ))}
          <Link className="btn ghost" href="/lots" style={{ marginLeft: "auto" }}>
            {t("common.clearFilters")}
          </Link>
        </div>
      ) : hasFilters ? (
        <div className="filter-panel-actions">
          <Link className="btn secondary" href="/lots">
            {t("common.clearFilters")}
          </Link>
        </div>
      ) : null}
    </div>
  );
}
