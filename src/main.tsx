import React from "react";
import ReactDOM from "react-dom/client";
import AppShell from "./AppShell";
import TgReportView from "./views/TgReportView";
import "./index.css";
import "./App.css";                  // <— чтобы подхватился наш CSS-лок

const RootView = window.location.pathname.startsWith("/tg/report") ? TgReportView : AppShell;

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <RootView />
  </React.StrictMode>
);
