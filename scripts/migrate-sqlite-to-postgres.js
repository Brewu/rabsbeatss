import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import pg from "pg";

const databaseUrl = process.env.DATABASE_URL?.trim();
const sqlitePath = resolve(process.cwd(), process.env.DATABASE_PATH ?? "data/rabsbeats.sqlite");
if (!databaseUrl) throw new Error("Set DATABASE_URL to the Neon connection string before migrating.");
if (!existsSync(sqlitePath)) throw new Error(`The SQLite database was not found at ${sqlitePath}.`);

const tables = [
  "storefront_beats",
  "client_accounts",
  "orders",
  "bookings",
  "notification_outbox",
  "push_subscriptions",
  "telegram_delivery_settings",
  "beat_delivery_links",
  "beat_delivery_passwords",
  "storefront_packs",
  "client_beat_interactions",
];
const serialTables = ["storefront_beats", "notification_outbox"];
const sqlite = new DatabaseSync(sqlitePath);
const connectionUrl = new URL(databaseUrl);
connectionUrl.searchParams.delete("sslmode");
const pool = new pg.Pool({
  connectionString: connectionUrl.toString(),
  ssl: { rejectUnauthorized: true },
  max: 1,
  connectionTimeoutMillis: 10_000,
});

try {
  const connection = await pool.connect();
  try {
    const missingTables = [];
    for (const table of tables) {
      const { rows } = await connection.query("SELECT to_regclass($1) AS table_name", [`public.${table}`]);
      if (!rows[0].table_name) missingTables.push(table);
    }
    if (missingTables.length) {
      throw new Error(`The PostgreSQL schema is not initialized (${missingTables.join(", ")} missing). Start the app once with DATABASE_URL set, then retry.`);
    }

    for (const table of tables) {
      const { rows } = await connection.query(`SELECT COUNT(*)::int AS count FROM "${table}"`);
      if (rows[0].count > 0) throw new Error(`PostgreSQL table "${table}" is not empty. Refusing to duplicate or overwrite data.`);
    }

    await connection.query("BEGIN");
    const migrated = {};
    for (const table of tables) {
      const columns = sqlite.prepare(`PRAGMA table_info("${table}")`).all().map(({ name }) => name);
      if (!columns.length) continue;
      const rows = sqlite.prepare(`SELECT * FROM "${table}"`).all();
      migrated[table] = rows.length;
      const quotedColumns = columns.map((column) => `"${column}"`).join(", ");
      const maxRowsPerBatch = Math.max(1, Math.floor(60_000 / columns.length));
      for (let offset = 0; offset < rows.length; offset += maxRowsPerBatch) {
        const batch = rows.slice(offset, offset + maxRowsPerBatch);
        const values = [];
        const placeholders = batch.map((row, rowIndex) => {
          const rowPlaceholders = columns.map((column, columnIndex) => {
            values.push(row[column]);
            return `$${rowIndex * columns.length + columnIndex + 1}`;
          });
          return `(${rowPlaceholders.join(", ")})`;
        });
        await connection.query(
          `INSERT INTO "${table}" (${quotedColumns}) VALUES ${placeholders.join(", ")}`,
          values,
        );
      }
    }

    for (const table of serialTables) {
      await connection.query(
        `SELECT setval(pg_get_serial_sequence($1, 'id'), COALESCE(MAX(id), 1), COUNT(*) > 0) FROM "${table}"`,
        [table],
      );
    }
    await connection.query("COMMIT");
    console.log(`Migrated SQLite data to PostgreSQL: ${JSON.stringify(migrated)}`);
  } catch (error) {
    await connection.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
} finally {
  sqlite.close();
  await pool.end();
}
