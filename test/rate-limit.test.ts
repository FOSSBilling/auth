import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { betterAuth } from "better-auth/minimal";
import { memoryAdapter } from "better-auth/adapters/memory";

const source = readFileSync(new URL("../src/auth.ts", import.meta.url), "utf8");

test("auth enables database-backed limits with Cloudflare's client IP", () => {
  assert.match(source, /ipAddressHeaders:\s*\["cf-connecting-ip"\]/);
  assert.match(
    source,
    /rateLimit:\s*\{\s*enabled:\s*true,\s*storage:\s*"database"/
  );
});

test("shared rate-limit state rejects requests across auth instances", async () => {
  const rows: Record<string, Record<string, unknown>[]> = { rateLimit: [] };
  const options = {
    baseURL: "https://auth.example.test",
    basePath: "/",
    secret: "test-only-secret-at-least-thirty-two-characters",
    advanced: { ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] } },
    rateLimit: {
      enabled: true,
      storage: "database" as const,
      customRules: { "/get-session": { window: 60, max: 2 } }
    }
  };
  const first = betterAuth({ ...options, database: memoryAdapter(rows) });
  const second = betterAuth({ ...options, database: memoryAdapter(rows) });
  const request = (forwarded: string) =>
    new Request("https://auth.example.test/get-session", {
      headers: {
        "cf-connecting-ip": "192.0.2.10",
        "x-forwarded-for": forwarded
      }
    });

  assert.equal((await first.handler(request("198.51.100.1"))).status, 200);
  assert.equal((await second.handler(request("198.51.100.2"))).status, 200);
  assert.equal((await first.handler(request("198.51.100.3"))).status, 429);
  assert.equal(
    (
      await second.handler(
        new Request("https://auth.example.test/get-session", {
          headers: { "cf-connecting-ip": "192.0.2.11" }
        })
      )
    ).status,
    200
  );
});
