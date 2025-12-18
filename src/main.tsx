import React from "react";
import ReactDOM from "react-dom/client";
import { sdk } from "@farcaster/miniapp-sdk";
import App from "./App";
import "./styles.css";

// Mini App host handshake MUST run even if the App component changes/early-returns.
// If opened outside a host (regular browser), this may throw; we swallow it.
void (async () => {
  try {
    await sdk.actions.ready();
  } catch {
    // no-op
  }
})();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
