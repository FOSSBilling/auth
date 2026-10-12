// Expired private_key_jwt replay guards are no longer useful once the
// assertion's exp has passed. A deleted refresh lineage stays fenced until
// every token minted from it has expired: refresh tokens live 30 days
// (refreshTokenExpiresIn in auth.ts), so a tombstone older than that can no
// longer block a live rotation. Delete in batches to bound each D1 statement.
export const REFRESH_LINEAGE_TOMBSTONE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const BATCH_SIZE = 500;

async function deleteExpiredRows(
  db: Pick<D1Database, "prepare">,
  table: string,
  key: "id" | "rowid",
  column: string,
  cutoff: number
): Promise<number> {
  let deleted = 0;
  while (true) {
    const result = await db
      .prepare(
        `DELETE FROM ${table} WHERE ${key} IN (
          SELECT ${key} FROM ${table}
          WHERE ${column} <= ?
          ORDER BY ${column}
          LIMIT ${BATCH_SIZE}
        )`
      )
      .bind(cutoff)
      .run();
    const changes = result.meta.changes;
    deleted += changes;
    if (changes < BATCH_SIZE) return deleted;
  }
}

export function deleteExpiredClientAssertions(
  db: Pick<D1Database, "prepare">,
  now = Date.now()
): Promise<number> {
  return deleteExpiredRows(db, "oauthClientAssertion", "id", "expiresAt", now);
}

export function deleteExpiredRefreshLineageTombstones(
  db: Pick<D1Database, "prepare">,
  now = Date.now()
): Promise<number> {
  return deleteExpiredRows(
    db,
    "oauthRefreshLineageTombstone",
    "rowid",
    "invalidatedAt",
    now - REFRESH_LINEAGE_TOMBSTONE_RETENTION_MS
  );
}
