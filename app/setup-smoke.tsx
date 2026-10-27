import { createRoot } from "react-dom/client";
import { SetupPage } from "./setup-page";
import "./globals.css";
createRoot(document.getElementById("root")!).render(<SetupPage chainId={1} safeAddress="0x1111111111111111111111111111111111111111" submitter={null} onClose={()=>{}} onDone={()=>{}} onOpen={()=>{}}/>);
