import { allowanceBaseUnits, allowanceDisplayAmount, withAllowanceDecimals, editAllowanceAmount, hasCustomInitialBalance } from "../lib/allowance-amounts";
import type { DraftAllowance } from "../lib/policy";

const periods = [
  { label: "Hourly", every: "hour", seconds: "3600" },
  { label: "Daily", every: "day", seconds: "86400" },
  { label: "Weekly", every: "week", seconds: "604800" },
  { label: "30 days", every: "30 days", seconds: "2592000" },
  { label: "One-time", every: "", seconds: "0" },
];

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
  existing = false,
  usedBy,
  onChange,
  onRemove,
}: {
  allowance: DraftAllowance;
  existing?: boolean;
  /** Permissions whose conditions draw on this allowance. */
  usedBy: string[];
  onChange: (update: (allowance: DraftAllowance) => DraftAllowance) => void;
  onRemove: () => void;
}) {
  const set = (field: keyof DraftAllowance) => (value: string) =>
    onChange((current) => ({ ...current, [field]: value }));
  const decimals = allowance.amountDecimals ?? 6;
  const customInitialBalance = hasCustomInitialBalance(allowance);

  const amount = (field: "balance" | "maxRefill" | "refill", label: string, help: string) => {
    const shown = allowanceDisplayAmount(allowance, field, decimals);
    let raw: string | null = null;
    try { raw = allowanceBaseUnits(shown, decimals).toString(); } catch { /* Keep incomplete input editable. */ }
    return (
      <label>
        <span>{label}</span>
        <input
          className="mono-input"
          inputMode="decimal"
          aria-label={label}
          value={shown}
          onChange={(event) => {
            const value = event.target.value;
            onChange((current) => editAllowanceAmount(current, field, value, decimals, existing));
          }}
        />
        <small>{help}</small>
        {raw !== null && <small className="amount-preview">On-chain integer: {raw}</small>}
        {shown !== "" && raw === null && (
          <small className="error-text">Enter a non-negative amount with up to {decimals} decimal places, within the on-chain limit.</small>
        )}
      </label>
    );
  };

  return (
    <article className="allowance-card editable">
      <div className="allowance-head">
        <label className="allowance-name-field">
          <span>Allowance name</span>
        <input
          className="mono-input"
          value={allowance.key}
          placeholder="e.g. usdc_daily"
          aria-label="Allowance name"
          onChange={(event) => set("key")(event.target.value)}
        />
          <small>Use this name to select the shared budget in a permission condition.</small>
        </label>
        <button type="button" className="remove-permission" title="Remove this allowance. You can undo until your next edit." onClick={onRemove}>Remove allowance</button>
      </div>
      <p className="allowance-usage">
        {usedBy.length > 0
          ? <>Used by: {usedBy.join(", ")}.</>
          : <>Not used yet. In a permission&apos;s parameter conditions, choose <b>Within allowance</b> and pick this one; each call then spends from it.</>}
      </p>
      <p className="allowance-usage">This is a cumulative budget shared across calls, permissions and members that use it. Each matching call deducts its amount from the same budget.</p>
      <label className="allowance-decimals">
        <span>Token decimals</span>
        <select aria-label="Token decimals" value={decimals} onChange={(event) => onChange((current) => withAllowanceDecimals(current, Number(event.target.value)))}>
          {Array.from({ length: 37 }, (_, value) => <option key={value} value={value}>{value}</option>)}
        </select>
        <small>Enter token quantities below: 1000 means 1,000 tokens. USDC uses 6 decimals; DAI and ETH use 18. Changing decimals preserves existing on-chain quantities.</small>
      </label>
      <div className="allowance-grid-fields">
        {amount("maxRefill", "Budget ceiling", "Maximum shared budget accumulated across calls. Unspent budget carries over up to this cap.")}
        {amount("refill", "Refill per period", "Added to the remaining shared budget for each elapsed period, up to the ceiling. Use 0 for a one-time budget.")}
        <label>
          <span>Period (seconds)</span>
          <input
            className="mono-input"
            inputMode="numeric"
            aria-label="Period (seconds)"
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
      <p className="allowance-balance-summary">
        {existing
          ? <>Saved remaining budget: <b>{allowanceDisplayAmount(allowance, "balance", decimals)}</b>. This loaded snapshot may exclude later spending or accrued refills. Changing the ceiling preserves this balance.</>
          : <>Initial budget: <b>{allowanceDisplayAmount(allowance, "balance", decimals) || "—"}</b>{customInitialBalance ? " (custom)." : " — starts at the ceiling."}</>}
      </p>
      <details className="allowance-advanced">
        <summary>Advanced settings</summary>
        {existing ? amount("balance", "Set remaining budget", "Explicitly replaces the saved remaining balance. Raising it tops up the shared budget; lowering it removes available budget. Must not exceed the ceiling.") : <>
          <label className="allowance-custom-toggle">
            <input type="checkbox" checked={customInitialBalance} onChange={(event) => {
              const checked = event.target.checked;
              onChange((current) => ({ ...current, customInitialBalance: checked, balance: checked ? current.balance : current.maxRefill }));
            }} />
            Use a custom initial budget
          </label>
          {customInitialBalance && amount("balance", "Initial budget", "Shared budget available at creation. Must not exceed the ceiling; future periods refill it normally.")}
        </>}
      </details>
    </article>
  );
}
