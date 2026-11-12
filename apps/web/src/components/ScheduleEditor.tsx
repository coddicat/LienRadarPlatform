"use client";

import { useMemo, useState } from "react";
import { useI18n } from "@/components/I18nProvider";
import { SingleSelect } from "@/components/ui/MultiSelect";
import {
  PRESET_HOURS,
  PRESET_MINUTES,
  buildCronFromFriendly,
  formatClock,
  parseCronToFriendly,
  type ScheduleKind,
} from "@/lib/cronFriendly";

const HOURS = Array.from({ length: 24 }, (_, i) => i);
const MINUTE_OPTIONS = Array.from({ length: 12 }, (_, i) => i * 5);

export function formatScheduleSummary(
  t: (key: string) => string,
  cronExpr: string,
  timezone?: string,
): string {
  const f = parseCronToFriendly(cronExpr);
  const tz = timezone ? ` · ${timezone.replace(/_/g, " ")}` : "";
  switch (f.kind) {
    case "every_minutes":
      return (
        (f.minute === 60
          ? t("admin.scheduleEveryHour")
          : t("admin.scheduleEveryNMinutes").replace("{n}", String(f.minute))) + tz
      );
    case "every_hours":
      return (
        (f.hour === 1
          ? t("admin.scheduleEveryHour")
          : t("admin.scheduleEveryNHours").replace("{n}", String(f.hour))) +
        ` (:${String(f.minute).padStart(2, "0")})${tz}`
      );
    case "daily":
      return `${t("admin.scheduleDaily")} · ${formatClock(f.hour, f.minute)}${tz}`;
    case "weekdays":
      return `${t("admin.scheduleWeekdays")} · ${formatClock(f.hour, f.minute)}${tz}`;
    default:
      return cronExpr.trim() || "—";
  }
}

export function ScheduleEditor({
  value,
  timezone,
  disabled,
  onChange,
  onSave,
  onCancel,
  dirty,
}: {
  value: string;
  timezone: string;
  disabled?: boolean;
  dirty: boolean;
  onChange: (cronExpr: string) => void;
  onSave: () => void;
  onCancel?: () => void;
}) {
  const { t } = useI18n();
  const [advanced, setAdvanced] = useState(false);
  const parsed = useMemo(() => parseCronToFriendly(value), [value]);
  const kindValue = advanced || parsed.kind === "custom" ? "custom" : parsed.kind;

  function setKind(kind: ScheduleKind) {
    if (kind === "custom") {
      setAdvanced(true);
      onChange(value);
      return;
    }
    onChange(
      buildCronFromFriendly({
        kind,
        minute:
          kind === "every_minutes"
            ? parsed.kind === "every_minutes"
              ? parsed.minute
              : 30
            : parsed.kind === "every_minutes"
              ? 0
              : parsed.minute || 0,
        hour:
          kind === "every_hours"
            ? parsed.kind === "every_hours"
              ? parsed.hour
              : 6
            : parsed.kind === "every_hours" || parsed.kind === "every_minutes"
              ? 3
              : parsed.hour || 3,
      }),
    );
    setAdvanced(false);
  }

  function patchFriendly(partial: { minute?: number; hour?: number; kind?: ScheduleKind }) {
    const kind = partial.kind ?? (parsed.kind === "custom" ? "daily" : parsed.kind);
    onChange(
      buildCronFromFriendly({
        kind,
        minute: partial.minute ?? parsed.minute,
        hour: partial.hour ?? parsed.hour,
      }),
    );
  }

  const minuteValue =
    parsed.kind === "daily" || parsed.kind === "weekdays" || parsed.kind === "every_hours"
      ? parsed.minute
      : 0;
  const hourValue =
    parsed.kind === "daily" || parsed.kind === "weekdays" ? parsed.hour : 3;

  return (
    <div className="schedule-editor">
      <div className="filter-panel-grid">
        <SingleSelect
          label={t("admin.scheduleHowOften")}
          disabled={disabled}
          value={kindValue}
          onChange={(next) => setKind(next as ScheduleKind)}
          options={[
            { value: "every_minutes", label: t("admin.scheduleEveryMinutes") },
            { value: "every_hours", label: t("admin.scheduleEveryHours") },
            { value: "daily", label: t("admin.scheduleDaily") },
            { value: "weekdays", label: t("admin.scheduleWeekdays") },
            { value: "custom", label: t("admin.scheduleCustom") },
          ]}
        />

        {kindValue === "every_minutes" ? (
          <SingleSelect
            label={t("admin.scheduleInterval")}
            disabled={disabled}
            value={String(parsed.kind === "every_minutes" ? parsed.minute : 30)}
            onChange={(next) =>
              patchFriendly({ kind: "every_minutes", minute: Number(next) })
            }
            options={PRESET_MINUTES.map((m) => ({
              value: String(m),
              label:
                m === 60
                  ? t("admin.scheduleEveryHour")
                  : t("admin.scheduleEveryNMinutes").replace("{n}", String(m)),
            }))}
          />
        ) : null}

        {kindValue === "every_hours" ? (
          <>
            <SingleSelect
              label={t("admin.scheduleInterval")}
              disabled={disabled}
              value={String(parsed.kind === "every_hours" ? parsed.hour : 6)}
              onChange={(next) =>
                patchFriendly({ kind: "every_hours", hour: Number(next) })
              }
              options={PRESET_HOURS.map((h) => ({
                value: String(h),
                label:
                  h === 1
                    ? t("admin.scheduleEveryHour")
                    : t("admin.scheduleEveryNHours").replace("{n}", String(h)),
              }))}
            />
            <SingleSelect
              label={t("admin.scheduleAtMinute")}
              disabled={disabled}
              value={String(parsed.kind === "custom" ? 0 : parsed.minute || 0)}
              onChange={(next) =>
                patchFriendly({ kind: "every_hours", minute: Number(next) })
              }
              options={[0, 5, 10, 15, 20, 30, 40, 45, 50].map((m) => ({
                value: String(m),
                label: `:${String(m).padStart(2, "0")}`,
              }))}
            />
          </>
        ) : null}

        {kindValue === "daily" || kindValue === "weekdays" ? (
          <>
            <SingleSelect
              label={t("admin.scheduleHour")}
              disabled={disabled}
              value={String(hourValue)}
              onChange={(next) =>
                patchFriendly({ kind: kindValue, hour: Number(next) })
              }
              options={HOURS.map((h) => ({
                value: String(h),
                label: String(h).padStart(2, "0"),
              }))}
            />
            <SingleSelect
              label={t("admin.scheduleMinute")}
              disabled={disabled}
              value={String(minuteValue)}
              onChange={(next) =>
                patchFriendly({ kind: kindValue, minute: Number(next) })
              }
              options={[
                ...MINUTE_OPTIONS.map((m) => ({
                  value: String(m),
                  label: String(m).padStart(2, "0"),
                })),
                ...(minuteValue % 5 !== 0
                  ? [{ value: String(minuteValue), label: String(minuteValue).padStart(2, "0") }]
                  : []),
              ]}
            />
          </>
        ) : null}

        {kindValue === "custom" || advanced ? (
          <label className="ui-field ui-field-span-2">
            <span className="ui-field-label">{t("admin.scheduleAdvancedCron")}</span>
            <input
              className="ui-text-input mono"
              value={value}
              disabled={disabled}
              onChange={(e) => onChange(e.target.value)}
              spellCheck={false}
            />
          </label>
        ) : (
          <div className="filter-panel-actions">
            <button
              type="button"
              className="btn ghost"
              disabled={disabled}
              onClick={() => {
                setAdvanced(true);
                setKind("custom");
              }}
            >
              {t("admin.scheduleShowAdvanced")}
            </button>
          </div>
        )}
      </div>

      <div className="schedule-editor-footer">
        <span className="row-meta">{formatScheduleSummary(t, value, timezone)}</span>
        <div className="schedule-editor-actions">
          {onCancel ? (
            <button type="button" className="btn ghost" disabled={disabled} onClick={onCancel}>
              {t("admin.cancelEditSchedule")}
            </button>
          ) : null}
          <button
            type="button"
            className="btn"
            disabled={disabled || !dirty}
            onClick={onSave}
          >
            {t("admin.saveSchedule")}
          </button>
        </div>
      </div>
    </div>
  );
}
