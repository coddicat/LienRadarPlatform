"use client";

import { useEffect, useId, useRef, useState } from "react";

export type SelectOption = {
  value: string;
  label: string;
};

export function MultiSelect({
  label,
  options,
  value,
  onChange,
  placeholder,
  allLabel,
  clearLabel,
  disabled,
}: {
  label: string;
  options: SelectOption[];
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  allLabel?: string;
  clearLabel?: string;
  disabled?: boolean;
}) {
  const id = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const selectedLabels = options.filter((o) => value.includes(o.value)).map((o) => o.label);
  const summary =
    selectedLabels.length === 0
      ? allLabel ?? placeholder ?? "Any"
      : selectedLabels.length <= 2
        ? selectedLabels.join(", ")
        : `${selectedLabels.length} selected`;

  function toggle(optionValue: string) {
    if (value.includes(optionValue)) onChange(value.filter((v) => v !== optionValue));
    else onChange([...value, optionValue]);
  }

  return (
    <div className={`ui-field ${open ? "is-open" : ""}`} ref={rootRef}>
      <label className="ui-field-label" htmlFor={id}>
        {label}
      </label>
      <button
        id={id}
        type="button"
        className={`ui-select-trigger ${value.length ? "has-value" : ""}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="ui-select-value">{summary}</span>
        <span className="ui-select-caret" aria-hidden>
          ▾
        </span>
      </button>
      {open ? (
        <div className="ui-select-menu" role="listbox" aria-multiselectable>
          <div className="ui-select-menu-head">
            <button
              type="button"
              className="btn ghost"
              onClick={() => onChange([])}
              disabled={value.length === 0}
            >
              {clearLabel ?? allLabel ?? "Clear"}
            </button>
          </div>
          <ul className="ui-select-options">
            {options.map((opt) => {
              const checked = value.includes(opt.value);
              return (
                <li key={opt.value}>
                  <label className={`ui-check-option ${checked ? "is-checked" : ""}`}>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggle(opt.value)}
                    />
                    <span>{opt.label}</span>
                  </label>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

export function SingleSelect({
  label,
  options,
  value,
  onChange,
  disabled,
}: {
  label: string;
  options: SelectOption[];
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
}) {
  const id = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const current = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className={`ui-field ${open ? "is-open" : ""}`} ref={rootRef}>
      <label className="ui-field-label" htmlFor={id}>
        {label}
      </label>
      <button
        id={id}
        type="button"
        className="ui-select-trigger has-value"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="ui-select-value">{current?.label ?? value}</span>
        <span className="ui-select-caret" aria-hidden>
          ▾
        </span>
      </button>
      {open ? (
        <div className="ui-select-menu" role="listbox">
          <ul className="ui-select-options">
            {options.map((opt) => {
              const active = opt.value === value;
              return (
                <li key={opt.value}>
                  <button
                    type="button"
                    className={`ui-radio-option ${active ? "is-checked" : ""}`}
                    role="option"
                    aria-selected={active}
                    onClick={() => {
                      onChange(opt.value);
                      setOpen(false);
                    }}
                  >
                    <span className="ui-radio-mark" aria-hidden />
                    <span>{opt.label}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
