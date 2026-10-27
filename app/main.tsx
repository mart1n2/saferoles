import { createRoot } from "react-dom/client";
import { WalletProvider } from "./wallet-provider";
import Home from "./page";
import "./globals.css";
createRoot(document.getElementById("root")!).render(<WalletProvider><Home/></WalletProvider>);
