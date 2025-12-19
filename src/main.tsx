import React from "react";
import ReactDOM from "react-dom/client";
import AppShell from "./AppShell";   // <— именно AppShell
import "./index.css";
import "./App.css";                  // <— чтобы подхватился наш CSS-лок

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AppShell />
  </React.StrictMode>
);
