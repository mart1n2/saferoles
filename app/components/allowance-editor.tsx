import type { DraftAllowance } from "../lib/policy";
export function AllowanceEditor({
  allowance,
  onChange,
  onRemove,
}: {
  allowance: DraftAllowance;
  onChange: (update: (allowance: DraftAllowance) => DraftAllowance) => void;
  onRemove: () => void;
}) {
  const set = (field: keyof DraftAllowance) => (value: string) =>
    onChange((current) => ({ ...current, [field]: value }));

  const periodHours = Number(allowance.period) / 3600;

  return (
    <article className="allowance-card editable">
      <div className="allowance-head">
        <input
          className="mono-input"
          value={allowance.key}
          placeholder="allowance_key"
          aria-label="Allowance key"
          onChange={(event) => set("key")(event.target.value)}
        />
        <button className="row-remove" aria-label="Remove allowance" onClick={onRemove}>×</button>
      </div>
      <div className="allowance-grid-fields">
        <label>
          <span>Available now</span>
          <input
            className="mono-input"
            value={allowance.balance}
            onChange={(event) => set("balance")(event.target.value)}
          />
          <small>Current unspent budget. Raising this is a deliberate top-up.</small>
        </label>
        <label>
          <span>Ceiling</span>
          <input
            className="mono-input"
            value={allowance.maxRefill}
            onChange={(event) => set("maxRefill")(event.target.value)}
          />
          <small>The most the budget can ever hold.</small>
        </label>
        <label>
          <span>Refill amount</span>
          <input
            className="mono-input"
            value={allowance.refill}
            onChange={(event) => set("refill")(event.target.value)}
          />
          <small>Added each period, capped at the ceiling.</small>
        </label>
        <label>
          <span>Period (seconds)</span>
          <input
            className="mono-input"
            value={allowance.period}
            onChange={(event) => set("period")(event.target.value)}
          />
          <small>
            {Number.isFinite(periodHours) && periodHours > 0
              ? `${periodHours} hour${periodHours === 1 ? "" : "s"}`
              : "0 means a one-time budget that never refills."}
          </small>
        </label>
      </div>
    </article>
  );
}

