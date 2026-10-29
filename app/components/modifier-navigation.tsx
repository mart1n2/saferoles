import { chainName } from "../lib/chains";
import { AddressText } from "./address-link";

/** The workspace identity stays together, independent of the connected wallet. */
export function ModifierNavigation({ address, safeAddress, chainId, active, onOpen, onSwitch }: {
  address: string;
  safeAddress: string | null;
  chainId: number;
  active: boolean;
  onOpen: () => void;
  onSwitch: () => void;
}) {
  return <nav className="modifier-navigation" aria-label="Modifier configuration">
    <div className={`modifier-card ${active ? "active" : ""}`}>
      <button type="button" className="card-open modifier-open" aria-label="Roles config" aria-current={active ? "page" : undefined} onClick={onOpen} />
      <span className="modifier-card-heading">
        <span className="role-glyph" aria-hidden="true">⚙</span>
        <span><b>Roles config</b><small>Shared across all roles</small></span>
        <span className="modifier-card-arrow" aria-hidden="true">→</span>
      </span>
      <span className="modifier-card-identity">
        <span><span>Network</span><b>{chainName(chainId)}</b></span>
        <span><span>Roles</span><AddressText chainId={chainId} address={address} /></span>
        <span><span>Safe</span>{safeAddress ? <AddressText chainId={chainId} address={safeAddress} /> : <code>Unavailable</code>}</span>
      </span>
      <button type="button" className="card-switch" onClick={onSwitch}>Switch Safe or modifier</button>
    </div>
  </nav>;
}
