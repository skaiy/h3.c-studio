import path from "path"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vitest/config"
import { inspectAttr } from 'kimi-plugin-inspect-react'

// https://vite.dev/config/
export default defineConfig({
  base: './',
  plugins: [inspectAttr(), react()],
  server: {
    port: 3100,
    proxy: {
      '/api': 'http://127.0.0.1:8765',
      '/outputs': 'http://127.0.0.1:8765',
      '/uploads': 'http://127.0.0.1:8765',
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "jsdom",
    globals: true, // required so @testing-library/react's afterEach(cleanup) auto-registers
    setupFiles: ["./src/test/setup.ts"],
  },
});
