import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// index.ts can't be imported by this runner (extensionless imports), so the
// policy is asserted against the source text. The Cloudflare Web Analytics
// beacon needs both: script-src to load it, connect-src to send its pings.
const source = readFileSync(
  new URL("../src/index.ts", import.meta.url),
  "utf8"
);

test("CSP allowlists the Cloudflare Web Analytics beacon", () => {
  assert.ok(
    source.includes(
      "script-src 'self' 'nonce-${nonce}' https://static.cloudflareinsights.com"
    ),
    "beacon script can load alongside the nonce"
  );
  assert.ok(
    source.includes("connect-src 'self' https://cloudflareinsights.com"),
    "beacon pings can be sent"
  );
});

test("CSP drops 'unsafe-inline' in favour of the per-request nonce", () => {
  assert.ok(!source.includes("'unsafe-inline'"));
});
