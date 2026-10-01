import { cloudflareTest } from "@cloudflare/vitest-pool-workers"
import { defineConfig } from "vitest/config"

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./test/worker-loader/wrangler.jsonc" } })],
  test: { include: ["test/worker-loader/**/*.workers.ts"] }
})
