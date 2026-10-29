import { useState } from "react";
import { useLocalContracts } from "../lib/use-local-contracts";

/** Name an address by saving it to the same local list as Roles config → Contracts. */
export function NameEditor({ chainId, address, hasLabel }: { chainId: number; address: string; hasLabel: boolean }) {
  const contracts = useLocalContracts(chainId);
  const [naming, setNaming] = useState(false);
  const [draft, setDraft] = useState("");
  const save = () => {
    const label = draft.trim();
    if (!label) return;
    void contracts.add(address, label).then(() => setNaming(false)).catch(() => {});
  };
  if (!naming) {
    return <button type="button" className="address-action" onClick={() => { setDraft(""); setNaming(true); }}>{hasLabel ? "Rename" : "Name it"}</button>;
  }
  return (
    <span className="name-editor">
      <input
        aria-label={`Name for ${address}`}
        value={draft}
        maxLength={256}
        autoFocus
        placeholder="e.g. Aave pool"
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") { event.preventDefault(); save(); }
          if (event.key === "Escape") { event.stopPropagation(); setNaming(false); }
        }}
      />
      <button type="button" className="address-action" disabled={!draft.trim() || contracts.busy} onClick={save}>Save</button>
      <button type="button" className="address-action" onClick={() => setNaming(false)}>Cancel</button>
      {contracts.error && <small className="error-text">{contracts.error}</small>}
    </span>
  );
}
