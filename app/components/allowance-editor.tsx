import { useState } from "react";
import { formatUnits } from "ethers";
import type { DraftAllowance } from "../lib/policy";

const periods = [
  { label: "Hourly", every: "hour", seconds: "3600" },
  { label: "Daily", every: "day", seconds: "86400" },
  { label: "Weekly", every: "week", seconds: "604800" },
  { label: "30 days", every: "30 days", seconds: "2592000" },
  { label: "One-time", every: "", seconds: "0" },
];

/** "1,000" for a raw base-unit amount, or null when it is not a plain integer. */
function readable(raw: string, decimals: number): string | null {
  if (!/^\d+$/.test(raw.trim())) return null;
  try {
    const [whole, fraction] = formatUnits(BigInt(raw.trim()), decimals).split(".");
    const grouped = whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return fraction && fraction !== "0" ? `${grouped}.${fraction}` : grouped;
  } catch {
    return null;
  }
}

function describePeriod(period: string): string {
  const seconds = Number(period);
  if (!Number.isFinite(seconds) || seconds < 0) return "Enter a number of seconds.";
  if (seconds === 0) return "One-time budget: it never refills.";
  const preset = periods.find((item) => item.seconds === period);
  if (preset?.every) return `Refills every ${preset.every}.`;
  const hours = seconds / 3600;
  return hours >= 1 ? `Refills every ${hours} hour${hours === 1 ? "" : "s"}.` : `Refills every ${seconds} seconds.`;
}

export function AllowanceEditor({
  allowance,
  usedBy,
  onChange,
  onRemove,
}: {
  allowance: DraftAllowance;
  /** Permissions whose conditions draw on this allowance. */
  usedBy: string[];
  onChange: (update: (allowance: DraftAllowance) => DraftAllowance) => void;
  onRemove: () => void;
}) {
  const [decimalsText, setDecimalsText] = useState("6");
  const set = (field: keyof DraftAllowance) => (value: string) =>
    onChange((current) => ({ ...current, [field]: value }));
  const decimals = Math.min(36, Math.max(0, Number.parseInt(decimalsText, 10) || 0));

  const amount = (field: "balance" | "maxRefill" | "refill", label: string, help: string) => {
    const shown = readable(allowance[field], decimals);
    return (
      <label>
        <span>{label}</span>
        <input
          className="mono-input"
          inputMode="numeric"
          value={allowance[field]}
          onChange={(event) => set(field)(event.target.value.trim())}
        />
        <small>{help}</small>
        {shown !== null && <small className="amount-preview">= {shown} tokens at {decimals} decimals</small>}
        {allowance[field] !== "" && shown === null && (
          <small className="error-text">Whole number in the token&apos;s smallest unit, no decimals or commas.</small>
        )}
      </label>
    );
  };

  return (
    <article className="allowance-card editable">
      <div className="allowance-head">
        <input
          className="mono-input"
          value={allowance.key}
          placeholder="Name it, e.g. usdc_daily"
          aria-label="Allowance key"
          onChange={(event) => set("key")(event.target.value)}
        />
        <button className="row-remove" aria-label="Remove allowance" title="Remove allowance" onClick={onRemove}>×</button>
      </div>
      <p className="allowance-usage">
        {usedBy.length > 0
          ? <>Used by: {usedBy.join(", ")}.</>
          : <>Not used yet. In a permission&apos;s parameter conditions, choose <b>Within allowance</b> and pick this one; each call then spends from it.</>}
      </p>
      <label className="allowance-decimals">
        <span>Token decimals</span>
        <input
          inputMode="numeric"
          aria-label="Token decimals for the amount previews"
          value={decimalsText}
          onChange={(event) => setDecimalsText(event.target.value)}
        />
        <small>Only for the previews below. USDC and USDT use 6, DAI and ETH use 18.</small>
      </label>
      <div className="allowance-grid-fields">
        {amount("balance", "Available now", "Unspent budget at this moment. Raising it is a deliberate top-up.")}
        {amount("maxRefill", "Ceiling", "The most the budget can hold; refilling stops here.")}
        {amount("refill", "Refill amount", "Added each period, never above the ceiling.")}
        <label>
          <span>Period (seconds)</span>
          <input
            className="mono-input"
            inputMode="numeric"
            value={allowance.period}
            onChange={(event) => set("period")(event.target.value.trim())}
          />
          <small>{describePeriod(allowance.period)}</small>
          <span className="period-presets">
            {periods.map((item) => (
              <button
                key={item.label}
                type="button"
                className={allowance.period === item.seconds ? "chip active" : "chip"}
                onClick={() => set("period")(item.seconds)}
              >
                {item.label}
              </button>
            ))}
          </span>
        </label>
      </div>
    </article>
  );
}
