/**
 * Sending transactions as a Roles member.
 *
 * A bot is not a Safe owner and never collects Safe signatures. It calls
 * `execTransactionWithRole` on the Roles modifier from its own EOA; the modifier
 * checks the call against the role and, if it passes, has the Safe execute it.
 * To the chain this is an ordinary contract call from an EOA, so viem is all the
 * tooling it needs. `zodiac-roles-sdk` supplies the ABI and the role key encoding.
 *
 * Every send is simulated first. A call the role does not allow reverts in the
 * simulation with the modifier's own error, which is decoded here so the bot can
 * log why it was refused instead of burning gas on a transaction that reverts.
 */
import {
  BaseError,
  ContractFunctionRevertedError,
  concat,
  encodeFunctionData,
  encodePacked,
  isHex,
  parseAbi,
  size,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
  type Transport,
  type WalletClient,
} from "viem";
import { Status, encodeKey, rolesAbi } from "zodiac-roles-sdk";

/** Safe's `Enum.Operation`. */
export const Operation = { Call: 0, DelegateCall: 1 } as const;
export type Operation = (typeof Operation)[keyof typeof Operation];

/**
 * Safe MultiSendCallOnly, canonical deployments (from @safe-global/safe-deployments).
 * Batches go through the call-only variant so no inner call can be a delegatecall.
 *
 * The version does not have to match the Safe's: MultiSend is a stateless library
 * the Safe delegatecalls, and the batch encoding is the same in every version.
 * What matters is the modifier: it only accepts a batch sent to an address that
 * has an unwrapper set (SafeRoles sets one for 1.4.1 on new modifiers; see
 * app/lib/unwrappers.ts). 1.3.0 also has an `eip155` deployment, and zkSync uses
 * other addresses; check safe-deployments for those chains.
 */
export const MULTISEND_CALL_ONLY = {
  "1.3.0": "0x40A2aCCbd92BCA938b02010E17A5b8929b49130D",
  "1.4.1": "0x9641d764fc13c8B624c04430C7356C1C7C8102e2",
  "1.5.0": "0xA83c336B20401Af773B6219BA5027174338D1836",
} as const satisfies Record<string, Address>;

/** Default batch contract: the one SafeRoles registers an unwrapper for. */
export const MULTISEND_CALL_ONLY_141: Address = MULTISEND_CALL_ONLY["1.4.1"];

const multiSendAbi = parseAbi(["function multiSend(bytes transactions) payable"]);

/** One call the Safe should make. */
export type Call = { to: Address; value?: bigint; data: Hex };

/** What the bot asks the modifier to execute: one call, or one MultiSend batch. */
export type RolesTransaction = { to: Address; value: bigint; data: Hex; operation: Operation };

export type RolesTarget = {
  /** The Roles modifier address. */
  rolesMod: Address;
  /** Role name as shown in SafeRoles (e.g. "usdc-yield"), or its bytes32 key. */
  role: string;
};

/** A role name becomes its bytes32 key; a key that is already bytes32 passes through. */
export function roleKey(role: string): Hex {
  return isHex(role) && size(role) === 32 ? role : (encodeKey(role) as Hex);
}

/** MultiSend's packed encoding: operation, to, value, data length, data. */
export function encodeMultiSend(calls: readonly Call[]): Hex {
  const packed = concat(
    calls.map((call) =>
      encodePacked(
        ["uint8", "address", "uint256", "uint256", "bytes"],
        [Operation.Call, call.to, call.value ?? 0n, BigInt(size(call.data)), call.data],
      ),
    ),
  );
  return encodeFunctionData({ abi: multiSendAbi, functionName: "multiSend", args: [packed] });
}

/**
 * One call goes as is. Several become a delegatecall into MultiSendCallOnly,
 * which is the shape the modifier's unwrapper expects: it splits the batch and
 * checks every inner call against the role, and the whole batch reverts if any
 * one of them is not allowed. `multiSend` must be a batch contract the modifier
 * has an unwrapper for; without one, every batch is refused.
 */
export function toRolesTransaction(
  calls: readonly Call[],
  { multiSend = MULTISEND_CALL_ONLY_141 }: { multiSend?: Address } = {},
): RolesTransaction {
  if (calls.length === 0) throw new Error("Nothing to send.");
  if (calls.length === 1) {
    const [call] = calls;
    return { to: call.to, value: call.value ?? 0n, data: call.data, operation: Operation.Call };
  }
  return { to: multiSend, value: 0n, data: encodeMultiSend(calls), operation: Operation.DelegateCall };
}

/** The modifier refused the transaction, or the Safe's call itself failed. */
export class RolesRejection extends Error {
  constructor(
    message: string,
    readonly errorName: string | undefined,
    readonly status: string | undefined,
    readonly info: Hex | undefined,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "RolesRejection";
  }
}

const explanations: Record<string, string> = {
  NotAuthorized: "the bot is not a member of this role",
  NoMembership: "no role key was given and the bot has no default role",
  ModuleTransactionFailed: "the role allowed the call, but the call itself reverted in the Safe",
};

/** Turns a revert from the modifier into a readable RolesRejection; other errors pass through. */
export function explainRolesError(error: unknown): unknown {
  if (!(error instanceof BaseError)) return error;
  const reverted = error.walk((e) => e instanceof ContractFunctionRevertedError);
  if (!(reverted instanceof ContractFunctionRevertedError) || !reverted.data) return error;
  const { errorName, args } = reverted.data;
  if (errorName === "ConditionViolation") {
    const [code, info] = args as readonly [number, Hex];
    const status = Status[code] ?? `status ${code}`;
    return new RolesRejection(`Role check failed: ${status} (info ${info})`, errorName, status, info, { cause: error });
  }
  const why = explanations[errorName] ?? "the modifier rejected the transaction";
  return new RolesRejection(`${errorName}: ${why}`, errorName, undefined, undefined, { cause: error });
}

type Clients = {
  publicClient: PublicClient;
  walletClient: WalletClient<Transport, Chain, Account>;
};

/**
 * Simulates the transaction as the bot. Resolves with a request ready to send,
 * or throws RolesRejection with the modifier's reason.
 *
 * `shouldRevert` is always true: with false, a failing inner call returns
 * `success = false` from a transaction that still succeeds, and the bot would
 * not notice its action did nothing.
 */
export async function simulateWithRole({ publicClient, walletClient }: Clients, target: RolesTarget, tx: RolesTransaction) {
  try {
    const { request } = await publicClient.simulateContract({
      account: walletClient.account,
      address: target.rolesMod,
      abi: rolesAbi,
      functionName: "execTransactionWithRole",
      args: [tx.to, tx.value, tx.data, tx.operation, roleKey(target.role), true],
    });
    return request;
  } catch (error) {
    throw explainRolesError(error);
  }
}

/**
 * Simulates, sends, and waits for the receipt. Throws if the simulation is
 * refused or the mined transaction reverted (state can change between the
 * simulation and inclusion, e.g. another spend used up the allowance).
 */
export async function sendWithRole(
  clients: Clients,
  target: RolesTarget,
  tx: RolesTransaction,
  { confirmations = 1, timeoutMs = 120_000 }: { confirmations?: number; timeoutMs?: number } = {},
): Promise<TransactionReceipt> {
  const request = await simulateWithRole(clients, target, tx);
  const hash = await clients.walletClient.writeContract(request);
  const receipt = await clients.publicClient.waitForTransactionReceipt({ hash, confirmations, timeout: timeoutMs });
  if (receipt.status !== "success") throw new Error(`Transaction ${hash} reverted on chain.`);
  return receipt;
}
