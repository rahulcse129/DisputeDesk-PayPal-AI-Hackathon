import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname) } },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    env: {
      USE_MOCK_PAYPAL: "true",
      DATABASE_PATH: ":memory:",
      ANTHROPIC_API_KEY: "",
    },
  },
});
