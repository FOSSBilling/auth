import type { Env } from "./types";

// Bound privileged use to the original sign-in, not the sliding expiresAt.
const CLIENT_ADMIN_MAX_AGE_MS = 15 * 60 * 1000;

export function canManageOAuthClients(
  env: Pick<Env, "ADMIN_USER_IDS">,
  user?: { id: string },
  session?: { userId: string; createdAt: Date; expiresAt: Date },
  now = Date.now()
): boolean {
  if (!user?.id || !session || session.userId !== user.id) return false;
  const admins = (env.ADMIN_USER_IDS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (!admins.includes(user.id)) return false;
  const createdAt = session.createdAt.getTime();
  const expiresAt = session.expiresAt.getTime();
  return (
    Number.isFinite(now) &&
    Number.isFinite(createdAt) &&
    Number.isFinite(expiresAt) &&
    createdAt <= now &&
    now - createdAt < CLIENT_ADMIN_MAX_AGE_MS &&
    expiresAt > now
  );
}
