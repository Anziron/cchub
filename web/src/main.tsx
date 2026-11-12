import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { loadHub } from "./hub";
import { Store } from "./store";
import "./styles.css";

void loadHub().then((hub) => {
  if (!hub) {
    document.body.textContent = "请在桌面端里打开。";
    return;
  }
  const store = new Store(hub);
  if (import.meta.env.DEV) {
    store.select(new URLSearchParams(location.search).get("s"));
    void import("./demo").then((demo) => demo.setupDemo(store));
  }
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App store={store} />
    </StrictMode>,
  );
});
