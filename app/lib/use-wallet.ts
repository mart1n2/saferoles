"use client";

/**
 * Injected-wallet path for submitting a policy update.
 *
 * Wallets with native Safe support (Rabby, among others) expose the Safe itself
 * as the connected account and turn a transaction from it into a Safe
 * transaction. That makes a plain wallet connection a complete submission path:
 * no Transaction Service API key, no manual hash signing.
 *
 * The critical constraint is *which* account is connected. Roles configuration
 * calls are only accepted from the modifier's owner — the Safe. An owner EOA
 * signing directly would revert, so that case is rejected up front rather than
 * discovered after a failed transaction.
 *
 * Batches are submitted atomically through EIP-5792 `wallet_sendCalls` when the
 * wallet supports it. Otherwise they are sent sequentially, which is reported
 * plainly because a partially-applied policy is a real outcome.
 */
import { Interface, getAddress, isAddress } from "ethers";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  PartialSubmissionError,
  type SubmissionResult,
} from "./submission";

type RequestArgs = { method: string; params?: unknown[] | object };

type Provider = {
  request(args: RequestArgs): Promise<unknown>;
  on?(event: string, handler: (...args: never[]) => void): void;
  removeListener?(event: string, handler: (...args: never[]) => void): void;
};

declare global {
  interface Window {
    ethereum?: Provider;
  }
}

export type WalletStatus = "unavailable" | "disconnected" | "connecting" | "connected";

export type BatchSupport = "atomic" | "sequential";

export type WalletTransaction = { to: string; value: string; data: string };

export type WalletSafeInspection = {
  status: "idle" | "checking" | "valid" | "invalid" | "unknown";
  owners: string[];
  threshold: number | null;
  problem: string | null;
};

export type WalletState = {
  status: WalletStatus;
  account: string | null;
  chainId: number | null;
  error: string | null;
  batchSupport: BatchSupport;
  connect: () => Promise<void>;
  /** Submits the batch while preserving which kind of identifier was returned. */
  send: (transactions: WalletTransaction[]) => Promise<SubmissionResult>;
  /** Asks the wallet to move to `chainId`, so a modifier on another chain is reachable. */
  switchChain: (chainId: number) => Promise<void>;
  /** Reads bytecode at an address, or null when no provider is available. */
  getCode: (address: string) => Promise<string | null>;
  /** Current connected-account check. An EOA never qualifies as a Safe. */
  safeInspection: WalletSafeInspection;
  /**
   * Probes the current chain for the Safe interface. When `moduleAddress` is
   * supplied, the result also comes from `isModuleEnabled` in the same probe.
   */
  inspectSafe: (
    safeAddress: string,
    moduleAddress?: string,
  ) => Promise<WalletSafeInspection & { moduleEnabled: boolean | null }>;
};

const safeInterface = new Interface([
  "function VERSION() view returns (string)",
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
  "function nonce() view returns (uint256)",
  "function isModuleEnabled(address module) view returns (bool)",
]);

const idleSafeInspection: WalletSafeInspection = {
  status: "idle",
  owners: [],
  threshold: null,
  problem: null,
};

function parseChainId(value: unknown): number | null {
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 16);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof value === "number") return value;
  return null;
}

export function useWallet(): WalletState {
  const [status, setStatus] = useState<WalletStatus>("disconnected");
  const [account, setAccount] = useState<string | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [batchSupport, setBatchSupport] = useState<BatchSupport>("sequential");
  const [safeInspection, setSafeInspection] =
    useState<WalletSafeInspection>(idleSafeInspection);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const provider = window.ethereum;
    if (!provider) {
      // Deferred so the first paint is not a cascading re-render. Injected
      // providers can also arrive slightly after load, so this re-checks.
      const timer = setTimeout(
        () => setStatus(window.ethereum ? "disconnected" : "unavailable"),
        0,
      );
      return () => clearTimeout(timer);
    }

    // Account and chain can change at any time from inside the wallet. Tracking
    // both is what keeps a proposal from being built against a stale chain.
    const onAccountsChanged = (...args: never[]) => {
      const accounts = args[0] as unknown as string[] | undefined;
      const next = accounts?.[0] ?? null;
      setAccount(next);
      setStatus(next ? "connected" : "disconnected");
    };
    const onChainChanged = (...args: never[]) => {
      setChainId(parseChainId(args[0]));
    };

    provider.on?.("accountsChanged", onAccountsChanged);
    provider.on?.("chainChanged", onChainChanged);
    return () => {
      provider.removeListener?.("accountsChanged", onAccountsChanged);
      provider.removeListener?.("chainChanged", onChainChanged);
    };
  }, []);

  const connect = useCallback(async () => {
    const provider = typeof window === "undefined" ? undefined : window.ethereum;
    if (!provider) {
      setStatus("unavailable");
      setError("No injected wallet was found in this browser.");
      return;
    }

    setStatus("connecting");
    setError(null);
    try {
      const accounts = (await provider.request({
        method: "eth_requestAccounts",
      })) as string[];
      const next = accounts?.[0];
      if (!next) throw new Error("The wallet returned no account.");

      const rawChain = await provider.request({ method: "eth_chainId" });
      const nextChain = parseChainId(rawChain);

      // EIP-5792: ask whether this account can submit an atomic batch.
      let support: BatchSupport = "sequential";
      try {
        const capabilities = (await provider.request({
          method: "wallet_getCapabilities",
          params: [next],
        })) as Record<string, { atomic?: { status?: string }; atomicBatch?: { supported?: boolean } }>;
        const forChain = nextChain
          ? capabilities?.[`0x${nextChain.toString(16)}`]
          : undefined;
        const atomicStatus = forChain?.atomic?.status;
        if (
          atomicStatus === "supported" ||
          atomicStatus === "ready" ||
          forChain?.atomicBatch?.supported
        ) {
          support = "atomic";
        }
      } catch {
        // Capability discovery is optional; absence just means sequential.
      }

      setAccount(next);
      setChainId(nextChain);
      setBatchSupport(support);
      setStatus("connected");
    } catch (caught) {
      setStatus("disconnected");
      setError(
        caught instanceof Error ? caught.message : "The wallet connection failed.",
      );
    }
  }, []);

  const send = useCallback<WalletState["send"]>(
    async (transactions: WalletTransaction[]) => {
      const provider = typeof window === "undefined" ? undefined : window.ethereum;
      if (!provider || !account || chainId === null) {
        throw new Error("Connect a wallet before submitting.");
      }
      if (transactions.length === 0) throw new Error("There is nothing to submit.");

      if (batchSupport === "atomic") {
        const result = (await provider.request({
          method: "wallet_sendCalls",
          params: [
            {
              version: "2.0.0",
              chainId: `0x${chainId.toString(16)}`,
              from: account,
              atomicRequired: true,
              calls: transactions.map((transaction) => ({
                to: transaction.to,
                value: `0x${BigInt(transaction.value).toString(16)}`,
                data: transaction.data,
              })),
            },
          ],
        })) as string | { id?: string };
        const id = typeof result === "string" ? result : result?.id;
        if (!id) throw new Error("The wallet did not return a batch identifier.");
        return { kind: "bundleId", bundleId: id };
      }

      // Sequential fallback. Each call is a separate wallet confirmation.
      const txHashes: string[] = [];
      for (const transaction of transactions) {
        try {
          const hash = await provider.request({
            method: "eth_sendTransaction",
            params: [
              {
                from: account,
                to: transaction.to,
                value: `0x${BigInt(transaction.value).toString(16)}`,
                data: transaction.data,
              },
            ],
          });
          if (typeof hash !== "string" || !hash) {
            throw new Error("The wallet did not return a transaction hash.");
          }
          txHashes.push(hash);
        } catch (caught) {
          if (txHashes.length > 0) {
            throw new PartialSubmissionError(
              `${txHashes.length} of ${transactions.length} calls were submitted before the wallet stopped. Do not retry the whole batch until those transactions are reconciled.`,
              txHashes,
              caught instanceof Error ? { cause: caught } : undefined,
            );
          }
          throw caught;
        }
      }
      return { kind: "txHashes", txHashes };
    },
    [account, batchSupport, chainId],
  );

  const switchChain = useCallback(async (target: number) => {
    const provider = typeof window === "undefined" ? undefined : window.ethereum;
    if (!provider) throw new Error("No wallet is connected.");
    try {
      await provider.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: `0x${target.toString(16)}` }],
      });
      // `chainChanged` normally follows, but not every wallet emits it reliably.
      setChainId(target);
    } catch (caught) {
      const code = (caught as { code?: number })?.code;
      if (code === 4902) {
        throw new Error(
          "Your wallet does not have this network configured. Add it in the wallet, then try again.",
        );
      }
      throw new Error(
        caught instanceof Error ? caught.message : "The network switch was rejected.",
      );
    }
  }, []);

  const getCode = useCallback(async (address: string) => {
    const provider = typeof window === "undefined" ? undefined : window.ethereum;
    if (!provider) return null;
    try {
      return (await provider.request({
        method: "eth_getCode",
        params: [address, "latest"],
      })) as string;
    } catch {
      return null;
    }
  }, []);

  const inspectSafe = useCallback<WalletState["inspectSafe"]>(
    async (safeAddress, moduleAddress) => {
      const provider = typeof window === "undefined" ? undefined : window.ethereum;
      if (!provider) {
        return {
          ...idleSafeInspection,
          status: "unknown",
          problem: "No wallet provider is available to verify this Safe.",
          moduleEnabled: null,
        };
      }
      if (!isAddress(safeAddress)) {
        return {
          ...idleSafeInspection,
          status: "invalid",
          problem: "The connected account is not a valid address.",
          moduleEnabled: null,
        };
      }
      if (moduleAddress && !isAddress(moduleAddress)) {
        return {
          ...idleSafeInspection,
          status: "invalid",
          problem: "The modifier address is not valid.",
          moduleEnabled: null,
        };
      }

      const safeAddressChecked = getAddress(safeAddress);
      const ethCall = async (data: string) =>
        provider.request({
          method: "eth_call",
          params: [{ to: safeAddressChecked, data }, "latest"],
        });

      try {
        const code = await provider.request({
          method: "eth_getCode",
          params: [safeAddressChecked, "latest"],
        });
        if (
          typeof code !== "string" ||
          !/^0x[0-9a-fA-F]+$/.test(code) ||
          code.length <= 2
        ) {
          return {
            ...idleSafeInspection,
            status: "invalid",
            problem:
              "The connected account has no contract code. Select the Safe account in a Safe-aware wallet, not an owner EOA.",
            moduleEnabled: null,
          };
        }

        const [versionRaw, ownersRaw, thresholdRaw, nonceRaw] = await Promise.all([
          ethCall(safeInterface.encodeFunctionData("VERSION")),
          ethCall(safeInterface.encodeFunctionData("getOwners")),
          ethCall(safeInterface.encodeFunctionData("getThreshold")),
          ethCall(safeInterface.encodeFunctionData("nonce")),
        ]);
        if (
          typeof versionRaw !== "string" ||
          typeof ownersRaw !== "string" ||
          typeof thresholdRaw !== "string" ||
          typeof nonceRaw !== "string"
        ) {
          throw new Error("The provider returned an invalid Safe response.");
        }
        const version = String(
          safeInterface.decodeFunctionResult("VERSION", versionRaw)[0],
        );
        const owners = [
          ...(safeInterface.decodeFunctionResult("getOwners", ownersRaw)[0] as string[]),
        ].map((owner) => getAddress(owner));
        const thresholdValue = BigInt(
          safeInterface.decodeFunctionResult("getThreshold", thresholdRaw)[0].toString(),
        );
        const nonce = BigInt(
          safeInterface.decodeFunctionResult("nonce", nonceRaw)[0].toString(),
        );
        if (
          !/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(version) ||
          owners.length === 0 ||
          thresholdValue <= 0n ||
          thresholdValue > BigInt(owners.length) ||
          thresholdValue > BigInt(Number.MAX_SAFE_INTEGER) ||
          nonce < 0n
        ) {
          return {
            ...idleSafeInspection,
            status: "invalid",
            owners,
            problem:
              "The connected contract did not return a valid Safe owner set and threshold.",
            moduleEnabled: null,
          };
        }

        let moduleEnabled: boolean | null = null;
        if (moduleAddress) {
          const enabledRaw = await ethCall(
            safeInterface.encodeFunctionData("isModuleEnabled", [
              getAddress(moduleAddress),
            ]),
          );
          if (typeof enabledRaw !== "string") {
            throw new Error("The provider returned an invalid module response.");
          }
          moduleEnabled = Boolean(
            safeInterface.decodeFunctionResult("isModuleEnabled", enabledRaw)[0],
          );
        }

        return {
          status: "valid",
          owners,
          threshold: Number(thresholdValue),
          problem: null,
          moduleEnabled,
        };
      } catch (caught) {
        return {
          ...idleSafeInspection,
          status: "unknown",
          problem: `Could not verify the connected account as a Safe: ${
            caught instanceof Error ? caught.message : "the RPC read failed"
          }`,
          moduleEnabled: null,
        };
      }
    },
    [],
  );

  useEffect(() => {
    if (status !== "connected" || !account || chainId === null) {
      const timer = setTimeout(() => setSafeInspection(idleSafeInspection), 0);
      return () => clearTimeout(timer);
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      setSafeInspection({ ...idleSafeInspection, status: "checking" });
      void inspectSafe(account).then((inspection) => {
        if (!cancelled) {
          setSafeInspection({
            status: inspection.status,
            owners: inspection.owners,
            threshold: inspection.threshold,
            problem: inspection.problem,
          });
        }
      });
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [account, chainId, inspectSafe, status]);

  return useMemo(
    () => ({
      status,
      account,
      chainId,
      error,
      batchSupport,
      connect,
      send,
      switchChain,
      getCode,
      safeInspection,
      inspectSafe,
    }),
    [
      status,
      account,
      chainId,
      error,
      batchSupport,
      connect,
      send,
      switchChain,
      getCode,
      safeInspection,
      inspectSafe,
    ],
  );
}

/**
 * Checks a wallet connection against the modifier it is about to reconfigure.
 *
 * The connected account must be the modifier's owner. With a Safe-aware wallet
 * that means selecting the Safe account itself; an owner EOA would have its
 * transaction rejected by the modifier.
 */
export function verifyWalletForModifier({
  account,
  chainId,
  owner,
  avatar,
  target,
  modifierChainId,
  safeStatus,
  moduleEnabled,
}: {
  account: string | null;
  chainId: number | null;
  owner: string | null;
  avatar: string | null;
  target: string | null;
  modifierChainId: number | null;
  safeStatus: WalletSafeInspection["status"];
  moduleEnabled: boolean | null;
}): { ok: boolean; problems: string[] } {
  if (!account) {
    return { ok: false, problems: ["Connect a wallet to submit changes."] };
  }

  const same = (a: string | null, b: string | null) =>
    Boolean(a && b && a.toLowerCase() === b.toLowerCase());

  const problems: string[] = [];
  if (modifierChainId !== null && chainId !== modifierChainId) {
    problems.push(
      `The wallet is on chain ${chainId ?? "unknown"} but this modifier is on chain ${modifierChainId}. Switch networks in your wallet.`,
    );
  }
  if (!same(account, owner)) {
    problems.push(
      `Only the modifier's owner (${owner ?? "unknown"}) can change its configuration. Select that Safe as the active account — a Safe owner signing directly would be rejected.`,
    );
  }
  if (!same(account, avatar)) {
    problems.push(
      `The modifier acts on ${avatar ?? "an unknown avatar"}, not the connected Safe.`,
    );
  }
  if (!same(account, target)) {
    problems.push(
      `The modifier routes execution through ${target ?? "an unknown target"}, not the connected Safe.`,
    );
  }
  if (safeStatus !== "valid") {
    problems.push(
      safeStatus === "checking"
        ? "Verifying that the connected account is a Safe…"
        : safeStatus === "invalid"
          ? "The connected account is not a valid Safe. Select the Safe account, not an owner EOA."
          : "The connected account could not be verified as a Safe.",
    );
  }
  if (moduleEnabled !== true) {
    problems.push(
      moduleEnabled === false
        ? "The modifier is not an enabled module on the connected Safe."
        : "The modifier's enabled-module status could not be verified on chain.",
    );
  }

  return { ok: problems.length === 0, problems };
}
