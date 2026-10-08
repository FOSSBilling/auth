// Expired private_key_jwt replay guards are no longer useful once the
// assertion's exp has passed. Delete in batches to bound each D1 statement.
const BATCH_SIZE = 500;

export async function deleteExpiredClientAssertions(
  db: Pick<D1Database, "prepare">,
  now = Date.now()
): Promise<number> {
  let deleted = 0;
  while (true) {
    const result = await db
      .prepare(
        `DELETE FROM oauthClientAssertion WHERE id IN (
          SELECT id FROM oauthClientAssertion
          WHERE expiresAt <= ?
          ORDER BY expiresAt
          LIMIT ${BATCH_SIZE}
        )`
      )
      .bind(now)
      .run();
    const changes = result.meta.changes;
    deleted += changes;
    if (changes < BATCH_SIZE) return deleted;
  }
}
