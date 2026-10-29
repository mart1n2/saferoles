import { shortHex } from "../lib/abi";
import { chainName } from "../lib/chains";

/** The workspace identity stays together, independent of the connected wallet. */
export function ModifierNavigation({ address, safeAddress, chainId, active, onOpen }: {
  address: string;
  safeAddress: string | null;
  chainId: number;
  active: boolean;
  onOpen: () => void;
}) {
  return <nav className="modifier-navigation" aria-label="Modifier configuration">
    <button type="button" className={`modifier-card ${active ? "active" : ""}`} aria-label="Roles config" aria-current={active ? "page" : undefined} onClick={onOpen}>
      <span className="modifier-card-heading">
        <span className="role-glyph" aria-hidden="true">⚙</span>
        <span><b>Roles config</b><small>Shared across all roles</small></span>
        <span className="modifier-card-arrow" aria-hidden="true">→</span>
      </span>
      <span className="modifier-card-identity">
        <span><span>Network</span><b>{chainName(chainId)}</b></span>
        <span><span>Roles</span><code title={address}>{shortHex(address, 6, 4)}</code></span>
        <span><span>Safe</span><code title={safeAddress ?? undefined}>{safeAddress ? shortHex(safeAddress, 6, 4) : "Unavailable"}</code></span>
      </span>
    </button>
  </nav>;
}
