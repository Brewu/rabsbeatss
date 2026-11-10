import { Pool } from "pg";
import { resolve } from "node:path";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    console.log("Creating tables in Neon PostgreSQL...");

    await client.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY,
        reference TEXT NOT NULL UNIQUE,
        email TEXT NOT NULL,
        items_json TEXT NOT NULL,
        amount_pesewas INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'paid', 'failed')),
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        paid_at TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS storefront_beats (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        producer TEXT NOT NULL,
        genre TEXT NOT NULL,
        mood TEXT NOT NULL,
        bpm INTEGER NOT NULL,
        key_name TEXT NOT NULL,
        price INTEGER NOT NULL DEFAULT 0,
        cover TEXT NOT NULL DEFAULT 'cover-new',
        tag TEXT,
        tiktok_url TEXT,
        tiktok_thumbnail_url TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS bookings (
        id TEXT PRIMARY KEY,
        reference TEXT NOT NULL UNIQUE,
        artist_name TEXT NOT NULL,
        email TEXT NOT NULL,
        package_name TEXT NOT NULL,
        date TEXT NOT NULL,
        time_slot TEXT NOT NULL,
        total_pesewas INTEGER NOT NULL,
        deposit_pesewas INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending_payment', 'confirmed', 'expired', 'cancelled', 'payment_received_review')),
        expires_at TIMESTAMP NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        paid_at TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS bookings_date_status ON bookings(date, status, expires_at);

      CREATE TABLE IF NOT EXISTS notification_outbox (
        id SERIAL PRIMARY KEY,
        channel TEXT NOT NULL CHECK (channel IN ('email', 'whatsapp')),
        recipient TEXT NOT NULL,
        subject TEXT,
        body TEXT NOT NULL,
        html_body TEXT,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent')),
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        sent_at TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS notification_outbox_pending ON notification_outbox(status, id);

      CREATE TABLE IF NOT EXISTS push_subscriptions (
        endpoint_hash TEXT PRIMARY KEY,
        encrypted_subscription TEXT NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS client_accounts (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        password_salt TEXT,
        password_hash TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        last_login_at TIMESTAMP NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS client_beat_interactions (
        account_id TEXT NOT NULL REFERENCES client_accounts(id) ON DELETE CASCADE,
        beat_id INTEGER NOT NULL,
        interaction_count INTEGER NOT NULL DEFAULT 1,
        last_interacted_at TIMESTAMP NOT NULL DEFAULT NOW(),
        PRIMARY KEY (account_id, beat_id)
      );
      CREATE INDEX IF NOT EXISTS client_beat_interactions_recent ON client_beat_interactions(account_id, last_interacted_at);

      CREATE TABLE IF NOT EXISTS telegram_delivery_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        channel_url TEXT NOT NULL,
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS beat_delivery_passwords (
        beat_id INTEGER NOT NULL,
        license_id TEXT NOT NULL CHECK (license_id IN ('mp3', 'wav')),
        encrypted_password TEXT NOT NULL,
        updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
        PRIMARY KEY (beat_id, license_id)
      );

      CREATE TABLE IF NOT EXISTS beat_delivery_links (
        beat_id INTEGER PRIMARY KEY,
        encrypted_telegram_url TEXT NOT NULL,
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS storefront_packs (
        beat_id INTEGER PRIMARY KEY REFERENCES storefront_beats(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        category TEXT NOT NULL CHECK (category IN ('drumkit', 'samples')),
        price_pesewas INTEGER NOT NULL DEFAULT 20000 CHECK (price_pesewas = 20000),
        encrypted_telegram_url TEXT NOT NULL,
        encrypted_password TEXT NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);

    await client.query("COMMIT");
    console.log("✅ PostgreSQL schema migration completed successfully!");
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("❌ Migration failed:", e);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
