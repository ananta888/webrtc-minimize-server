import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["frontend/src/**/*.spec.ts"],
    environment: "jsdom",
    reporters: ["default"],
  },
});
