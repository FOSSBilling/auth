import type { session, user } from "./db/schema";

export type Env = {
  AUTH_DB: D1Database;
  BETTER_AUTH_SECRET: string;
  BETTER_AUTH_URL?: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  ADMIN_EMAILS?: string;
};

export type AppSession = {
  session: Pick<typeof session.$inferSelect, "id" | "userId" | "expiresAt">;
  user: Pick<
    typeof user.$inferSelect,
    "id" | "name" | "email" | "emailVerified" | "image" | "githubLogin"
  >;
};
