import { createConfig, http, type Config } from "wagmi";
import { injected } from "wagmi/connectors";
import { disconnect } from "wagmi/actions";
import { walletChains } from "./wallet-chains";
export { walletChains } from "./wallet-chains";

export function createWalletConfig() {
  return createConfig({
    chains: walletChains,
    connectors: [injected({ shimDisconnect: true, unstable_shimAsyncInject: 1000 })],
    multiInjectedProviderDiscovery: true,
    ssr: true,
    transports: Object.fromEntries(walletChains.map(chain => [chain.id, http()])),
  });
}

/** wagmi otherwise falls back to a previously connected wallet on disconnect. */
export async function disconnectWallets(config: Config) {
  for (const { connector } of [...config.state.connections.values()]) {
    await disconnect(config, { connector });
  }
}
