import { useEffect, useMemo, useState } from "react";
import { isAddress } from "ethers";
import { parseSignature, shortHex } from "./lib/abi";
import { useAbi } from "./lib/use-abi";
import { useContractLabel } from "./lib/use-contract-label";
import { useTokenMetadata } from "./lib/use-token-metadata";
import { useLocalContracts } from "./lib/use-local-contracts";
import { normalizeContractAddress } from "./lib/contract-labels";
import { ContractName } from "./components/contract-name";
import { FunctionPicker } from "./components/function-picker";
import type { ResolvedAbi } from "./lib/abi-source";
import { conditionOperatorHelp, conditionOperatorLabels, conditionOperators, isValuelessOperator, type ConditionOperator, type DraftAllowance, type DraftPermission } from "./lib/policy";
import { adoptSignature } from "./lib/policy-codec";
import { draftPermissionRisk, riskReason } from "./lib/policy-plan";
const nextId = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;

/** The best readable form of a permission's function, given a resolved ABI. */
function readableFor(
  permission: DraftPermission,
  abi: ResolvedAbi | null,
): string {
  const declared = abi?.functions.find(
    (entry) => entry.signature === permission.signature,
  );
  return declared?.readable ?? permission.signatureLabel ?? permission.signature;
}

export function PermissionInspector({
  permission,
  allowances,
  chainId,
  selectorNames,
  onChange,
  onRemove,
}: {
  permission: DraftPermission;
  allowances: DraftAllowance[];
  chainId: number;
  selectorNames: Record<string, string[]>;
  onChange: (update: (permission: DraftPermission) => DraftPermission) => void;
  onRemove: () => void;
}) {
  const risk = draftPermissionRisk(permission);
  const [signatureDraft, setSignatureDraft] = useState("");
  const [adoptNote, setAdoptNote] = useState<string | null>(null);
  const [showManualAbi, setShowManualAbi] = useState(false);
  const [manualAbi, setManualAbi] = useState("");
  const [manualError, setManualError] = useState<string | null>(null);

  const abi = useAbi(chainId, permission.targetAddress);
  const contractLabel = useContractLabel(chainId, permission.targetAddress);
  const token = useTokenMetadata(chainId, permission.targetAddress);
  const savedContracts = useLocalContracts(chainId);
  const labelValue = contractLabel.value ?? permission.name;
  const automaticName = (token.data?.hasSymbol ? token.data.symbol : null) || abi.abi?.name;

  // An imported permission is identified only by selector; the signature has to
  // be supplied and verified before its condition can be shown or edited.
  const needsSignature = Boolean(permission.selector && !permission.signature);

  // The ABI is the strongest evidence for an imported selector: a signature
  // taken from it hashes to that selector by construction.
  const abiMatch = useMemo(() => {
    if (!needsSignature || !permission.selector || !abi.abi) return null;
    return (
      abi.abi.functions.find(
        (entry) => entry.selector.toLowerCase() === permission.selector!.toLowerCase(),
      ) ?? null
    );
  }, [abi.abi, needsSignature, permission.selector]);

  useEffect(() => {
    if (!abiMatch) return;
    // Deferred out of the effect body. Adopting clears `selector`, so `abiMatch`
    // becomes null on the next pass and this settles after one adoption.
    const timer = setTimeout(() => {
      const result = adoptSignature(permission, abiMatch.signature);
      if (result.permission.signature) {
        setAdoptNote(result.editable ? null : (result.note ?? null));
        onChange(() => result.permission);
      }
    }, 0);
    return () => clearTimeout(timer);
  }, [abiMatch, onChange, permission]);

  const candidates = permission.selector
    ? (selectorNames[permission.selector.toLowerCase()] ?? [])
    : [];

  // Parameter names and types for labelling the condition rows.
  //
  // The ABI is preferred over the signature: a canonical signature carries only
  // types, so `vault`/`minOut` would degrade to `arg0`/`arg1` without it.
  const params = useMemo(() => {
    if (!permission.signature) return null;

    const declared = abi.abi?.functions.find(
      (entry) => entry.signature === permission.signature,
    );
    if (declared) {
      return declared.inputs.map((input, index) => ({
        index,
        label: input.name,
        type: input.type,
      }));
    }

    try {
      return parseSignature(permission.signature).params.map((param, index) => ({
        index,
        label: param.name || `arg${index}`,
        type: param.type,
      }));
    } catch {
      return null;
    }
  }, [abi.abi, permission.signature]);

  async function submitManualAbi() {
    setManualError(null);
    try {
      await abi.saveManual(manualAbi);
      setShowManualAbi(false);
      setManualAbi("");
    } catch (error) {
      setManualError(error instanceof Error ? error.message : "That ABI was rejected.");
    }
  }

  return (
    <>
      <div className="inspector-heading">
        <div>
          <span className="eyebrow">Permission</span>
          <h3>{labelValue.trim() || automaticName || shortHex(permission.targetAddress) || "New permission"}</h3>
        </div>
        <span className={`risk-badge ${risk.toLowerCase()}`}>{risk}</span>
      </div>

      {savedContracts.contracts.length > 0 && <label className="saved-contract-picker">
        <span>Saved contract</span>
        <select aria-label="Saved contract" value={savedContracts.contracts.find((entry) => entry.address.toLowerCase() === permission.targetAddress.toLowerCase())?.address ?? ""} onChange={(event) => {
          if (!event.target.value) return;
          const targetAddress = event.target.value;
          onChange((current) => ({ ...current, targetAddress, name: "" }));
        }}>
          <option value="">Choose from your local whitelist</option>
          {savedContracts.contracts.map((entry) => <option value={entry.address} key={entry.address}><ContractName chainId={chainId} address={entry.address} label={entry.label}/> · {shortHex(entry.address)}</option>)}
        </select>
        <small>Manage this list in Roles config → Contracts. Selecting an address does not submit a permission.</small>
      </label>}
      <div className="field-grid">
        <label>
          <span>Contract label <small>(optional)</small></span>
          <input
            aria-label="Contract label"
            maxLength={256}
            value={labelValue}
            placeholder={automaticName || "e.g. Treasury vault"}
            onChange={(event) => {
              const value = event.target.value;
              onChange((current) => ({ ...current, name: value }));
              contractLabel.save(value);
            }}
          />
          <small className={contractLabel.error ? "error-text" : undefined} role={contractLabel.error ? "alert" : undefined}>
            {contractLabel.error || (contractLabel.saving ? "Saving label locally…" : !isAddress(permission.targetAddress.toLowerCase()) ? "Enter a valid target address to save this label locally." : "Custom labels are saved in this browser for this network and contract, including after submission. Leave empty to use the token symbol or verified name.")}
          </small>
        </label>
        <label>
          <span>Target address</span>
          <input
            className="mono-input"
            value={permission.targetAddress}
            placeholder="0x…"
            onChange={(event) => {
              const value = event.target.value.trim();
              const changedTarget = isAddress(permission.targetAddress.toLowerCase()) && value.toLowerCase() !== permission.targetAddress.toLowerCase();
              onChange((current) => ({ ...current, targetAddress: value, name: changedTarget ? "" : current.name }));
              if (!changedTarget && isAddress(value.toLowerCase()) && permission.name.trim()) contractLabel.save(permission.name, value);
            }}
            onBlur={() => {
              try {
                const targetAddress = normalizeContractAddress(permission.targetAddress);
                if (targetAddress !== permission.targetAddress) onChange((current) => ({ ...current, targetAddress }));
              } catch { /* Leave incomplete addresses editable. */ }
            }}
          />
          {permission.targetAddress && !isAddress(permission.targetAddress.toLowerCase()) && (
            <small className="error-text">Enter a complete 20-byte address.</small>
          )}
          <AbiStatusLine
            abi={abi}
            onPaste={() => setShowManualAbi(true)}
            onForget={() => void abi.forget()}
          />
        </label>
        <label>
          <span>Scope</span>
          <select
            value={permission.mode}
            onChange={(event) =>
              onChange((current) => ({
                ...current,
                mode: event.target.value as DraftPermission["mode"],
              }))
            }
          >
            <option value="function">One function</option>
            <option value="target">Entire contract</option>
          </select>
        </label>
        <div className="checkbox-field">
          <span>Execution</span>
          <label className="check">
            <input
              type="checkbox"
              checked={permission.send}
              onChange={(event) =>
                onChange((current) => ({ ...current, send: event.target.checked }))
              }
            />
            May send value
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={permission.delegatecall}
              onChange={(event) =>
                onChange((current) => ({ ...current, delegatecall: event.target.checked }))
              }
            />
            May delegatecall
          </label>
          <small className="field-help">
            <b>Send value</b> lets the call attach ETH. Leave it off for token calls such as
            transfer or approve. <b>Delegatecall</b> runs the target&apos;s code with the Safe&apos;s
            own storage and balances; it is critical risk and SafeRoles will not submit it.
          </small>
        </div>

        {permission.mode === "function" && (
          <label className="span-2">
            <span>Function</span>

            {/* With an ABI, functions are chosen from what the contract actually
                declares rather than typed from memory. */}
            {abi.abi && abi.abi.functions.length > 0 && (
              <FunctionPicker
                functions={abi.abi.functions}
                value={permission.signature}
                onSelect={(declared) => {
                  setAdoptNote(null);
                  onChange((current) => ({
                    ...current,
                    signature: declared.signature,
                    // Display only; the canonical signature above is what encodes.
                    signatureLabel: declared.readable,
                    selector: undefined,
                    rawCondition: undefined,
                    // Conditions are positional, so they cannot carry over to a
                    // different function's parameter list.
                    conditions: current.signature === declared.signature ? current.conditions : [],
                  }));
                }}
              />
            )}

            {needsSignature && !abi.abi && (
              <>
                {candidates.length > 0 && (
                  <div className="candidate-list">
                    <small>
                      {candidates.length === 1
                        ? "One known signature hashes to this selector:"
                        : `${candidates.length} signatures hash to this selector — a selector is a truncated hash, so pick the one this contract actually declares:`}
                    </small>
                    {candidates.map((candidate) => (
                      <button
                        key={candidate}
                        className="button secondary"
                        onClick={() => {
                          const result = adoptSignature(permission, candidate);
                          setAdoptNote(result.note ?? null);
                          if (result.permission.signature) onChange(() => result.permission);
                        }}
                      >
                        {candidate}
                      </button>
                    ))}
                  </div>
                )}
                <div className="adopt-row">
                  <input
                    className="mono-input"
                    value={signatureDraft}
                    placeholder="transfer(address,uint256)"
                    onChange={(event) => setSignatureDraft(event.target.value)}
                  />
                  <button
                    className="button secondary"
                    onClick={() => {
                      const result = adoptSignature(permission, signatureDraft);
                      setAdoptNote(result.note ?? null);
                      if (result.permission.signature) onChange(() => result.permission);
                    }}
                  >
                    Verify
                  </button>
                </div>
                <small>
                  Deployed as selector <code>{permission.selector}</code>. The modifier stores
                  only the selector, so any signature is checked against it before use.
                </small>
              </>
            )}

            {!needsSignature && !abi.abi && (
              <input
                className="mono-input"
                value={permission.signature}
                placeholder="transfer(address,uint256)"
                onChange={(event) =>
                  onChange((current) => ({ ...current, signature: event.target.value }))
                }
              />
            )}

            {permission.signature && (
              <small className="mono-note">
                <code>{readableFor(permission, abi.abi)}</code>
                {params && params.length > 0
                  ? ` · ${params.map((param) => `${param.label}: ${param.type}`).join(", ")}`
                  : " · no parameters"}
              </small>
            )}
            {adoptNote && <small className="error-text">{adoptNote}</small>}
          </label>
        )}
      </div>

      {showManualAbi && (
        <div className="manual-abi">
          <div className="section-label">
            <div>
              <b>Paste an ABI</b>
              <span>Stored for this contract on this chain, and reused next time</span>
            </div>
            <button onClick={() => setShowManualAbi(false)}>Cancel</button>
          </div>
          <textarea
            className="mono-input"
            rows={6}
            value={manualAbi}
            placeholder={'[{"type":"function","name":"transfer",…}]\n\nor one signature per line:\nfunction transfer(address to, uint256 amount)'}
            onChange={(event) => setManualAbi(event.target.value)}
          />
          {manualError && <small className="error-text">{manualError}</small>}
          <button
            className="button primary"
            disabled={!manualAbi.trim()}
            onClick={() => void submitManualAbi()}
          >
            Use this ABI
          </button>
        </div>
      )}

      {permission.mode === "function" && (
        <div className="condition-section">
          <div className="section-label">
            <div>
              <b>Parameter conditions</b>
              <span>All must hold for the call to be allowed</span>
            </div>
            {!permission.rawCondition && !needsSignature && (
              <button
                onClick={() =>
                  onChange((current) => ({
                    ...current,
                    conditions: [
                      ...current.conditions,
                      {
                        id: nextId("condition"),
                        paramIndex: current.conditions.length,
                        operator: "eq",
                        value: "",
                      },
                    ],
                  }))
                }
              >
                + Add
              </button>
            )}
          </div>

          {permission.rawCondition ? (
            <div className="guardrail-callout locked">
              <b>Deployed condition preserved</b>
              <p>
                This permission&apos;s condition uses nesting or operators this editor cannot
                represent. It is kept exactly as deployed and will not be rewritten. Editing it
                requires the Zodiac Roles app.
              </p>
            </div>
          ) : needsSignature ? (
            <p className="inline-empty">Verify the function signature to edit conditions.</p>
          ) : (
            <div className="condition-editor-list">
              {permission.conditions.map((condition, index) => (
                <div className="condition-editor" key={condition.id}>
                  <span className="condition-index">{index + 1}</span>
                  <div>
                    {/* With the signature known, parameters are chosen by name
                        instead of by counting positions. */}
                    {params && params.length > 0 ? (
                      <select
                        aria-label={`Condition ${index + 1} parameter`}
                        value={condition.paramIndex}
                        onChange={(event) =>
                          onChange((current) => ({
                            ...current,
                            conditions: current.conditions.map((item) =>
                              item.id === condition.id
                                ? { ...item, paramIndex: Number(event.target.value) }
                                : item,
                            ),
                          }))
                        }
                      >
                        {params.map((param) => (
                          <option key={param.index} value={param.index}>
                            {param.label} ({param.type})
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        className="condition-position"
                        type="number"
                        min="0"
                        aria-label={`Condition ${index + 1} parameter position`}
                        title="Zero-based parameter position"
                        value={condition.paramIndex}
                        onChange={(event) =>
                          onChange((current) => ({
                            ...current,
                            conditions: current.conditions.map((item) =>
                              item.id === condition.id
                                ? { ...item, paramIndex: Math.max(0, Number(event.target.value)) }
                                : item,
                            ),
                          }))
                        }
                      />
                    )}
                    <select
                      aria-label={`Condition ${index + 1} operator`}
                      value={condition.operator}
                      onChange={(event) =>
                        onChange((current) => ({
                          ...current,
                          conditions: current.conditions.map((item) =>
                            item.id === condition.id
                              ? { ...item, operator: event.target.value as ConditionOperator }
                              : item,
                          ),
                        }))
                      }
                    >
                      {conditionOperators.map((operator) => (
                        <option key={operator} value={operator}>
                          {conditionOperatorLabels[operator]}
                        </option>
                      ))}
                    </select>
                    {condition.operator === "withinAllowance" ? (
                      <select
                        aria-label={`Condition ${index + 1} allowance`}
                        value={condition.value}
                        onChange={(event) =>
                          onChange((current) => ({
                            ...current,
                            conditions: current.conditions.map((item) =>
                              item.id === condition.id
                                ? { ...item, value: event.target.value }
                                : item,
                            ),
                          }))
                        }
                      >
                        <option value="">Select an allowance…</option>
                        {allowances.map((allowance) => (
                          <option key={allowance.id} value={allowance.key}>
                            {allowance.key || "(unnamed)"}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        aria-label={`Condition ${index + 1} value`}
                        className="mono-input"
                        value={condition.value}
                        placeholder={
                          isValuelessOperator(condition.operator) ? "—" : "Comparison value"
                        }
                        disabled={isValuelessOperator(condition.operator)}
                        onChange={(event) =>
                          onChange((current) => ({
                            ...current,
                            conditions: current.conditions.map((item) =>
                              item.id === condition.id
                                ? { ...item, value: event.target.value }
                                : item,
                            ),
                          }))
                        }
                      />
                    )}
                    <small className="field-help condition-help">
                      {conditionOperatorHelp[condition.operator]}
                      {condition.operator === "withinAllowance" && allowances.length === 0 && (
                        <> No allowance exists yet: create one in the <b>Allowances</b> tab first.</>
                      )}
                    </small>
                    <button
                      className="row-remove"
                      aria-label={`Remove condition ${index + 1}`}
                      onClick={() =>
                        onChange((current) => ({
                          ...current,
                          conditions: current.conditions.filter(
                            (item) => item.id !== condition.id,
                          ),
                        }))
                      }
                    >
                      ×
                    </button>
                  </div>
                </div>
              ))}
              {permission.conditions.length === 0 && (
                <p className="inline-empty">
                  No parameter is constrained, so any argument is permitted.
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {risk !== "Low" && (
        <div className={`guardrail-callout ${risk.toLowerCase()}`}>
          <b>{risk}-risk permission</b>
          <p>{riskReason(permission)}</p>
        </div>
      )}

      <button className="delete-link" onClick={onRemove}>
        Remove permission
      </button>
    </>
  );
}

/** Reports where a contract's ABI came from, or offers manual entry. */
function AbiStatusLine({
  abi,
  onPaste,
  onForget,
}: {
  abi: ReturnType<typeof useAbi>;
  onPaste: () => void;
  onForget: () => void;
}) {
  if (abi.status === "idle") return null;

  if (abi.status === "loading") {
    return <small className="abi-status">Looking up the ABI…</small>;
  }

  if (abi.status === "found" && abi.abi) {
    const source =
      abi.abi.source === "manual" ? "supplied by hand" : `via ${abi.abi.source}`;
    return (
      <small className="abi-status found">
        <b>{abi.abi.name ?? "Verified contract"}</b> · {abi.abi.functions.length} functions ·{" "}
        {source}
        {abi.abi.implementation && (
          <>
            {" · "}
            {abi.abi.proxyType ?? "proxy"} → {shortHex(abi.abi.implementation)}
          </>
        )}
        <button className="link-button" onClick={onForget}>
          {abi.abi.source === "manual" ? "remove" : "refresh"}
        </button>
      </small>
    );
  }

  return (
    <small className="abi-status missing">
      {abi.reason ?? "No ABI is available."}
      <button className="link-button" onClick={onPaste}>
        paste an ABI
      </button>
    </small>
  );
}
