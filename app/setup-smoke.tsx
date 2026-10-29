import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SetupPage } from "./setup-page";
import "./globals.css";
// The permission editor reads and saves contract labels through react-query, as the real app's provider supplies.
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } });
createRoot(document.getElementById("root")!).render(<QueryClientProvider client={queryClient}><SetupPage chainId={1} safeAddress="0x1111111111111111111111111111111111111111" submitter={null} onClose={()=>{}} onDone={()=>{}} onOpen={()=>{}}/></QueryClientProvider>);
