/**
 * Deploying a Roles modifier and enabling it on a Safe.
 *
 * Enabling a Safe module grants that contract authority to execute arbitrary
 * transactions from the Safe, bypassing the owner threshold entirely. It is the
 * single most consequential thing this app can propose, so nothing here is
 * assumed:
 *
 *  - the mastercopy is verified on chain and against its published source before
 *    a batch can be built;
 *  - the proxy address is derived deterministically and shown before submission;
 *  - the address is checked to be unoccupied, since deploying over an existing
 *    proxy reverts.
 *
 * The batch is two calls, both from the Safe: deploy the proxy through the
 * Zodiac ModuleProxyFactory, then enable the resulting address as a module.
 */
import { encodeDeployProxy, predictProxyAddress } from "@gnosis-guild/zodiac-core";
import { Interface, getAddress, isAddress } from "ethers";

/**
 * Roles v2 mastercopy, deployed at this address on every chain Zodiac has
 * deterministically deployed to (confirmed on Ethereum, Gnosis, Base, Arbitrum
 * and Optimism, verified on Sourcify as `Roles`).
 *
 * Treated strictly as a *suggestion*: it is pre-filled for convenience and then
 * verified at runtime like any other value. Never trusted on the basis of being
 * hardcoded here.
 */
export const SUGGESTED_ROLES_MASTERCOPY = "0x9646fDAD06d3e24444381f44362a3B0eB343D337";

/** Functions a contract must expose to be a Roles v2 modifier. */
export const REQUIRED_ROLES_FUNCTIONS = [
  "setUp",
  "assignRoles",
  "scopeTarget",
  "scopeFunction",
  "allowTarget",
  "revokeTarget",
  "setAllowance",
  "execTransactionFromModule",
  "owner",
  "avatar",
  "target",
] as const;

const safeInterface = new Interface([
  "function enableModule(address module)",
  "function isModuleEnabled(address module) view returns (bool)",
]);

export type SetupTransaction = {
  to: string;
  value: string;
  data: string;
};

/**
 * The Zodiac ModuleProxyFactory, deployed at the same address on every supported
 * chain. Derived from `zodiac-core` rather than written here, and its presence on
 * the target chain is checked before a batch is built.
 */
export const MODULE_PROXY_FACTORY = getAddress(
  String(
    encodeDeployProxy({
      mastercopy: "0x0000000000000000000000000000000000000001",
      setupArgs: { types: ["address"], values: ["0x0000000000000000000000000000000000000001"] },
      saltNonce: "0",
    }).to,
  ),
);

export type SetupPlan = {
  /** Address the modifier will occupy, derived before deployment. */
  predictedAddress: string;
  saltNonce: string;
  transactions: SetupTransaction[];
  /** The setUp arguments, for display. */
  configuration: { owner: string; avatar: string; target: string };
};

/**
 * Builds the deploy-and-enable batch.
 *
 * `owner`, `avatar` and `target` are all the Safe: the Safe governs the
 * modifier, permissions act on the Safe, and the modifier routes calls through
 * the Safe.
 */
export function buildSetupPlan({
  safeAddress,
  mastercopy,
  saltNonce,
}: {
  safeAddress: string;
  mastercopy: string;
  saltNonce: string;
}): SetupPlan {
  if (!isAddress(safeAddress)) throw new Error("The Safe address is not valid.");
  if (!isAddress(mastercopy)) {
    throw new Error("Enter a complete Roles mastercopy address.");
  }

  const safe = getAddress(safeAddress);
  const setupArgs = {
    types: ["address", "address", "address"],
    values: [safe, safe, safe],
  };

  const predictedAddress = getAddress(
    predictProxyAddress({
      mastercopy: getAddress(mastercopy),
      setupArgs,
      saltNonce,
    }),
  );

  const deployment = encodeDeployProxy({
    mastercopy: getAddress(mastercopy),
    setupArgs,
    saltNonce,
  });

  if (!deployment.to || !deployment.data) {
    throw new Error("The deployment transaction could not be encoded.");
  }

  return {
    predictedAddress,
    saltNonce,
    configuration: { owner: safe, avatar: safe, target: safe },
    transactions: [
      {
        to: getAddress(String(deployment.to)),
        value: "0",
        data: String(deployment.data),
      },
      {
        // Enabling the module is a call from the Safe to itself.
        to: safe,
        value: "0",
        data: safeInterface.encodeFunctionData("enableModule", [predictedAddress]),
      },
    ],
  };
}

/** A salt nonce derived from the clock, so repeated setups do not collide. */
export function freshSaltNonce(): string {
  return String(Date.now());
}

export type CheckStatus = "pending" | "pass" | "fail";

export type SetupCheck = {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
};

/**
 * Evaluates whether a mastercopy is safe to deploy from.
 *
 * `code` is the on-chain bytecode at the mastercopy address, `abiName` and
 * `abiFunctions` come from its published source. Every check must pass, because
 * the consequence of pointing this at the wrong contract is a module with
 * unrestricted authority over the Safe.
 */
export function evaluateMastercopy({
  mastercopy,
  code,
  abiName,
  abiFunctions,
  factoryCode,
  predictedCode,
}: {
  mastercopy: string;
  code: string | null;
  abiName: string | null;
  abiFunctions: readonly string[] | null;
  /** Bytecode at {@link MODULE_PROXY_FACTORY} on the target chain. */
  factoryCode?: string | null;
  /** Bytecode at the predicted proxy address, which must be empty. */
  predictedCode?: string | null;
}): SetupCheck[] {
  const checks: SetupCheck[] = [];
  /**
   * True only for real, non-empty bytecode.
   *
   * Validated as hex rather than just "not the string 0x": anything else reaching
   * here is a bug or a placeholder, and treating it as code would show a passing
   * check for an address nobody has actually read.
   */
  const deployedAt = (value: string | null | undefined) =>
    typeof value === "string" &&
    value.length > 2 &&
    value.length % 2 === 0 &&
    /^0x[0-9a-fA-F]+$/.test(value);

  checks.push({
    id: "address",
    label: "Address is well formed",
    status: isAddress(mastercopy) ? "pass" : "fail",
    detail: isAddress(mastercopy)
      ? getAddress(mastercopy)
      : "Enter a complete 20-byte address.",
  });

  if (code === null) {
    checks.push({
      id: "deployed",
      label: "Contract exists on this chain",
      status: "pending",
      detail: "Reading bytecode…",
    });
  } else {
    const deployed = deployedAt(code);
    checks.push({
      id: "deployed",
      label: "Contract exists on this chain",
      status: deployed ? "pass" : "fail",
      detail: deployed
        ? `${(code.length - 2) / 2} bytes of code`
        : "Nothing is deployed at this address on this chain.",
    });
  }

  if (abiFunctions === null) {
    checks.push({
      id: "verified",
      label: "Source is published and identifies as Roles",
      status: "pending",
      detail: "Checking the published source…",
    });
  } else {
    const namedRoles = (abiName ?? "").toLowerCase().includes("roles");
    const missing = REQUIRED_ROLES_FUNCTIONS.filter(
      (required) => !abiFunctions.includes(required),
    );
    const ok = namedRoles && missing.length === 0;
    checks.push({
      id: "verified",
      label: "Source is published and identifies as Roles",
      status: ok ? "pass" : "fail",
      detail: ok
        ? `Verified as ${abiName}, with the full Roles v2 interface`
        : !abiName
          ? "No published source was found for this address, so it cannot be identified."
          : missing.length > 0
            ? `Verified as ${abiName}, but missing: ${missing.join(", ")}`
            : `Verified as ${abiName}, which is not a Roles contract.`,
    });
  }

  if (factoryCode !== undefined) {
    if (factoryCode === null) {
      checks.push({
        id: "factory",
        label: "Zodiac module factory is available",
        status: "pending",
        detail: "Reading the factory…",
      });
    } else {
      const present = deployedAt(factoryCode);
      checks.push({
        id: "factory",
        label: "Zodiac module factory is available",
        status: present ? "pass" : "fail",
        detail: present
          ? MODULE_PROXY_FACTORY
          : `The factory is not deployed at ${MODULE_PROXY_FACTORY} on this chain, so a proxy cannot be created.`,
      });
    }
  }

  if (predictedCode !== undefined) {
    if (predictedCode === null) {
      checks.push({
        id: "vacant",
        label: "Target address is unoccupied",
        status: "pending",
        detail: "Checking the derived address…",
      });
    } else {
      const occupied = deployedAt(predictedCode);
      checks.push({
        id: "vacant",
        label: "Target address is unoccupied",
        status: occupied ? "fail" : "pass",
        detail: occupied
          ? "A contract already exists at this address. Use a different salt to derive a fresh one."
          : "Nothing is deployed there yet.",
      });
    }
  }

  return checks;
}

export function checksPass(checks: readonly SetupCheck[]): boolean {
  return checks.length > 0 && checks.every((check) => check.status === "pass");
}

/** Encodes `isModuleEnabled` for confirming the result after execution. */
export function encodeIsModuleEnabled(module: string): string {
  return safeInterface.encodeFunctionData("isModuleEnabled", [module]);
}
