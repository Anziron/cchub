import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  // 不写 host 时 Vite 只绑 IPv6 的 ::1，设备上访问 ::1 被拒（代理 TUN / 防火墙），浏览器打不开 → 固定绑 IPv4。
  server: { host: "127.0.0.1", port: 5173, strictPort: true },
});
