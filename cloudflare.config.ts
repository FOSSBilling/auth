import { bindings, defineConfig, triggers } from "cf/config";

export default defineConfig(({ isPreview }) => ({
  worker: {
    name: "auth",
    compatibilityDate: "2026-11-24",
    entrypoint: "src/index.ts",
    workersDev: false,
    previewUrls: false,
    observability: {
      ...(isPreview && { enabled: true }),
      redactQueryString: true,
      logs: {
        enabled: true,
        invocationLogs: true
      },
      traces: {
        enabled: true
      },
      issues: {
        enabled: true
      }
    },
    // Preview uploads from Build Output don't support `triggers`, so the cron
    // is only attached to non-preview (production) uploads.
    triggers: isPreview
      ? []
      : [triggers.scheduled({ schedule: "*/10 * * * *" })],
    domains: [
      "auth.fossbilling.net",
      {
        hostname: "auth.fossbilling.foo",
        production: false,
        previews: true
      }
    ],
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
}));
