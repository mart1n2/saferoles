import { useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider } from "wagmi";
import { createWalletConfig } from "./lib/wallet-config";

export function WalletProvider({ children }: { children: ReactNode }) {
  const [config] = useState(createWalletConfig);
  const [queryClient] = useState(() => new QueryClient({defaultOptions:{queries:{retry:1,refetchOnWindowFocus:false}}}));
  return <WagmiProvider config={config} reconnectOnMount={false}><QueryClientProvider client={queryClient}>{children}</QueryClientProvider></WagmiProvider>;
}
