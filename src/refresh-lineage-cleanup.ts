// A deleted refresh lineage stays fenced until every token minted from it
// has expired. Refresh tokens live 30 days (refreshTokenExpiresIn in
// auth.ts), so a tombstone older than that can no longer block a live
// rotation. Delete in batches to bound each D1 statement.
export const REFRESH_LINEAGE_TOMBSTONE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const BATCH_SIZE = 500;

export async function deleteExpiredRefreshLineageTombstones(
  db: Pick<D1Database, "prepare">,
  now = Date.now()
): Promise<number> {
  let deleted = 0;
  while (true) {
    const result = await db
      .prepare(
        `DELETE FROM oauthRefreshLineageTombstone WHERE rowid IN (
          SELECT rowid FROM oauthRefreshLineageTombstone
          WHERE invalidatedAt <= ?
          ORDER BY invalidatedAt
          LIMIT ${BATCH_SIZE}
        )`
      )
      .bind(now - REFRESH_LINEAGE_TOMBSTONE_RETENTION_MS)
      .run();
    const changes = result.meta.changes;
    deleted += changes;
    if (changes < BATCH_SIZE) return deleted;
  }
}
