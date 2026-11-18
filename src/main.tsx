import ReactDOM from "react-dom/client";
import "./ui/monaco-setup";
import "./ui/lsp-providers";
import "@xterm/xterm/css/xterm.css";
import "./ui/app.css";
import App from "./App";

// No StrictMode: its double-mount would open two WebRTC sessions.
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<App />);
