import type { DBAdapter, DBTransactionAdapter } from "better-auth";

// D1 cannot run Better Auth's callback-style transaction. Its Drizzle adapter
// therefore creates a new OAuth user before attempting the account insert.
// If the account's unique provider binding loses a race, remove only that
// newly created, still-unbound user before Better Auth returns an error.
export function cleanupFailedAccountCreation(
  adapter: DBAdapter,
  removeUnboundUser: (userId: string) => Promise<void>
): DBAdapter {
  adapter.transaction = async (callback) => {
    let createdUserId: string | undefined;
    const trackedAdapter: DBTransactionAdapter = {
      ...adapter,
      create: (async (input) => {
        try {
          const row = await adapter.create(input);
          if (input.model === "user") {
            const id = (row as { id?: unknown })?.id;
            if (typeof id === "string") createdUserId = id;
          }
          return row;
        } catch (error) {
          if (
            input.model === "account" &&
            createdUserId &&
            input.data.userId === createdUserId
          ) {
            await removeUnboundUser(createdUserId);
          }
          throw error;
        }
      }) as DBTransactionAdapter["create"]
    };
    return callback(trackedAdapter);
  };
  return adapter;
}
