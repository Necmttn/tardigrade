import { defineConfig } from "vite"

export default defineConfig({
  server: {
    host: "127.0.0.1",
    proxy: {
      "/v1": {
        target: process.env.CANVAS_API_URL ?? "http://127.0.0.1:4342",
        changeOrigin: true
      }
    }
  }
})
