/**
 * Example bot action: approve a spender for a token, as a Roles member.
 *
 *   npx tsx examples/bot-send/send.ts            # simulate only (default)
 *   npx tsx examples/bot-send/send.ts --batch    # reset to 0, then approve, in one MultiSend
 *   npx tsx examples/bot-send/send.ts --send     # simulate, then broadcast
 *
 * Configuration comes from the environment (see README.md). The private key is
 * read from BOT_PRIVATE_KEY only to keep the example short; a real bot should
 * sign through a KMS or HSM (viem's `toAccount` wraps any signer).
 */
import { createPublicClient, createWalletClient, defineChain, encodeFunctionData, erc20Abi, getAddress, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { RolesRejection, sendWithRole, simulateWithRole, toRolesTransaction, type Call } from "./roles-exec";

function env(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Set ${name}. See examples/bot-send/README.md.`);
  return value;
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const broadcast = args.has("--send");

  const rpcUrl = env("RPC_URL");
  const target = { rolesMod: getAddress(env("ROLES_MOD")), role: env("ROLE") };
  const token = getAddress(env("TOKEN"));
  const spender = getAddress(env("SPENDER"));
  const amount = BigInt(env("AMOUNT"));

  const publicClient = createPublicClient({ transport: http(rpcUrl) });
  const chainId = await publicClient.getChainId();
  const chain = defineChain({
    id: chainId,
    name: `chain ${chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const account = privateKeyToAccount(env("BOT_PRIVATE_KEY") as Hex);
  const walletClient = createWalletClient({ account, chain, transport: http(rpcUrl) });
  const clients = { publicClient, walletClient };

  const approve = (value: bigint): Call => ({
    to: token,
    data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, value] }),
  });
  const calls = args.has("--batch") ? [approve(0n), approve(amount)] : [approve(amount)];
  const multiSend = process.env.MULTISEND?.trim();
  const tx = toRolesTransaction(calls, multiSend ? { multiSend: getAddress(multiSend) } : {});

  console.log(`bot      ${account.address}`);
  console.log(`modifier ${target.rolesMod} on chain ${chainId}, role "${target.role}"`);
  console.log(`action   ${calls.length === 1 ? "approve" : `MultiSend (${tx.to}) of ${calls.length} approves`} ${token} → ${spender}, ${amount}`);

  if (!broadcast) {
    await simulateWithRole(clients, target, tx);
    console.log("simulation passed: the role allows this. Re-run with --send to broadcast.");
    return;
  }
  const receipt = await sendWithRole(clients, target, tx);
  console.log(`sent     ${receipt.transactionHash} (block ${receipt.blockNumber}, gas ${receipt.gasUsed})`);
}

main().catch((error: unknown) => {
  if (error instanceof RolesRejection) console.error(`refused  ${error.message}`);
  else console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
