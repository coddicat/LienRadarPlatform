"use client";

export function SearchBar({
  id,
  label,
  value,
  placeholder,
  onChange,
  onClear,
}: {
  id?: string;
  label?: string;
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
  onClear?: () => void;
}) {
  return (
    <div className="search-bar">
      {label ? <label htmlFor={id}>{label}</label> : null}
      <div className="search-bar-shell">
        <span className="search-bar-icon" aria-hidden>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
            <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" />
            <path d="M20 20l-3.5-3.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </span>
        <input
          id={id}
          type="search"
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          autoComplete="off"
        />
        {value ? (
          <button
            type="button"
            className="search-bar-clear"
            aria-label="Clear"
            onClick={() => {
              onChange("");
              onClear?.();
            }}
          >
            ×
          </button>
        ) : null}
      </div>
    </div>
  );
}
