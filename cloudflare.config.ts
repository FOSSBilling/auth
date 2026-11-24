import { bindings, defineConfig, triggers } from "cf/config";

export default defineConfig({
  worker: {
    name: "auth",
    compatibilityDate: "2026-09-23",
    compatibilityFlags: ["nodejs_compat"],
    entrypoint: "src/index.ts",
    workersDev: false,
    previewUrls: true,
    observability: {
      redactQueryString: true,
      logs: {
        enabled: true,
        invocationLogs: true
      },
      traces: {
        enabled: true
      }
    },
    triggers: [triggers.scheduled({ schedule: "*/10 * * * *" })],
    env: {
      NODE_ENV: bindings.text("production"),
      BETTER_AUTH_URL: bindings.text("https://auth.fossbilling.net"),
      GITHUB_ORGS_MAX_AGE_SECONDS: bindings.text("86400"),
      AUTH_DB: bindings.d1({
        name: "auth",
        id: "43ce5ec3-5ddd-429b-b9e8-550a80d0edf9"
      })
    }
  }
});
