import type { Context } from "hono";
import type { Env } from "./types";
import { authorizePreviewCallbacks } from "./github-actions-oidc";

const callback =
  /^https:\/\/[a-z0-9][a-z0-9-]*-extensions\.fossbilling\.workers\.dev\/auth\/callback$/;

// Only the auth administrator selects which client this workflow can update.
export async function syncPreviewCallbacks(c: Context<{ Bindings: Env }>) {
  c.header("Cache-Control", "no-store");
  const clientId = c.env.EXTENSIONS_PREVIEW_CLIENT_ID;
  if (!clientId)
    return c.json({ error: "Preview client is not configured" }, 503);
  const authorization = c.req.header("Authorization");
  if (!authorization?.startsWith("Bearer "))
    return c.json({ error: "Unauthorized" }, 401);
  try {
    if (!(await authorizePreviewCallbacks(authorization.slice(7)))) {
      return c.json({ error: "Forbidden" }, 403);
    }
  } catch {
    return c.json({ error: "Unauthorized" }, 401);
  }
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid callbacks" }, 400);
  }
  if (
    !Array.isArray(body) ||
    body.length > 100 ||
    body.some((uri) => typeof uri !== "string" || !callback.test(uri))
  ) {
    return c.json({ error: "Invalid callbacks" }, 400);
  }
  const result = await c.env.AUTH_DB.prepare(
    "UPDATE oauthClient SET redirectUris = ?, updatedAt = ? WHERE clientId = ? RETURNING clientId"
  )
    .bind(JSON.stringify([...new Set(body)]), Date.now(), clientId)
    .first();
  if (!result) return c.json({ error: "Preview client not found" }, 404);
  return c.body(null, 204);
}
