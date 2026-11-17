import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { loadHub } from "./hub";
import { Store } from "./store";
import "./styles.css";

void loadHub().then(async (hub) => {
  if (!hub) {
    document.body.textContent = "请在桌面端里打开。";
    return;
  }
  const store = new Store(hub);
  if (import.meta.env.DEV) {
    store.select(new URLSearchParams(location.search).get("s"));
    // 等 demo 加载完再渲染：它顶层会按地址参数重置本地存储（宽度、收起、设备筛选），界面要在那之后才读。
    const demo = await import("./demo");
    demo.setupDemo(store);
  }
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App store={store} />
    </StrictMode>,
  );
});
