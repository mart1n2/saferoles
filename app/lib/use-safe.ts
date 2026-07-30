"use client";

/**
 * Safe App host integration.
 *
 * Inside the Safe UI the host is the authority on which Safe is open, which
 * chain it is on, and who its owners are, so none of that is asked for or
 * inferred. Proposals go through the host, which removes the Transaction
 * Service API key and the manual hash-signing flow entirely.
 *
 * Outside the Safe UI the app still runs, read-only: indexed policy can be
 * inspected and a diff computed, but nothing can be proposed.
 */
import { Interface, getAddress, isAddress } from "ethers";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SubmissionResult } from "./submission";

export type SafeHostInfo = {
  safeAddress: string;
  chainId: number;
  threshold: number;
  owners: string[];
  isReadOnly: boolean;
  /** Enabled Safe modules, used to verify the Roles modifier is actually wired up. */
  modules: string[] | null;
};

export type SafeMode = "detecting" | "safe-app" | "standalone";

export type SafeTransaction = {
  to: string;
  value: string;
  data: string;
};

type Sdk = {
  safe: { getInfo(): Promise<SafeHostInfo> };
  txs: { send(input: { txs: SafeTransaction[] }): Promise<{ safeTxHash: string }> };
  /** RPC proxied through the Safe host, so no separate provider is needed. */
  eth: {
    getCode(params: [string]): Promise<string>;
    call(
      params: [{ to: string; data: string; value?: string }, string?],
    ): Promise<string>;
  };
};

const HANDSHAKE_TIMEOUT_MS = 4000;
const safeInterface = new Interface([
  "function isModuleEnabled(address module) view returns (bool)",
]);

export type SafeContext = {
  mode: SafeMode;
  info: SafeHostInfo | null;
  error: string | null;
  /** Submits a batch to the Safe queue. */
  propose: (transactions: SafeTransaction[]) => Promise<SubmissionResult>;
  /** Reads bytecode at an address, or null when no provider is available. */
  getCode: (address: string) => Promise<string | null>;
  /** Reads module enablement directly from the open Safe. Null means unknown. */
  isModuleEnabled: (moduleAddress: string) => Promise<boolean | null>;
};

export function useSafe(): SafeContext {
  const [mode, setMode] = useState<SafeMode>("detecting");
  const [info, setInfo] = useState<SafeHostInfo | null>(null);
  const sdkRef = useRef<Sdk | null>(null);
  // Handshake failures are not surfaced as errors: not being in the Safe UI is a
  // supported way to run, so it resolves to standalone instead.
  const error = null;

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      // A Safe App always runs framed. Checking first avoids waiting out a
      // handshake timeout that could never succeed.
      if (typeof window === "undefined" || window.parent === window) {
        if (!cancelled) setMode("standalone");
        return;
      }

      try {
        const { default: SafeAppsSDK } = await import("@safe-global/safe-apps-sdk");
        const sdk = new SafeAppsSDK() as unknown as Sdk;

        const hostInfo = await Promise.race([
          sdk.safe.getInfo(),
          new Promise<never>((_resolve, reject) =>
            setTimeout(
              () => reject(new Error("The Safe host did not respond.")),
              HANDSHAKE_TIMEOUT_MS,
            ),
          ),
        ]);

        if (cancelled) return;
        sdkRef.current = sdk;
        setInfo(hostInfo);
        setMode("safe-app");
      } catch {
        // Framed but not by a Safe — treat as standalone rather than erroring.
        if (!cancelled) setMode("standalone");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const propose = useCallback<SafeContext["propose"]>(async (transactions) => {
    const sdk = sdkRef.current;
    if (!sdk) {
      throw new Error(
        "Proposals require the Safe UI. Open SafeRoles as a Safe App to submit this batch.",
      );
    }
    if (transactions.length === 0) {
      throw new Error("There is nothing to propose.");
    }
    const { safeTxHash } = await sdk.txs.send({ txs: transactions });
    return { kind: "safeTxHash", safeTxHash };
  }, []);

  const getCode = useCallback(async (address: string) => {
    const sdk = sdkRef.current;
    if (!sdk) return null;
    try {
      return await sdk.eth.getCode([address]);
    } catch {
      return null;
    }
  }, []);

  const isModuleEnabled = useCallback(async (moduleAddress: string) => {
    const sdk = sdkRef.current;
    const safeAddress = info?.safeAddress;
    if (!sdk || !safeAddress || !isAddress(moduleAddress)) return null;
    try {
      const result = await sdk.eth.call([
        {
          to: getAddress(safeAddress),
          data: safeInterface.encodeFunctionData("isModuleEnabled", [
            getAddress(moduleAddress),
          ]),
        },
      ]);
      return Boolean(
        safeInterface.decodeFunctionResult("isModuleEnabled", result)[0],
      );
    } catch {
      return null;
    }
  }, [info?.safeAddress]);

  return useMemo(
    () => ({ mode, info, error, propose, getCode, isModuleEnabled }),
    [mode, info, error, propose, getCode, isModuleEnabled],
  );
}

/**
 * Verifies the modifier is controlled by the open Safe.
 *
 * All three conditions must hold for a proposal from this Safe to be able to
 * change the policy at all:
 *  - the Safe owns the modifier, so it may reconfigure it
 *  - the modifier's avatar is the Safe, so permissions act on the Safe
 *  - the modifier is an enabled module, so it can execute at all
 */
export function verifyModifier({
  info,
  owner,
  avatar,
  target,
  rolesMod,
  chainId,
  moduleEnabled,
}: {
  info: SafeHostInfo | null;
  owner: string | null;
  avatar: string | null;
  target: string | null;
  rolesMod: string;
  /** Chain of the modifier being edited. */
  chainId: number | null;
  /** Result of a direct `isModuleEnabled` read. Null means it could not be read. */
  moduleEnabled: boolean | null;
}): { ok: boolean; problems: string[] } {
  if (!info) {
    return {
      ok: false,
      problems: ["Open SafeRoles as a Safe App to verify the modifier."],
    };
  }

  const same = (a: string | null, b: string | null) =>
    Boolean(a && b && a.toLowerCase() === b.toLowerCase());

  const problems: string[] = [];
  if (!same(owner, info.safeAddress)) {
    problems.push(
      `This Safe does not own the modifier — its owner is ${owner ?? "unknown"}, so it cannot reconfigure it.`,
    );
  }
  if (!same(avatar, info.safeAddress)) {
    problems.push(
      `The modifier acts on ${avatar ?? "an unknown avatar"}, not this Safe, so its permissions would not apply here.`,
    );
  }
  if (!same(target, info.safeAddress)) {
    problems.push(
      `The modifier routes execution through ${target ?? "an unknown target"}, not this Safe.`,
    );
  }
  if (info.modules && !info.modules.some((module) => same(module, rolesMod))) {
    problems.push(
      "The Safe host does not list this modifier among the enabled modules.",
    );
  }
  if (moduleEnabled !== true) {
    problems.push(
      moduleEnabled === false
        ? "The modifier is not an enabled module on this Safe, so it cannot execute transactions."
        : "The modifier's enabled-module status could not be verified on chain.",
    );
  }
  if (chainId !== null && chainId !== info.chainId) {
    problems.push(
      `This Safe is on chain ${info.chainId} but the modifier being edited is on chain ${chainId}. A proposal from this Safe cannot reach it.`,
    );
  }

  return { ok: problems.length === 0, problems };
}
