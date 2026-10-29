import { createRoot } from "react-dom/client";
import { WalletProvider } from "./wallet-provider";
import Home from "./page";
import { canonicalLocalUrl } from "./lib/canonical-origin";
import "./globals.css";
const canonical = canonicalLocalUrl(window.location.href);
if (canonical) window.location.replace(canonical);
else createRoot(document.getElementById("root")!).render(<WalletProvider><Home/></WalletProvider>);
