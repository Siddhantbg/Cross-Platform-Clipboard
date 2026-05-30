import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  server: {
    proxy: {
      "/api": {
        target: "http://localhost:8787",
        changeOrigin: true
      },
      "/ws": {
        target: "ws://localhost:8787",
        ws: true
      },
      "/clip-ws": {
        target: "ws://localhost:8787",
        ws: true
      }
    }
  },
  plugins: [
    react(),
    VitePWA({
      registerType: "prompt",
      includeAssets: ["icons/icon-192.svg", "icons/icon-512.svg"],
      manifest: {
        name: "Cross Clipboard",
        short_name: "Clipboard",
        description: "Minimal cross-device clipboard",
        start_url: "/?source=pwa",
        display: "standalone",
        background_color: "#f8fbff",
        theme_color: "#2f6bff",
        icons: [
          {
            src: "/icons/icon-192.svg",
            sizes: "192x192",
            type: "image/svg+xml",
            purpose: "any"
          },
          {
            src: "/icons/icon-512.svg",
            sizes: "512x512",
            type: "image/svg+xml",
            purpose: "any"
          }
        ]
      },
      workbox: {
        navigateFallbackDenylist: [/^\/api\//, /^\/clip-ws/],
        skipWaiting: false,
        clientsClaim: false
      }
    })
  ]
});
