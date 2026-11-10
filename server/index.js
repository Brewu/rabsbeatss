import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import express from "express";
import nodemailer from "nodemailer";
import pg from "pg";
import { z } from "zod";

const require = createRequire(import.meta.url);
const webpush = require("web-push");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.PORT ?? 8787);
const databasePath = resolve(root, process.env.DATABASE_PATH ?? "data/rabsbeats.sqlite");
const postgresEnabled = Boolean(process.env.DATABASE_URL);
if (process.env.NODE_ENV === "production" && !postgresEnabled) {
  throw new Error("DATABASE_URL is required in production so orders and bookings use persistent PostgreSQL storage.");
}
const appUrl = (process.env.APP_URL ?? process.env.RENDER_EXTERNAL_URL ?? `http://localhost:${port}`).replace(/\/+$/, "");
const reservationMinutes = 20;
const derivePasswordHash = promisify(scrypt);
const maximumCatalogBeats = 500;
const pushPublicKey = process.env.VAPID_PUBLIC_KEY?.trim() ?? "";
const pushPrivateKey = process.env.VAPID_PRIVATE_KEY?.trim() ?? "";
const pushSubject = process.env.VAPID_SUBJECT?.trim() || `mailto:${process.env.GMAIL_USER?.trim() || "brewurichard95@gmail.com"}`;
const pushConfigured = Boolean(pushPublicKey && pushPrivateKey);
if (pushConfigured) webpush.setVapidDetails(pushSubject, pushPublicKey, pushPrivateKey);

const catalog = new Map();
const packs = new Map();
const packPricePesewas = 20000;
const licenses = new Map([
  ["mp3", { name: "MP3 Lease", amount: 15000 }],
  ["wav", { name: "WAV Lease", amount: 35000 }],
]);
const sessionPackages = new Map([
  ["Artist Brings Own Beat", 30000],
  ["Custom Beat Making", 35000],
  ["Custom Beatmaking + Recording", 60000],
  ["Song Mixing Session Only", 30000],
]);
const sessionSlots = new Map([
  ["morning", "9:00 AM – 1:00 PM"],
  ["afternoon", "3:00 PM – 7:00 PM"],
]);

const transactionContext = new AsyncLocalStorage();
const sqlite = postgresEnabled ? null : (() => {
  mkdirSync(dirname(databasePath), { recursive: true });
  return new DatabaseSync(databasePath);
})();
const postgresPool = postgresEnabled ? new pg.Pool({
  connectionString: postgresConnectionString(process.env.DATABASE_URL),
  ssl: { rejectUnauthorized: true },
  max: 5,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
}) : null;

function toPostgresSql(sql) {
  let parameterIndex = 0;
  return sql
    .replace(/`/g, '"')
    .replace(/\bINTEGER\s+PRIMARY KEY\s+AUTOINCREMENT\b/gi, "SERIAL PRIMARY KEY")
    .replace(/\b(created_at|updated_at|last_login_at|last_interacted_at|sent_at|paid_at|expires_at)\s+TEXT\b/gi, "$1 TIMESTAMPTZ")
    .replace(/\bINSERT\s+OR\s+IGNORE\s+INTO\b/gi, "INSERT INTO")
    .replace(/datetime\('now'\s*,\s*\?\)/gi, "NOW() + (?::interval)")
    .replace(/datetime\('now'\)/gi, "NOW()")
    .replace(/\bMIN\(([^(),]+),\s*([^()]+)\)/gi, "LEAST($1, $2)")
    .replace(/\bMAX\(([^(),]+),\s*([^()]+)\)/gi, "GREATEST($1, $2)")
    .replace(/\?/g, () => `$${++parameterIndex}`);
}

function postgresConnectionString(value) {
  const url = new URL(value);
  url.searchParams.delete("sslmode");
  return url.toString();
}

const db = {
  prepare(sql) {
    return Object.fromEntries(["get", "all", "run"].map((method) => [method, async (...params) => {
      if (postgresPool) {
        const connection = transactionContext.getStore() ?? postgresPool;
        const result = await connection.query(toPostgresSql(sql), params);
        if (method === "get") return result.rows[0];
        if (method === "all") return result.rows;
        return { changes: result.rowCount, rows: result.rows };
      }
      const statement = sqlite.prepare(sql);
      if (method === "get") return statement.get(...params);
      if (method === "all") return statement.all(...params);
      const result = statement.run(...params);
      return { changes: result.changes, lastInsertRowid: result.lastInsertRowid };
    }]));
  },
  async exec(sql) {
    if (postgresPool) {
      const postgresSql = sql.replace(/^\s*PRAGMA[^;]*;?/gim, "");
      if (postgresSql.trim()) return postgresPool.query(toPostgresSql(postgresSql));
      return;
    }
    return sqlite.exec(sql);
  },
  async close() {
    if (postgresPool) return postgresPool.end();
    return sqlite.close();
  },
};

await db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    reference TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL,
    items_json TEXT NOT NULL,
    amount_pesewas INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'paid', 'failed')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    paid_at TEXT
  );
  CREATE TABLE IF NOT EXISTS storefront_beats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
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
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
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
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    paid_at TEXT
  );
  CREATE INDEX IF NOT EXISTS bookings_date_status ON bookings(date, status, expires_at);
  CREATE UNIQUE INDEX IF NOT EXISTS bookings_active_slot ON bookings(date, time_slot)
    WHERE status IN ('confirmed', 'pending_payment');
  CREATE TABLE IF NOT EXISTS notification_outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel TEXT NOT NULL CHECK (channel IN ('email', 'whatsapp')),
    recipient TEXT NOT NULL,
    subject TEXT,
    body TEXT NOT NULL,
    html_body TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent')),
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    sent_at TEXT
  );
  CREATE INDEX IF NOT EXISTS notification_outbox_pending ON notification_outbox(status, id);
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    endpoint_hash TEXT PRIMARY KEY,
    encrypted_subscription TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS client_accounts (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    password_salt TEXT,
    password_hash TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_login_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS client_beat_interactions (
    account_id TEXT NOT NULL REFERENCES client_accounts(id) ON DELETE CASCADE,
    beat_id INTEGER NOT NULL,
    interaction_count INTEGER NOT NULL DEFAULT 1,
    last_interacted_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (account_id, beat_id)
  );
  CREATE INDEX IF NOT EXISTS client_beat_interactions_recent ON client_beat_interactions(account_id, last_interacted_at);
  CREATE TABLE IF NOT EXISTS telegram_delivery_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    channel_url TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS beat_delivery_passwords (
    beat_id INTEGER NOT NULL,
    license_id TEXT NOT NULL CHECK (license_id IN ('mp3', 'wav')),
    encrypted_password TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (beat_id, license_id)
  );
  CREATE TABLE IF NOT EXISTS beat_delivery_links (
    beat_id INTEGER PRIMARY KEY,
    encrypted_telegram_url TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS storefront_packs (
    beat_id INTEGER PRIMARY KEY REFERENCES storefront_beats(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    category TEXT NOT NULL CHECK (category IN ('drumkit', 'samples')),
    price_pesewas INTEGER NOT NULL DEFAULT 20000 CHECK (price_pesewas = 20000),
    encrypted_telegram_url TEXT NOT NULL,
    encrypted_password TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);
if (postgresPool) {
  await db.exec("ALTER TABLE notification_outbox ADD COLUMN IF NOT EXISTS html_body TEXT");
  await db.exec("ALTER TABLE storefront_beats ADD COLUMN IF NOT EXISTS tiktok_url TEXT");
  await db.exec("ALTER TABLE storefront_beats ADD COLUMN IF NOT EXISTS tiktok_thumbnail_url TEXT");
  await db.exec("ALTER TABLE client_accounts ADD COLUMN IF NOT EXISTS password_salt TEXT");
  await db.exec("ALTER TABLE client_accounts ADD COLUMN IF NOT EXISTS password_hash TEXT");
} else {
  const notificationColumns = new Set(await db.prepare("PRAGMA table_info(notification_outbox)").all().then((rows) => rows.map((column) => column.name)));
  if (!notificationColumns.has("html_body")) await db.exec("ALTER TABLE notification_outbox ADD COLUMN html_body TEXT");
  const storefrontBeatColumns = new Set(await db.prepare("PRAGMA table_info(storefront_beats)").all().then((rows) => rows.map((column) => column.name)));
  if (!storefrontBeatColumns.has("tiktok_url")) await db.exec("ALTER TABLE storefront_beats ADD COLUMN tiktok_url TEXT");
  if (!storefrontBeatColumns.has("tiktok_thumbnail_url")) await db.exec("ALTER TABLE storefront_beats ADD COLUMN tiktok_thumbnail_url TEXT");
}
catalog.clear();
for (const beat of await db.prepare(`
  SELECT id, title, producer, genre, mood, bpm, key_name AS \`key\`, price, cover, tag,
    tiktok_url AS tiktokUrl, tiktok_thumbnail_url AS tiktokThumbnailUrl
  FROM storefront_beats ORDER BY id
`).all()) {
  catalog.set(beat.id, {
    ...beat,
    ...(beat.tag ? {} : { tag: undefined }),
    ...(beat.tiktokUrl ? {} : { tiktokUrl: undefined }),
    ...(beat.tiktokThumbnailUrl ? {} : { tiktokThumbnailUrl: undefined }),
  });
}
packs.clear();
for (const pack of await db.prepare(`
  SELECT beat_id AS beatId, title, price_pesewas AS pricePesewas
  FROM storefront_packs ORDER BY created_at DESC
`).all()) {
  packs.set(pack.beatId, {
    beatId: pack.beatId,
    title: pack.title,
    price: pack.pricePesewas / 100,
    cover: catalog.get(pack.beatId)?.cover ?? "cover-new",
  });
}
const legacyTelegramSettings = await db.prepare("SELECT channel_url FROM telegram_delivery_settings WHERE id = 1").get();
if (legacyTelegramSettings) {
  const migrateLegacyTelegramLink = db.prepare(`
    INSERT OR IGNORE INTO beat_delivery_links (beat_id, encrypted_telegram_url)
    SELECT DISTINCT beat_id, ? FROM beat_delivery_passwords
  `);
  if (postgresPool) {
    await db.prepare(`
      INSERT INTO beat_delivery_links (beat_id, encrypted_telegram_url)
      SELECT DISTINCT beat_id, ? FROM beat_delivery_passwords
      ON CONFLICT (beat_id) DO NOTHING
    `).run(encryptStoredValue(legacyTelegramSettings.channel_url));
  } else {
    await migrateLegacyTelegramLink.run(encryptStoredValue(legacyTelegramSettings.channel_url));
  }
}

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", process.env.TRUST_PROXY === "true" ? 1 : false);
app.use(express.json({
  limit: "32kb",
  verify(req, _res, buffer) {
    req.rawBody = Buffer.from(buffer);
  },
}));
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  next();
});

const emailSchema = z.string().trim().email().max(254);
const orderSchema = z.object({
  email: emailSchema,
  items: z.array(z.union([
    z.object({
      type: z.literal("pack"),
      beatId: z.number().int().positive(),
    }).strict(),
    z.object({
      type: z.literal("beat").optional(),
      beatId: z.number().int().positive(),
      licenseId: z.enum(["mp3", "wav"]),
    }).strict(),
  ])).min(1).max(20),
}).strict();
const bookingSchema = z.object({
  artistName: z.string().trim().min(1).max(100),
  email: emailSchema,
  packageName: z.string().trim().min(1).max(100),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  timeSlot: z.enum(["morning", "afternoon"]),
}).strict();
const loginSchema = z.object({ password: z.string().min(1).max(256) }).strict();
const accountCredentialsSchema = z.object({
  email: emailSchema,
  password: z.string().min(8).max(128),
}).strict();
const beatInteractionSchema = z.object({
  beatId: z.number().int().positive(),
  interactionCount: z.number().int().min(1).max(1000),
}).strict();
const tiktokUrlSchema = z.string().url().max(500).refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && ["tiktok.com", "www.tiktok.com", "m.tiktok.com"].includes(url.hostname.toLowerCase())
      && /^\/@[^/]+\/video\/\d+\/?$/.test(url.pathname)
      && !url.username
      && !url.password
      && !url.port;
  } catch {
    return false;
  }
}, "Enter a direct TikTok video URL.");
const telegramUrlSchema = z.string().url().max(500).refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && ["t.me", "www.t.me", "telegram.me", "www.telegram.me"].includes(url.hostname.toLowerCase())
      && url.pathname !== "/"
      && !url.search
      && !url.hash;
  } catch {
    return false;
  }
}, "Enter the direct HTTPS Telegram file link.");
const newBeatSchema = z.object({
  title: z.string().trim().min(1).max(100),
  genre: z.string().trim().min(1).max(40),
  mood: z.string().trim().min(1).max(40),
  bpm: z.number().int().min(40).max(240),
  key: z.string().trim().min(1).max(12),
  telegramUrl: telegramUrlSchema,
  tiktokUrl: z.union([tiktokUrlSchema, z.literal("")]).optional(),
  mp3Password: z.string().min(8).max(128),
  wavPassword: z.string().min(8).max(128),
  packIncluded: z.boolean().optional(),
  packCategory: z.union([z.enum(["drumkit", "samples"]), z.literal("")]).optional(),
  packTelegramUrl: z.union([telegramUrlSchema, z.literal("")]).optional(),
  packPassword: z.string().max(128).optional(),
}).strict();
const telegramDeliverySchema = z.object({
  beats: z.array(z.object({
    beatId: z.number().int().positive(),
    telegramUrl: z.union([telegramUrlSchema, z.literal("")]),
    tiktokUrl: z.union([tiktokUrlSchema, z.literal("")]).optional(),
  }).strict()).max(maximumCatalogBeats),
  passwords: z.array(z.object({
    beatId: z.number().int().positive(),
    licenseId: z.enum(["mp3", "wav"]),
    password: z.string().min(8).max(128),
  }).strict()).max(maximumCatalogBeats * 2),
  packs: z.array(z.object({
    beatId: z.number().int().positive(),
    telegramUrl: z.union([telegramUrlSchema, z.literal("")]),
    password: z.union([z.string().min(8).max(128), z.literal("")]),
  }).strict()).max(maximumCatalogBeats).default([]),
}).strict();
const pushSubscriptionSchema = z.object({
  endpoint: z.string().url().max(2000),
  expirationTime: z.number().nullable().optional(),
  keys: z.object({
    p256dh: z.string().min(20).max(200),
    auth: z.string().min(16).max(100),
  }).strict(),
}).strict();

function isSupportedPushEndpoint(endpoint) {
  try {
    const url = new URL(endpoint);
    const host = url.hostname.toLowerCase();
    return url.protocol === "https:"
      && !url.username
      && !url.password
      && !url.port
      && (host === "fcm.googleapis.com"
        || host === "updates.push.services.mozilla.com"
        || host === "web.push.apple.com"
        || host.endsWith(".notify.windows.com"));
  } catch {
    return false;
  }
}

async function getTikTokThumbnailUrl(videoUrl) {
  if (!videoUrl) return null;
  try {
    const parsedUrl = new URL(videoUrl);
    const canonicalUrl = `${parsedUrl.origin}${parsedUrl.pathname}`;
    const oembedResponse = await fetch(`https://www.tiktok.com/oembed?url=${encodeURIComponent(canonicalUrl)}`, {
      signal: AbortSignal.timeout(5000),
      headers: { Accept: "application/json" },
    });
    if (oembedResponse.ok) {
      const data = await oembedResponse.json();
      if (typeof data.thumbnail_url === "string") {
        const thumbnailUrl = new URL(data.thumbnail_url);
        if (
          thumbnailUrl.protocol === "https:"
          && [".tiktokcdn.com", ".tiktokcdn-us.com"].some((suffix) => thumbnailUrl.hostname.endsWith(suffix))
        ) return thumbnailUrl.toString();
      }
    }
    const videoResponse = await fetch(canonicalUrl, {
      signal: AbortSignal.timeout(8000),
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
      },
    });
    if (!videoResponse.ok) {
      console.warn(`TikTok video page returned ${videoResponse.status}; saving the video URL without a thumbnail.`);
      return null;
    }
    const html = await videoResponse.text();
    const videoId = parsedUrl.pathname.match(/\/video\/(\d+)/)?.[1];
    if (!videoId) return null;
    const escapedVideoId = videoId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const coverMatch = html.match(new RegExp(`"video":\\{"id":"${escapedVideoId}".{0,5000}?"(?:cover|originCover|dynamicCover)":"([^"]+)"`));
    if (!coverMatch) {
      console.warn("TikTok video page did not include cover metadata; saving the video URL without a thumbnail.");
      return null;
    }
    const coverValue = JSON.parse(`"${coverMatch[1]}"`);
    const thumbnailUrl = new URL(coverValue);
    return thumbnailUrl.protocol === "https:"
      && [".tiktokcdn.com", ".tiktokcdn-us.com"].some((suffix) => thumbnailUrl.hostname.endsWith(suffix))
      ? thumbnailUrl.toString()
      : null;
  } catch (error) {
    console.warn(`Could not load the TikTok thumbnail: ${error instanceof Error ? error.message : "unknown error"}`);
    return null;
  }
}

function encryptStoredValue(value) {
  if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
    throw new Error("SESSION_SECRET must remain configured to protect delivery credentials.");
  }
  const key = createHmac("sha256", process.env.SESSION_SECRET).update("rabsbeats:encrypted-storage:v1").digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `enc:v1:${iv.toString("base64url")}:${cipher.getAuthTag().toString("base64url")}:${ciphertext.toString("base64url")}`;
}

function decryptStoredValue(value) {
  if (!value.startsWith("enc:v1:")) return value;
  if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
    throw new Error("SESSION_SECRET must remain configured to read protected delivery credentials.");
  }
  const [, , ivValue, tagValue, ciphertextValue] = value.split(":");
  const key = createHmac("sha256", process.env.SESSION_SECRET).update("rabsbeats:encrypted-storage:v1").digest();
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivValue, "base64url"));
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextValue, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
const dateParam = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

function isValidDate(value) {
  const parsed = new Date(`${value}T12:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function isWeekday(value) {
  const day = new Date(`${value}T12:00:00.000Z`).getUTCDay();
  return day > 0 && day < 6;
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function adminSessionCookie(payload) {
  const value = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", process.env.SESSION_SECRET).update(value).digest("base64url");
  return `${value}.${signature}`;
}

function getAdminSession(req) {
  const cookieHeader = req.headers.cookie ?? "";
  const cookie = cookieHeader.split(";").map((part) => part.trim()).find((part) => part.startsWith("rb_admin="));
  if (!cookie || !process.env.SESSION_SECRET) return null;
  const token = decodeURIComponent(cookie.slice("rb_admin=".length));
  const [value, suppliedSignature] = token.split(".");
  if (!value || !suppliedSignature) return null;
  const expectedSignature = createHmac("sha256", process.env.SESSION_SECRET).update(value).digest("base64url");
  if (!safeEqual(suppliedSignature, expectedSignature)) return null;
  try {
    const payload = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (typeof payload.exp !== "number" || payload.exp <= Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function requireAdmin(req, res, next) {
  if (!getAdminSession(req)) return res.status(401).json({ error: "Studio sign-in required." });
  return next();
}

async function getClientSession(req) {
  const cookieHeader = req.headers.cookie ?? "";
  const cookie = cookieHeader.split(";").map((part) => part.trim()).find((part) => part.startsWith("rb_client="));
  if (!cookie || !process.env.SESSION_SECRET) return null;
  let token;
  try {
    token = decodeURIComponent(cookie.slice("rb_client=".length));
  } catch {
    return null;
  }
  const [value, suppliedSignature] = token.split(".");
  if (!value || !suppliedSignature) return null;
  const expectedSignature = createHmac("sha256", process.env.SESSION_SECRET).update(value).digest("base64url");
  if (!safeEqual(suppliedSignature, expectedSignature)) return null;
  try {
    const payload = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (typeof payload.exp !== "number" || payload.exp <= Date.now() || typeof payload.userId !== "string") return null;
    return await db.prepare("SELECT id, email FROM client_accounts WHERE id = ?").get(payload.userId) ?? null;
  } catch {
    return null;
  }
}

async function requireClient(req, res, next) {
  if (!await getClientSession(req)) return res.status(401).json({ error: "Client sign-in required." });
  return next();
}

function signedSession(payload) {
  const value = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", process.env.SESSION_SECRET).update(value).digest("base64url");
  return `${value}.${signature}`;
}

function setClientSessionCookie(res, account) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000;
  res.setHeader("Set-Cookie", `rb_client=${encodeURIComponent(signedSession({ userId: account.id, exp: expiresAt }))}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${secure}`);
}

function paystackConfigured() {
  const secretKey = process.env.PAYSTACK_SECRET_KEY?.trim();
  if (!secretKey) return false;
  if (!secretKey.startsWith("sk_live_")) return true;
  if (process.env.NODE_ENV !== "production") return false;
  try {
    const url = new URL(appUrl);
    const hostname = url.hostname.toLowerCase();
    const isLocalHost = hostname === "localhost"
      || hostname.endsWith(".localhost")
      || hostname === "::1"
      || hostname === "0.0.0.0"
      || /^127(?:\.\d{1,3}){3}$/.test(hostname)
      || /^10(?:\.\d{1,3}){3}$/.test(hostname)
      || /^192\.168(?:\.\d{1,3}){2}$/.test(hostname)
      || /^172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}$/.test(hostname);
    return url.protocol === "https:" && !isLocalHost;
  } catch {
    return false;
  }
}

function paymentUnavailable(res) {
  const hasLiveKey = process.env.PAYSTACK_SECRET_KEY?.trim().startsWith("sk_live_");
  const error = hasLiveKey
    ? "Live checkout is disabled until the app runs in production with a public HTTPS APP_URL. Use a Paystack test key for local testing."
    : "Online payments are not configured. Please contact RabsBeats to arrange payment.";
  return res.status(503).json({ error });
}

async function paystackRequest(path, body, method = "POST") {
  const response = await fetch(`https://api.paystack.co${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
      "Content-Type": "application/json",
    },
    ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15000),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || !result?.status) {
    throw new Error(result?.message ?? `Paystack request failed with status ${response.status}.`);
  }
  return result.data;
}

async function initializePayment({ email, amount, reference, metadata }) {
  return paystackRequest("/transaction/initialize", {
    email,
    amount,
    currency: "GHS",
    reference,
    callback_url: `${appUrl}/?payment=return`,
    metadata,
  });
}

async function createOutboxMessage(channel, recipient, subject, body, htmlBody = null) {
  await db.prepare("INSERT INTO notification_outbox (channel, recipient, subject, body, html_body) VALUES (?, ?, ?, ?, ?)")
    .run(channel, recipient, subject, encryptStoredValue(body), htmlBody ? encryptStoredValue(htmlBody) : null);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[character]);
}

function brandedEmail({ preheader, title, intro, content, footer = "RabsBeats · Independent sound. No shortcuts." }) {
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f3f2eb;font-family:Arial,sans-serif;color:#171814">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHtml(preheader)}</div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f3f2eb;padding:32px 12px"><tr><td align="center">
      <table role="presentation" width="600" cellspacing="0" cellpadding="0" style="max-width:600px;width:100%;background:#fff;border:1px solid #e4e3dc">
        <tr><td style="padding:24px 30px;background:#171814;color:#d3f36b;font-size:13px;font-weight:bold;letter-spacing:3px">RABSBEATS</td></tr>
        <tr><td style="padding:32px 30px 12px"><div style="font-size:10px;letter-spacing:2px;color:#7a7b71;text-transform:uppercase">MADE FOR THE MOMENT</div><h1 style="margin:12px 0;color:#171814;font-size:28px;line-height:1.2">${escapeHtml(title)}</h1><p style="margin:0;color:#55564f;font-size:15px;line-height:1.7">${escapeHtml(intro)}</p></td></tr>
        <tr><td style="padding:14px 30px 30px">${content}</td></tr>
        <tr><td style="padding:18px 30px;background:#f7f7f2;color:#77786e;font-size:11px;line-height:1.6">${escapeHtml(footer)}</td></tr>
      </table>
    </td></tr></table>
  </body></html>`;
}

function orderEmailHtml(order, items, delivery) {
  const purchaseRows = items.map((item) => `<tr><td style="padding:12px 0;border-bottom:1px solid #ecece5;color:#33352e;font-size:14px">${escapeHtml(item.title)}<div style="padding-top:4px;color:#77786e;font-size:12px">${escapeHtml(item.licenseName)}</div></td><td align="right" style="padding:12px 0;border-bottom:1px solid #ecece5;color:#171814;font-size:13px;white-space:nowrap">${escapeHtml(formatGhs(item.amount_pesewas))}</td></tr>`).join("");
  const deliveryContent = delivery
    ? delivery.items.map((item) => `<div style="margin-top:14px;padding:18px;border:1px solid #e5e7db;background:#fafbf6">
        <div style="font-size:13px;font-weight:bold;color:#171814">${escapeHtml(item.title)} · ${escapeHtml(item.licenseName)}</div>
        <div style="margin-top:14px;color:#77786e;font-size:10px;letter-spacing:1px;text-transform:uppercase">${escapeHtml(item.linkLabel)}</div>
        <p style="margin:7px 0 0"><a href="${escapeHtml(item.telegramUrl)}" style="color:#33451a;font-size:13px;font-weight:bold;overflow-wrap:anywhere">${escapeHtml(item.telegramUrl)}</a></p>
        <div style="margin-top:14px;color:#77786e;font-size:10px;letter-spacing:1px;text-transform:uppercase">${escapeHtml(item.passwordLabel)}</div>
        <div style="margin-top:7px;padding:11px 13px;background:#171814;color:#d3f36b;font-family:monospace;font-size:16px;letter-spacing:1px;overflow-wrap:anywhere">${escapeHtml(item.password)}</div>
      </div>`).join("")
    : `<div style="margin-top:16px;padding:15px;background:#fff8e7;border:1px solid #eadcae;color:#725d2f;font-size:13px;line-height:1.6">Your payment is confirmed. Please contact RabsBeats to receive your beat files.</div>`;
  const content = `<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td colspan="2" style="padding-bottom:8px;color:#77786e;font-size:10px;letter-spacing:1px">ORDER SUMMARY</td></tr>${purchaseRows}
    <tr><td style="padding-top:16px;color:#55564f;font-size:13px">Total paid</td><td align="right" style="padding-top:16px;color:#171814;font-size:16px;font-weight:bold">${escapeHtml(formatGhs(order.amount_pesewas))}</td></tr></table>
    <div style="margin-top:22px;padding-top:20px;border-top:1px solid #ecece5"><div style="color:#77786e;font-size:10px;letter-spacing:1px">ORDER REFERENCE</div><div style="margin-top:6px;color:#171814;font-family:monospace;font-size:13px">${escapeHtml(order.reference)}</div></div>
    <h2 style="margin:26px 0 5px;color:#171814;font-size:18px">Your files are ready</h2><p style="margin:0;color:#77786e;font-size:12px;line-height:1.6">Use each Telegram link to get your archive, then enter the matching password shown below to open it.</p>${deliveryContent}`;
  return brandedEmail({
    preheader: `Your RabsBeats order is confirmed. Your files and archive details are inside.`,
    title: "Your order is confirmed",
    intro: "Thanks for supporting RabsBeats. Your payment is confirmed and your purchased files are below.",
    content,
  });
}

async function getOrderDelivery(items) {
  const deliveryItems = [];
  for (const item of items) {
    if (item.type === "pack") {
      const pack = await db.prepare(`
        SELECT title, category, encrypted_telegram_url AS encryptedTelegramUrl, encrypted_password AS encryptedPassword
        FROM storefront_packs WHERE beat_id = ?
      `).get(item.beatId);
      if (!pack) return null;
      deliveryItems.push({
        title: item.title,
        licenseName: item.licenseName,
        telegramUrl: decryptStoredValue(pack.encryptedTelegramUrl),
        password: decryptStoredValue(pack.encryptedPassword),
        linkLabel: "Your Drum Kit & Samples ZIP",
        passwordLabel: "Pack WinRAR password",
      });
      continue;
    }
    const savedLink = await db.prepare(`
      SELECT encrypted_telegram_url AS encryptedTelegramUrl
      FROM beat_delivery_links
      WHERE beat_id = ?
    `).get(item.beatId);
    const saved = await db.prepare(`
      SELECT encrypted_password AS encryptedPassword
      FROM beat_delivery_passwords
      WHERE beat_id = ? AND license_id = ?
    `).get(item.beatId, item.licenseId);
    if (!savedLink || !saved) return null;
    deliveryItems.push({
      title: item.title,
      licenseName: item.licenseName,
      telegramUrl: decryptStoredValue(savedLink.encryptedTelegramUrl),
      password: decryptStoredValue(saved.encryptedPassword),
      linkLabel: "Your beat file",
      passwordLabel: "WinRAR password",
    });
  }
  return { items: deliveryItems };
}

async function isOrderDeliveryConfigured(items) {
  for (const item of items) {
    if (item.type === "pack") {
      const pack = await db.prepare("SELECT 1 FROM storefront_packs WHERE beat_id = ? AND encrypted_telegram_url <> '' AND encrypted_password <> ''").get(item.beatId);
      if (!pack) return false;
      continue;
    }
    const link = await db.prepare("SELECT 1 FROM beat_delivery_links WHERE beat_id = ?").get(item.beatId);
    const selectedPassword = await db.prepare("SELECT encrypted_password AS encryptedPassword FROM beat_delivery_passwords WHERE beat_id = ? AND license_id = ?").get(item.beatId, item.licenseId);
    const otherLicense = item.licenseId === "mp3" ? "wav" : "mp3";
    const otherPassword = await db.prepare("SELECT encrypted_password AS encryptedPassword FROM beat_delivery_passwords WHERE beat_id = ? AND license_id = ?").get(item.beatId, otherLicense);
    if (!link || !selectedPassword || (otherPassword && decryptStoredValue(selectedPassword.encryptedPassword) === decryptStoredValue(otherPassword.encryptedPassword))) return false;
  }
  return true;
}

async function queuePaidOrderNotifications(order) {
  const items = JSON.parse(order.items_json);
  const details = items.map((item) => `${item.title} — ${item.licenseName} (${formatGhs(item.amount_pesewas)})`).join("\n");
  const delivery = await getOrderDelivery(items);
  const deliveryDetails = delivery
    ? `\n\nYour purchased files are ready in Telegram:\n\n${delivery.items.map((item) => `${item.title} — ${item.licenseName}\nTelegram file: ${item.telegramUrl}\n${item.passwordLabel}: ${item.password}`).join("\n\n")}`
    : "\n\nYour payment is confirmed. Please contact RabsBeats to receive your files.";
  await createOutboxMessage(
    "email",
    order.email,
    `Your RabsBeats order ${order.reference} is confirmed`,
    `Thanks for your order.\n\n${details}\n\nTotal paid: ${formatGhs(order.amount_pesewas)}\nReference: ${order.reference}${deliveryDetails}`,
    orderEmailHtml(order, items, delivery),
  );
  if (process.env.GMAIL_USER?.trim()) {
    const adminDetails = `<div style="padding:16px;border:1px solid #e5e7db;background:#fafbf6;color:#33352e;font-size:13px;line-height:1.8"><strong>Buyer:</strong> ${escapeHtml(order.email)}<br><strong>Items:</strong> ${items.map((item) => `${escapeHtml(item.title)} — ${escapeHtml(item.licenseName)}`).join("<br>")}<br><strong>Total:</strong> ${escapeHtml(formatGhs(order.amount_pesewas))}<br><strong>Reference:</strong> ${escapeHtml(order.reference)}</div>`;
    await createOutboxMessage(
      "email",
      process.env.GMAIL_USER.trim(),
      `New RabsBeats order — ${order.reference}`,
      `New paid order\n${details}\nTotal: ${formatGhs(order.amount_pesewas)}\nBuyer: ${order.email}\nReference: ${order.reference}`,
      brandedEmail({
        preheader: `A new beat order has been paid: ${order.reference}`,
        title: "New purchase",
        intro: "A customer has completed payment for a RabsBeats order.",
        content: adminDetails,
        footer: "RabsBeats Studio · Purchase notification",
      }),
    );
  }
}

async function recordPurchasedBeatInteractions(order) {
  const account = await db.prepare("SELECT id FROM client_accounts WHERE lower(email) = ?").get(order.email.toLowerCase());
  if (!account) return;
  const recordInteraction = db.prepare(`
    INSERT INTO client_beat_interactions (account_id, beat_id, interaction_count)
    VALUES (?, ?, 1)
    ON CONFLICT(account_id, beat_id) DO UPDATE SET
      interaction_count = MIN(interaction_count + 1, 1000),
      last_interacted_at = datetime('now')
  `);
  for (const item of JSON.parse(order.items_json)) {
    if (catalog.has(item.beatId)) await recordInteraction.run(account.id, item.beatId);
  }
}

async function queuePaidBookingNotifications(booking) {
  const date = new Date(`${booking.date}T12:00:00.000Z`).toLocaleDateString("en-GH", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
  const slot = sessionSlots.get(booking.time_slot);
  const total = formatGhs(booking.total_pesewas);
  const deposit = formatGhs(booking.deposit_pesewas);
  await createOutboxMessage(
    "email",
    booking.email,
    `Studio session confirmed — ${date}`,
    `Hi ${booking.artist_name},\n\nYour 4-hour RabsBeats studio session is confirmed.\n\nPackage: ${booking.package_name}\nDate: ${date}\nTime: ${slot}\nSession total: ${total}\nDeposit paid: ${deposit}\nPayment reference: ${booking.reference}\n\nPlease arrive on time. Your session files are kept for 30 days. Reply to this email if you need help.`,
  );
}

async function queueManualReviewNotifications(booking) {
  await createOutboxMessage(
    "email",
    booking.email,
    "We received your RabsBeats session deposit",
    `Hi ${booking.artist_name},\n\nWe received your deposit for ${booking.package_name} on ${booking.date}, but the selected slot needs manual review. RabsBeats will contact you shortly to confirm the session or arrange next steps.\n\nPayment reference: ${booking.reference}`,
  );
}

function formatGhs(pesewas) {
  return `GH₵${(pesewas / 100).toFixed(2)}`;
}

async function transaction(callback) {
  if (postgresPool) {
    const connection = await postgresPool.connect();
    try {
      await connection.query("BEGIN");
      const result = await transactionContext.run(connection, callback);
      await connection.query("COMMIT");
      return result;
    } catch (error) {
      await connection.query("ROLLBACK");
      throw error;
    } finally {
      connection.release();
    }
  }
  await db.exec("BEGIN IMMEDIATE");
  try {
    const result = await callback();
    await db.exec("COMMIT");
    return result;
  } catch (error) {
    await db.exec("ROLLBACK");
    throw error;
  }
}

async function sendEmail(message) {
  const gmailUser = process.env.GMAIL_USER?.trim();
  const gmailAppPassword = process.env.GMAIL_APP_PASSWORD?.replace(/\s/g, "");
  if (!gmailUser || !gmailAppPassword) {
    throw new Error("Gmail delivery is not configured. Set GMAIL_USER and GMAIL_APP_PASSWORD.");
  }
  const body = decryptStoredValue(message.body);
  const html = message.htmlBody ? decryptStoredValue(message.htmlBody) : undefined;
  const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user: gmailUser, pass: gmailAppPassword },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 20000,
  });
  try {
    await transporter.sendMail({
      from: {
        name: process.env.EMAIL_FROM_NAME?.trim() || "RabsBeats",
        address: gmailUser,
      },
      to: message.recipient,
      subject: message.subject,
      text: body,
      ...(html ? { html } : {}),
    });
  } finally {
    transporter.close();
  }
}

let flushingNotifications = false;
async function flushNotificationOutbox() {
  if (flushingNotifications) return;
  flushingNotifications = true;
  try {
    const pending = await db.prepare("SELECT id, channel, recipient, subject, body, html_body AS htmlBody, attempts FROM notification_outbox WHERE channel = 'email' AND status = 'pending' AND attempts < 10 ORDER BY id LIMIT 20").all();
    for (const message of pending) {
      try {
        await sendEmail(message);
        await db.prepare("UPDATE notification_outbox SET status = 'sent', attempts = attempts + 1, last_error = NULL, sent_at = datetime('now') WHERE id = ?").run(message.id);
      } catch (error) {
        const safeError = error instanceof Error ? error.message.slice(0, 300) : "Unknown notification error.";
        await db.prepare("UPDATE notification_outbox SET attempts = attempts + 1, last_error = ? WHERE id = ?").run(safeError, message.id);
        console.error(`Notification ${message.id} (${message.channel}) failed: ${safeError}`);
      }
    }
  } finally {
    flushingNotifications = false;
  }
}

function addDays(date, days) {
  const result = new Date(`${date}T12:00:00.000Z`);
  result.setUTCDate(result.getUTCDate() + days);
  return result.toISOString().slice(0, 10);
}

async function clearExpiredReservations() {
  await db.prepare("UPDATE bookings SET status = 'expired' WHERE status = 'pending_payment' AND expires_at <= datetime('now')").run();
}

app.get("/api/health", async (_req, res) => {
  await db.prepare("SELECT 1").get();
  res.json({
    ok: true,
    paymentsEnabled: paystackConfigured(),
    emailEnabled: Boolean(process.env.GMAIL_USER?.trim() && process.env.GMAIL_APP_PASSWORD?.trim()),
    pushEnabled: pushConfigured,
  });
});

app.get("/api/push/config", (_req, res) => {
  return res.json({ enabled: pushConfigured, publicKey: pushConfigured ? pushPublicKey : null });
});

function hashPushEndpoint(endpoint) {
  if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
    throw new Error("SESSION_SECRET must remain configured to protect push subscriptions.");
  }
  return createHmac("sha256", process.env.SESSION_SECRET)
    .update(`rabsbeats:push-endpoint:v1:${endpoint}`)
    .digest("hex");
}

app.post("/api/push/subscriptions", async (req, res) => {
  if (!pushConfigured) return res.status(503).json({ error: "Beat alerts are not configured on the server yet." });
  const parsed = pushSubscriptionSchema.safeParse(req.body);
  if (!parsed.success || !isSupportedPushEndpoint(parsed.data?.endpoint ?? "")) {
    return res.status(400).json({ error: "Invalid browser notification subscription." });
  }
  try {
    const endpointHash = hashPushEndpoint(parsed.data.endpoint);
    if (!await db.prepare("SELECT 1 FROM push_subscriptions WHERE endpoint_hash = ?").get(endpointHash)) {
      const { count } = await db.prepare("SELECT COUNT(*) AS count FROM push_subscriptions").get();
      if (count >= 10000) return res.status(503).json({ error: "Beat alert subscriptions are temporarily full. Please try again later." });
    }
    await db.prepare(`
      INSERT INTO push_subscriptions (endpoint_hash, encrypted_subscription)
      VALUES (?, ?)
      ON CONFLICT(endpoint_hash) DO UPDATE SET
        encrypted_subscription = excluded.encrypted_subscription,
        updated_at = datetime('now')
    `).run(endpointHash, encryptStoredValue(JSON.stringify(parsed.data)));
    return res.status(201).json({ subscribed: true });
  } catch (error) {
    return res.status(503).json({ error: error instanceof Error ? error.message : "Could not save notification settings." });
  }
});

app.delete("/api/push/subscriptions", async (req, res) => {
  const parsed = pushSubscriptionSchema.safeParse(req.body);
  if (!parsed.success || !isSupportedPushEndpoint(parsed.data?.endpoint ?? "")) {
    return res.status(400).json({ error: "Invalid browser notification subscription." });
  }
  try {
    await db.prepare("DELETE FROM push_subscriptions WHERE endpoint_hash = ?").run(hashPushEndpoint(parsed.data.endpoint));
    return res.json({ subscribed: false });
  } catch (error) {
    return res.status(503).json({ error: error instanceof Error ? error.message : "Could not update notification settings." });
  }
});

async function notifyPushSubscribers(payload) {
  if (!pushConfigured) return;
  const subscriptions = await db.prepare("SELECT endpoint_hash AS endpointHash, encrypted_subscription AS encryptedSubscription FROM push_subscriptions").all();
  await Promise.all(subscriptions.map(async (row) => {
    try {
      const subscription = JSON.parse(decryptStoredValue(row.encryptedSubscription));
      await webpush.sendNotification(subscription, JSON.stringify(payload), { TTL: 60 * 60 });
    } catch (error) {
      if (error?.statusCode === 404 || error?.statusCode === 410) {
        await db.prepare("DELETE FROM push_subscriptions WHERE endpoint_hash = ?").run(row.endpointHash);
      } else {
        const status = Number.isInteger(error?.statusCode) ? `HTTP ${error.statusCode}` : "delivery error";
        console.error(`Web push notification failed (${status}).`);
      }
    }
  }));
}

app.get("/api/catalog", (_req, res) => {
  return res.json({ beats: [...catalog.values()], packs: [...packs.values()] });
});

app.get("/api/availability", async (req, res) => {
  const from = dateParam.safeParse(req.query.from);
  const to = dateParam.safeParse(req.query.to);
  if (!from.success || !to.success || !isValidDate(from.data) || !isValidDate(to.data)) {
    return res.status(400).json({ error: "Valid from and to dates are required." });
  }
  if (to.data < from.data || to.data > addDays(from.data, 34)) {
    return res.status(400).json({ error: "Availability range must be 35 days or less." });
  }
  await clearExpiredReservations();
  const slots = await db.prepare(`
    SELECT date, time_slot AS timeSlot
    FROM bookings
    WHERE date >= ? AND date <= ?
      AND status IN ('confirmed', 'pending_payment')
  `).all(from.data, to.data);
  return res.json({ slots });
});

app.post("/api/checkout/orders", async (req, res, next) => {
  if (!paystackConfigured()) return paymentUnavailable(res);
  const parsed = orderSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Provide a valid email address and one or more available products." });
  const customerEmail = parsed.data.email.toLowerCase();

  const items = [];
  for (const requested of parsed.data.items) {
    if (requested.type === "pack") {
      const pack = packs.get(requested.beatId);
      if (!pack) return res.status(400).json({ error: "One or more selected drum kits or sample packs are unavailable." });
      items.push({
        type: "pack",
        beatId: pack.beatId,
        title: pack.title,
        licenseName: "Drum Kit & Samples Pack",
        amount_pesewas: packPricePesewas,
      });
      continue;
    }
    const beat = catalog.get(requested.beatId);
    const license = licenses.get(requested.licenseId);
    if (!beat || !license) return res.status(400).json({ error: "One or more selected beats or licenses are unavailable." });
    items.push({ type: "beat", beatId: beat.id, title: beat.title, licenseId: requested.licenseId, licenseName: license.name, amount_pesewas: license.amount });
  }
  if (!await isOrderDeliveryConfigured(items)) {
    return res.status(503).json({ error: "Delivery is not set up for one or more selected products. Please contact RabsBeats." });
  }
  const amount = items.reduce((sum, item) => sum + item.amount_pesewas, 0);
  const id = randomUUID();
  const reference = `rb_${randomUUID().replaceAll("-", "")}`;
  await db.prepare("INSERT INTO orders (id, reference, email, items_json, amount_pesewas, status) VALUES (?, ?, ?, ?, ?, 'pending')")
    .run(id, reference, customerEmail, JSON.stringify(items), amount);
  try {
    const payment = await initializePayment({
      email: customerEmail,
      amount,
      reference,
      metadata: { order_id: id, type: "beat_order" },
    });
    return res.status(201).json({ authorizationUrl: payment.authorization_url, reference });
  } catch (error) {
    await db.prepare("UPDATE orders SET status = 'failed' WHERE id = ? AND status = 'pending'").run(id);
    return next(error);
  }
});

app.post("/api/bookings", async (req, res, next) => {
  if (!paystackConfigured()) return paymentUnavailable(res);
  const parsed = bookingSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Provide a valid name, email, package, weekday, and session time." });
  const booking = { ...parsed.data, email: parsed.data.email.toLowerCase() };
  const total = sessionPackages.get(booking.packageName);
  if (!total) return res.status(400).json({ error: "That studio package is not available." });
  if (!isValidDate(booking.date) || !isWeekday(booking.date) || booking.date <= new Date().toISOString().slice(0, 10)) {
    return res.status(400).json({ error: "Choose an advance-booked weekday." });
  }

  await clearExpiredReservations();
  const reference = `rb_${randomUUID().replaceAll("-", "")}`;
  const id = randomUUID();
  const deposit = Math.ceil(total / 2);
  const createReservation = await transaction(async () => {
    const existing = await db.prepare(`
      SELECT id FROM bookings
      WHERE date = ? AND time_slot = ?
        AND (status = 'confirmed' OR (status = 'pending_payment' AND expires_at > datetime('now')))
    `).get(booking.date, booking.timeSlot);
    if (existing) return false;
    const inserted = await db.prepare(`
      INSERT INTO bookings (id, reference, artist_name, email, package_name, date, time_slot, total_pesewas, deposit_pesewas, status, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_payment', datetime('now', ?))
      ON CONFLICT (date, time_slot) WHERE status IN ('confirmed', 'pending_payment') DO NOTHING
    `).run(id, reference, booking.artistName, booking.email, booking.packageName, booking.date, booking.timeSlot, total, deposit, `+${reservationMinutes} minutes`);
    return inserted.changes > 0;
  });
  if (!createReservation) return res.status(409).json({ error: "That session time has already been booked. Choose another available slot." });

  try {
    const payment = await initializePayment({
      email: booking.email,
      amount: deposit,
      reference,
      metadata: { booking_id: id, type: "studio_booking" },
    });
    return res.status(201).json({ authorizationUrl: payment.authorization_url, reference, expiresInMinutes: reservationMinutes });
  } catch (error) {
    await db.prepare("UPDATE bookings SET status = 'expired' WHERE id = ? AND status = 'pending_payment'").run(id);
    return next(error);
  }
});

async function verifyPayment(reference) {
  if (!paystackConfigured()) throw new Error("Online payments are not configured.");
  const safeReference = z.string().regex(/^rb_[a-f0-9]{32}$/).safeParse(reference);
  if (!safeReference.success) {
    const error = new Error("Invalid payment reference.");
    error.status = 400;
    throw error;
  }
  const order = await db.prepare("SELECT * FROM orders WHERE reference = ?").get(reference);
  const booking = await db.prepare("SELECT * FROM bookings WHERE reference = ?").get(reference);
  if (!order && !booking) {
    const error = new Error("Payment reference not found.");
    error.status = 404;
    throw error;
  }
  const record = order ?? booking;
  if (record.status === "paid" || record.status === "confirmed" || record.status === "payment_received_review") {
    return { status: record.status, type: order ? "order" : "booking" };
  }

  const payment = await paystackRequest(`/transaction/verify/${encodeURIComponent(reference)}`, undefined, "GET");
  const expectedAmount = order ? order.amount_pesewas : booking.deposit_pesewas;
  if (payment.status !== "success" || payment.currency !== "GHS" || payment.amount !== expectedAmount || payment.reference !== reference) {
    return { status: "pending", type: order ? "order" : "booking" };
  }

  if (order) {
    const updateOrder = () => transaction(async () => {
      const current = await db.prepare("SELECT * FROM orders WHERE reference = ?").get(reference);
      if (current.status === "paid") return false;
      const updated = await db.prepare("UPDATE orders SET status = 'paid', paid_at = datetime('now') WHERE reference = ? AND status = 'pending'").run(reference);
      if (updated.changes === 0) return false;
      const paidOrder = await db.prepare("SELECT * FROM orders WHERE reference = ?").get(reference);
      await recordPurchasedBeatInteractions(paidOrder);
      await queuePaidOrderNotifications(paidOrder);
      return true;
    });
    await updateOrder();
    void flushNotificationOutbox();
    return { status: "paid", type: "order" };
  }

  const confirmBooking = () => transaction(async () => {
    const current = await db.prepare("SELECT * FROM bookings WHERE reference = ?").get(reference);
    if (current.status === "confirmed" || current.status === "payment_received_review") return { booking: null, status: current.status };
    const occupied = await db.prepare(`
      SELECT id FROM bookings
      WHERE date = ? AND time_slot = ? AND id != ?
        AND (status = 'confirmed' OR (status = 'pending_payment' AND expires_at > datetime('now')))
    `).get(current.date, current.time_slot, current.id);
    if (current.status !== "pending_payment" || Date.parse(current.expires_at) <= Date.now() || occupied) {
      const updated = await db.prepare("UPDATE bookings SET status = 'payment_received_review', paid_at = datetime('now') WHERE reference = ? AND status IN ('pending_payment', 'expired', 'cancelled')").run(reference);
      if (updated.changes === 0) {
        const latest = await db.prepare("SELECT status FROM bookings WHERE reference = ?").get(reference);
        return { booking: null, status: latest.status };
      }
      const reviewed = await db.prepare("SELECT * FROM bookings WHERE reference = ?").get(reference);
      await queueManualReviewNotifications(reviewed);
      return { booking: reviewed, status: "payment_received_review" };
    }
    const updated = await db.prepare("UPDATE bookings SET status = 'confirmed', paid_at = datetime('now') WHERE reference = ? AND status = 'pending_payment'").run(reference);
    if (updated.changes === 0) {
      const latest = await db.prepare("SELECT status FROM bookings WHERE reference = ?").get(reference);
      return { booking: null, status: latest.status };
    }
    const confirmed = await db.prepare("SELECT * FROM bookings WHERE reference = ?").get(reference);
    await queuePaidBookingNotifications(confirmed);
    return { booking: confirmed, status: "confirmed" };
  });
  const confirmation = await confirmBooking();
  void flushNotificationOutbox();
  return { status: confirmation.status, type: "booking" };
}

app.get("/api/payments/verify/:reference", async (req, res, next) => {
  try {
    return res.json(await verifyPayment(req.params.reference));
  } catch (error) {
    return next(error);
  }
});

app.post("/api/paystack/webhook", async (req, res, next) => {
  if (!paystackConfigured()) return res.status(503).end();
  const signature = req.get("x-paystack-signature") ?? "";
  const expected = createHmac("sha512", process.env.PAYSTACK_SECRET_KEY).update(req.rawBody ?? Buffer.alloc(0)).digest("hex");
  if (!safeEqual(signature, expected)) return res.status(401).end();
  if (req.body?.event !== "charge.success" || typeof req.body?.data?.reference !== "string") return res.sendStatus(200);
  try {
    await verifyPayment(req.body.data.reference);
    return res.sendStatus(200);
  } catch (error) {
    return next(error);
  }
});

const clientAuthAttempts = new Map();
function allowClientAuthAttempt(req, res) {
  const now = Date.now();
  const key = req.ip ?? "unknown";
  const attempt = clientAuthAttempts.get(key) ?? { count: 0, resetAt: now + 15 * 60 * 1000 };
  if (attempt.resetAt <= now) {
    attempt.count = 0;
    attempt.resetAt = now + 15 * 60 * 1000;
  }
  if (attempt.count >= 10) {
    res.status(429).json({ error: "Too many account attempts. Try again in 15 minutes." });
    return false;
  }
  attempt.count += 1;
  clientAuthAttempts.set(key, attempt);
  return true;
}

app.post("/api/account/signup", async (req, res, next) => {
  if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
    return res.status(503).json({ error: "Client account sign-in is not configured on the server." });
  }
  const parsed = accountCredentialsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Enter a valid email and a password of at least 8 characters." });
  if (!allowClientAuthAttempt(req, res)) return;
  try {
    const email = parsed.data.email.toLowerCase();
    const salt = randomBytes(16).toString("hex");
    const derived = await derivePasswordHash(parsed.data.password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    const passwordHash = Buffer.from(derived).toString("hex");
    const account = await transaction(async () => {
      const existing = await db.prepare("SELECT id, password_hash AS passwordHash FROM client_accounts WHERE email = ?").get(email);
      if (existing?.passwordHash) return null;
      if (existing) {
        await db.prepare("UPDATE client_accounts SET password_salt = ?, password_hash = ?, last_login_at = datetime('now') WHERE id = ?")
          .run(salt, passwordHash, existing.id);
        return db.prepare("SELECT id, email FROM client_accounts WHERE id = ?").get(existing.id);
      }
      const id = randomUUID();
      await db.prepare("INSERT INTO client_accounts (id, email, password_salt, password_hash) VALUES (?, ?, ?, ?)")
        .run(id, email, salt, passwordHash);
      return db.prepare("SELECT id, email FROM client_accounts WHERE id = ?").get(id);
    });
    if (!account) return res.status(409).json({ error: "An account with this email already exists. Sign in instead." });
    clientAuthAttempts.delete(req.ip ?? "unknown");
    setClientSessionCookie(res, account);
    return res.status(201).json({ authenticated: true, email: account.email });
  } catch (error) {
    return next(error);
  }
});

app.post("/api/account/login", async (req, res, next) => {
  if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
    return res.status(503).json({ error: "Client account sign-in is not configured on the server." });
  }
  const parsed = accountCredentialsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Enter a valid email and password." });
  if (!allowClientAuthAttempt(req, res)) return;
  try {
    const email = parsed.data.email.toLowerCase();
    const account = await db.prepare("SELECT id, email, password_salt AS passwordSalt, password_hash AS passwordHash FROM client_accounts WHERE email = ?").get(email);
    const salt = account?.passwordSalt ?? "00000000000000000000000000000000";
    const derived = Buffer.from(await derivePasswordHash(parsed.data.password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }));
    const storedHash = account?.passwordHash ? Buffer.from(account.passwordHash, "hex") : Buffer.alloc(0);
    if (!account || storedHash.length !== derived.length || !timingSafeEqual(storedHash, derived)) {
      return res.status(401).json({ error: "Email or password is incorrect." });
    }
    clientAuthAttempts.delete(req.ip ?? "unknown");
    await db.prepare("UPDATE client_accounts SET last_login_at = datetime('now') WHERE id = ?").run(account.id);
    setClientSessionCookie(res, account);
    return res.json({ authenticated: true, email: account.email });
  } catch (error) {
    return next(error);
  }
});

app.get("/api/account/session", async (req, res) => {
  const account = await getClientSession(req);
  return res.json({ authenticated: Boolean(account), email: account?.email ?? null });
});

app.post("/api/account/logout", (_req, res) => {
  res.setHeader("Set-Cookie", "rb_client=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
  return res.json({ authenticated: false });
});

async function getClientBeatInteractions(accountId) {
  return (await db.prepare(`
    SELECT beat_id AS beatId, interaction_count AS interactionCount,
      last_interacted_at AS lastInteractedAt
    FROM client_beat_interactions
    WHERE account_id = ?
    ORDER BY last_interacted_at DESC
    LIMIT 100
  `).all(accountId)).map((interaction) => ({
    ...interaction,
    ...catalog.get(interaction.beatId),
  }));
}

app.get("/api/account/interactions", requireClient, async (req, res) => {
  const account = await getClientSession(req);
  if (!account) return res.status(401).json({ error: "Client sign-in required." });
  return res.json({ interactions: await getClientBeatInteractions(account.id) });
});

app.post("/api/account/interactions", requireClient, async (req, res) => {
  const account = await getClientSession(req);
  if (!account) return res.status(401).json({ error: "Client sign-in required." });
  const parsed = beatInteractionSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "A valid beat and interaction count are required." });
  if (!catalog.has(parsed.data.beatId)) return res.status(404).json({ error: "That beat is not available." });
  await db.prepare(`
    INSERT INTO client_beat_interactions (account_id, beat_id, interaction_count)
    VALUES (?, ?, ?)
    ON CONFLICT(account_id, beat_id) DO UPDATE SET
      interaction_count = MAX(interaction_count, excluded.interaction_count),
      last_interacted_at = datetime('now')
  `).run(account.id, parsed.data.beatId, parsed.data.interactionCount);
  const interaction = (await getClientBeatInteractions(account.id)).find((item) => item.beatId === parsed.data.beatId);
  return res.json({ interaction });
});

app.get("/api/account/history", requireClient, async (req, res) => {
  const account = await getClientSession(req);
  if (!account) return res.status(401).json({ error: "Client sign-in required." });
  const orders = (await db.prepare(`
    SELECT reference, items_json AS itemsJson, amount_pesewas AS amountPesewas,
      status, created_at AS createdAt, paid_at AS paidAt
    FROM orders WHERE lower(email) = ? AND status = 'paid'
    ORDER BY created_at DESC LIMIT 100
  `).all(account.email)).map((order) => ({
    reference: order.reference,
    items: JSON.parse(order.itemsJson).map((item) => ({ title: item.title, licenseName: item.licenseName })),
    amountPesewas: order.amountPesewas,
    status: order.status,
    createdAt: order.createdAt,
    paidAt: order.paidAt,
  }));
  const bookings = await db.prepare(`
    SELECT reference, package_name AS packageName, date, time_slot AS timeSlot,
      total_pesewas AS totalPesewas, deposit_pesewas AS depositPesewas,
      status, created_at AS createdAt, paid_at AS paidAt
    FROM bookings WHERE lower(email) = ?
    ORDER BY date DESC, time_slot LIMIT 100
  `).all(account.email);
  return res.json({ email: account.email, orders, bookings, interactions: await getClientBeatInteractions(account.id) });
});

const loginAttempts = new Map();
app.post("/api/admin/login", (req, res) => {
  if (!process.env.ADMIN_PASSWORD || !process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
    return res.status(503).json({ error: "Studio sign-in is not configured. Set ADMIN_PASSWORD and a SESSION_SECRET of at least 32 characters." });
  }
  const now = Date.now();
  const key = req.ip ?? "unknown";
  const attempt = loginAttempts.get(key) ?? { count: 0, resetAt: now + 15 * 60 * 1000 };
  if (attempt.resetAt <= now) {
    attempt.count = 0;
    attempt.resetAt = now + 15 * 60 * 1000;
  }
  if (attempt.count >= 8) return res.status(429).json({ error: "Too many sign-in attempts. Try again later." });
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success || !safeEqual(parsed.data.password, process.env.ADMIN_PASSWORD)) {
    attempt.count += 1;
    loginAttempts.set(key, attempt);
    return res.status(401).json({ error: "Incorrect studio password." });
  }
  loginAttempts.delete(key);
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  const expiresAt = Date.now() + 12 * 60 * 60 * 1000;
  res.setHeader("Set-Cookie", `rb_admin=${encodeURIComponent(adminSessionCookie({ exp: expiresAt }))}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200${secure}`);
  return res.json({ authenticated: true });
});

app.get("/api/admin/session", (req, res) => res.json({ authenticated: Boolean(getAdminSession(req)) }));
app.post("/api/admin/logout", (_req, res) => {
  res.setHeader("Set-Cookie", "rb_admin=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
  return res.json({ authenticated: false });
});

async function getAdminTelegramDelivery() {
  const links = await db.prepare(`
    SELECT beat_id AS beatId, encrypted_telegram_url AS encryptedTelegramUrl
    FROM beat_delivery_links
  `).all();
  const passwords = await db.prepare(`
    SELECT beat_id AS beatId, license_id AS licenseId, encrypted_password AS encryptedPassword
    FROM beat_delivery_passwords
  `).all();
  const conflictingPasswordBeats = new Set();
  for (const beatId of catalog.keys()) {
    const mp3 = passwords.find((item) => item.beatId === beatId && item.licenseId === "mp3");
    const wav = passwords.find((item) => item.beatId === beatId && item.licenseId === "wav");
    if (mp3 && wav && decryptStoredValue(mp3.encryptedPassword) === decryptStoredValue(wav.encryptedPassword)) {
      conflictingPasswordBeats.add(beatId);
    }
  }
  return {
    beats: [...catalog.keys()].map((beatId) => {
      const link = links.find((item) => item.beatId === beatId);
      return {
        beatId,
        telegramUrl: link ? decryptStoredValue(link.encryptedTelegramUrl) : "",
        hasLink: Boolean(link),
        tiktokUrl: catalog.get(beatId)?.tiktokUrl ?? "",
        tiktokThumbnailUrl: catalog.get(beatId)?.tiktokThumbnailUrl ?? "",
      };
    }),
    passwords: catalog.size === 0 ? [] : [...catalog.keys()].flatMap((beatId) =>
      ["mp3", "wav"].map((licenseId) => ({
        beatId,
        licenseId,
        configured: passwords.some((item) => item.beatId === beatId && item.licenseId === licenseId),
        conflicting: conflictingPasswordBeats.has(beatId),
      })),
    ),
    packs: await Promise.all([...packs.values()].map(async (pack) => {
      const saved = await db.prepare("SELECT encrypted_telegram_url AS encryptedTelegramUrl FROM storefront_packs WHERE beat_id = ?").get(pack.beatId);
      return {
        beatId: pack.beatId,
        title: pack.title,
        telegramUrl: saved ? decryptStoredValue(saved.encryptedTelegramUrl) : "",
        configured: Boolean(saved),
      };
    })),
    packPasswords: await Promise.all([...packs.keys()].map(async (beatId) => ({
      beatId,
      configured: Boolean(await db.prepare("SELECT 1 FROM storefront_packs WHERE beat_id = ? AND encrypted_password <> ''").get(beatId)),
    }))),
  };
}

app.get("/api/admin/delivery", requireAdmin, async (_req, res) => {
  return res.json(await getAdminTelegramDelivery());
});

app.put("/api/admin/delivery", requireAdmin, async (req, res) => {
  const parsed = telegramDeliverySchema.safeParse(req.body);
  if (!parsed.success) {
    const tiktokIssue = parsed.error.issues.find((issue) => issue.path.at(-1) === "tiktokUrl");
    const telegramIssue = parsed.error.issues.find((issue) => issue.path.at(-1) === "telegramUrl");
    const passwordIssue = parsed.error.issues.find((issue) => issue.path.includes("password"));
    const error = tiktokIssue
      ? "Use a direct public TikTok video URL, such as https://www.tiktok.com/@username/video/1234567890."
      : telegramIssue
        ? "Use a direct HTTPS Telegram file link for the beat."
        : passwordIssue
          ? "Archive passwords must be 8–128 characters."
          : "Check the delivery details and try again.";
    return res.status(400).json({ error });
  }
  const linkIds = new Set();
  for (const item of parsed.data.beats) {
    if (!catalog.has(item.beatId)) return res.status(400).json({ error: "A Telegram link refers to an unknown beat." });
    if (linkIds.has(item.beatId)) return res.status(400).json({ error: "Each beat can have only one Telegram file link." });
    linkIds.add(item.beatId);
    if (item.telegramUrl) {
      let telegramLink;
      try {
        telegramLink = new URL(item.telegramUrl);
      } catch {
        return res.status(400).json({ error: "Enter a valid Telegram beat file link." });
      }
      if (
        telegramLink.protocol !== "https:"
        || !["t.me", "www.t.me", "telegram.me", "www.telegram.me"].includes(telegramLink.hostname.toLowerCase())
        || telegramLink.pathname === "/"
        || telegramLink.search
        || telegramLink.hash
      ) {
        return res.status(400).json({ error: "Use the direct HTTPS Telegram link for this beat file." });
      }
    }
  }
  const keys = new Set();
  for (const item of parsed.data.passwords) {
    if (!catalog.has(item.beatId)) return res.status(400).json({ error: "A password refers to an unknown beat." });
    const key = `${item.beatId}:${item.licenseId}`;
    if (keys.has(key)) return res.status(400).json({ error: "Each beat license can have only one password entry." });
    keys.add(key);
  }
  const packIds = new Set();
  for (const item of parsed.data.packs) {
    if (!packs.has(item.beatId)) return res.status(400).json({ error: "Pack delivery details refer to a beat without a pack." });
    if (packIds.has(item.beatId)) return res.status(400).json({ error: "Each pack can have only one delivery entry." });
    if (item.password) {
      const beatPasswords = await db.prepare("SELECT license_id AS licenseId, encrypted_password AS encryptedPassword FROM beat_delivery_passwords WHERE beat_id = ?").all(item.beatId);
      if (beatPasswords.some((saved) => decryptStoredValue(saved.encryptedPassword) === item.password)) {
        return res.status(400).json({ error: "A pack ZIP password must be different from that beat's MP3 and WAV passwords." });
      }
    }
    packIds.add(item.beatId);
  }
  if ((!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32)
    && (parsed.data.packs.some((item) => item.telegramUrl || item.password) || parsed.data.beats.some((item) => item.telegramUrl)
      || parsed.data.passwords.length > 0)) {
    return res.status(503).json({ error: "SESSION_SECRET must remain configured to protect delivery credentials." });
  }
  try {
    const savedPasswords = await db.prepare("SELECT beat_id AS beatId, license_id AS licenseId, encrypted_password AS encryptedPassword FROM beat_delivery_passwords").all();
    const finalPasswords = new Map(savedPasswords.map((item) => [
      `${item.beatId}:${item.licenseId}`,
      decryptStoredValue(item.encryptedPassword),
    ]));
    for (const item of parsed.data.passwords) finalPasswords.set(`${item.beatId}:${item.licenseId}`, item.password);
    for (const beatId of catalog.keys()) {
      const mp3Password = finalPasswords.get(`${beatId}:mp3`);
      const wavPassword = finalPasswords.get(`${beatId}:wav`);
      if (mp3Password && wavPassword && mp3Password === wavPassword) {
        return res.status(400).json({ error: "MP3 and WAV archive passwords must be different for each beat." });
      }
    }
    const thumbnailUpdates = await Promise.all(parsed.data.beats.map(async (item) => {
      if (item.tiktokUrl === undefined) return null;
      const currentBeat = catalog.get(item.beatId);
      if (currentBeat?.tiktokUrl === item.tiktokUrl && currentBeat.tiktokThumbnailUrl) return null;
      return { beatId: item.beatId, tiktokUrl: item.tiktokUrl, tiktokThumbnailUrl: await getTikTokThumbnailUrl(item.tiktokUrl) };
    }));
    const thumbnailByBeatId = new Map(thumbnailUpdates.filter((item) => item !== null).map((item) => [item.beatId, item]));
    await transaction(async () => {
      const saveLink = db.prepare(`
        INSERT INTO beat_delivery_links (beat_id, encrypted_telegram_url)
        VALUES (?, ?)
        ON CONFLICT(beat_id) DO UPDATE SET
          encrypted_telegram_url = excluded.encrypted_telegram_url,
          updated_at = datetime('now')
      `);
      for (const item of parsed.data.beats) {
        if (item.telegramUrl) await saveLink.run(item.beatId, encryptStoredValue(item.telegramUrl));
        if (item.tiktokUrl !== undefined) {
          const thumbnail = thumbnailByBeatId.get(item.beatId);
          await db.prepare("UPDATE storefront_beats SET tiktok_url = ?, tiktok_thumbnail_url = ? WHERE id = ?")
            .run(item.tiktokUrl || null, thumbnail ? thumbnail.tiktokThumbnailUrl : catalog.get(item.beatId)?.tiktokThumbnailUrl ?? null, item.beatId);
        }
      }
      const savePassword = db.prepare(`
        INSERT INTO beat_delivery_passwords (beat_id, license_id, encrypted_password)
        VALUES (?, ?, ?)
        ON CONFLICT(beat_id, license_id) DO UPDATE SET
          encrypted_password = excluded.encrypted_password,
          updated_at = datetime('now')
      `);
      for (const item of parsed.data.passwords) {
        await savePassword.run(item.beatId, item.licenseId, encryptStoredValue(item.password));
      }
      const savePackDelivery = db.prepare(`
        UPDATE storefront_packs
        SET encrypted_telegram_url = CASE WHEN ? <> '' THEN ? ELSE encrypted_telegram_url END,
            encrypted_password = CASE WHEN ? <> '' THEN ? ELSE encrypted_password END
        WHERE beat_id = ?
      `);
      for (const item of parsed.data.packs) {
        await savePackDelivery.run(
          item.telegramUrl, item.telegramUrl ? encryptStoredValue(item.telegramUrl) : "",
          item.password, item.password ? encryptStoredValue(item.password) : "",
          item.beatId,
        );
      }
    });
    for (const item of parsed.data.beats) {
      if (item.tiktokUrl === undefined) continue;
      const currentBeat = catalog.get(item.beatId);
      if (currentBeat) {
        const thumbnail = thumbnailByBeatId.get(item.beatId);
        catalog.set(item.beatId, {
          ...currentBeat,
          tiktokUrl: item.tiktokUrl || undefined,
          tiktokThumbnailUrl: item.tiktokUrl
            ? (thumbnail ? thumbnail.tiktokThumbnailUrl ?? undefined : currentBeat.tiktokThumbnailUrl)
            : undefined,
        });
      }
    }
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : "Could not save Telegram delivery settings." });
  }
  return res.json(await getAdminTelegramDelivery());
});

app.post("/api/admin/catalog/beats", requireAdmin, async (req, res) => {
  if (catalog.size >= maximumCatalogBeats) return res.status(409).json({ error: "The storefront beat catalog has reached its current limit." });
  const parsed = newBeatSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Enter the beat title, genre, mood, tempo, key, Telegram link, and both archive passwords." });
  if (parsed.data.mp3Password === parsed.data.wavPassword) {
    return res.status(400).json({ error: "MP3 and WAV archive passwords must be different." });
  }
  const packIncluded = parsed.data.packIncluded ?? Boolean(parsed.data.packCategory);
  const packTelegramUrl = parsed.data.packTelegramUrl || "";
  const packPassword = parsed.data.packPassword || "";
  if (packIncluded && (!packTelegramUrl || packPassword.length < 8)) {
    return res.status(400).json({ error: "A pack requires its Telegram ZIP link and a password of at least 8 characters." });
  }
  if (packIncluded && [parsed.data.mp3Password, parsed.data.wavPassword].includes(packPassword)) {
    return res.status(400).json({ error: "The pack ZIP password must be different from the beat's MP3 and WAV passwords." });
  }
  if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
    return res.status(503).json({ error: "SESSION_SECRET must remain configured to protect delivery credentials." });
  }
  let beat;
  let pack = null;
  try {
    const tiktokThumbnailUrl = await getTikTokThumbnailUrl(parsed.data.tiktokUrl || "");
    await transaction(async () => {
      const result = await db.prepare(`
        INSERT INTO storefront_beats (title, producer, genre, mood, bpm, key_name, price, cover, tag, tiktok_url, tiktok_thumbnail_url)
        VALUES (?, 'RabsBeats', ?, ?, ?, ?, 39, 'cover-new', 'NEW', ?, ?)
        RETURNING id
      `).get(parsed.data.title, parsed.data.genre, parsed.data.mood, parsed.data.bpm, parsed.data.key, parsed.data.tiktokUrl || null, tiktokThumbnailUrl);
      const beatId = Number(result.id);
      await db.prepare("INSERT INTO beat_delivery_links (beat_id, encrypted_telegram_url) VALUES (?, ?)")
        .run(beatId, encryptStoredValue(parsed.data.telegramUrl));
      const addPassword = db.prepare(`
        INSERT INTO beat_delivery_passwords (beat_id, license_id, encrypted_password)
        VALUES (?, ?, ?)
      `);
      await addPassword.run(beatId, "mp3", encryptStoredValue(parsed.data.mp3Password));
      await addPassword.run(beatId, "wav", encryptStoredValue(parsed.data.wavPassword));
      if (packIncluded) {
        const packTitle = `${parsed.data.title.trim()} Pack`;
        await db.prepare(`
          INSERT INTO storefront_packs (beat_id, title, category, price_pesewas, encrypted_telegram_url, encrypted_password)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(beatId, packTitle, "drumkit", packPricePesewas, encryptStoredValue(packTelegramUrl), encryptStoredValue(packPassword));
        pack = { beatId, title: packTitle, price: packPricePesewas / 100, cover: "cover-new" };
      }
      beat = {
        id: beatId,
        title: parsed.data.title,
        producer: "RabsBeats",
        genre: parsed.data.genre,
        mood: parsed.data.mood,
        bpm: parsed.data.bpm,
        key: parsed.data.key,
        price: 39,
        cover: "cover-new",
        tag: "NEW",
        ...(parsed.data.tiktokUrl ? { tiktokUrl: parsed.data.tiktokUrl } : {}),
        ...(tiktokThumbnailUrl ? { tiktokThumbnailUrl } : {}),
      };
    });
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : "Could not add the beat to the catalog." });
  }
  catalog.set(beat.id, beat);
  if (pack) packs.set(pack.beatId, pack);
  void notifyPushSubscribers({
    title: "A new beat just dropped",
    body: `${beat.title} · ${beat.genre} · ${beat.bpm} BPM`,
    url: "/#beats",
    tag: `rabsbeats-beat-${beat.id}`,
  }).catch((error) => console.error(`Could not send new-beat notifications: ${error instanceof Error ? error.message : "unknown error"}`));
  return res.status(201).json({ beat, pack });
});

app.get("/api/admin/bookings", requireAdmin, async (_req, res) => {
  await clearExpiredReservations();
  const bookings = await db.prepare(`
    SELECT id, artist_name AS artistName, email, package_name AS packageName, date,
      time_slot AS timeSlot, total_pesewas AS totalPesewas, deposit_pesewas AS depositPesewas,
      status, reference, created_at AS createdAt
    FROM bookings
    ORDER BY date DESC, time_slot
  `).all();
  return res.json({ bookings });
});

app.post("/api/admin/bookings/:id/cancel", requireAdmin, async (req, res) => {
  const result = await db.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ? AND status = 'pending_payment'").run(req.params.id);
  if (result.changes === 0) return res.status(409).json({ error: "Only unpaid pending reservations can be cancelled here." });
  return res.json({ cancelled: true });
});

app.get("/api/admin/notifications", requireAdmin, async (_req, res) => {
  const notifications = await db.prepare("SELECT id, channel, recipient, status, attempts, last_error AS lastError, created_at AS createdAt FROM notification_outbox WHERE channel = 'email' ORDER BY id DESC LIMIT 100").all();
  return res.json({ notifications });
});

app.post("/api/admin/notifications/retry", requireAdmin, async (_req, res) => {
  await db.prepare("UPDATE notification_outbox SET attempts = 0, last_error = NULL WHERE channel = 'email' AND status = 'pending' AND attempts >= 10").run();
  await flushNotificationOutbox();
  return res.json({ ok: true });
});

if (process.env.NODE_ENV === "production") {
  app.use(express.static(resolve(root, "dist"), { index: false, maxAge: "1h" }));
  app.get("/{*path}", (_req, res) => res.sendFile(resolve(root, "dist/index.html")));
}

app.use((error, _req, res, _next) => {
  const message = error instanceof Error ? error.message : "Unexpected server error.";
  const status = Number.isInteger(error?.status) ? error.status : 502;
  console.error(message);
  return res.status(status).json({ error: status >= 500 ? "The request could not be completed. Please try again or contact RabsBeats." : message });
});

const server = app.listen(port, () => {
  console.log(`RabsBeats API listening on http://localhost:${port}`);
  console.log(postgresPool ? "Using PostgreSQL database." : `SQLite database: ${databasePath}`);
  if (!paystackConfigured()) console.warn("Paystack checkout is disabled for the current key and environment configuration.");
  if (!process.env.ADMIN_PASSWORD || !process.env.SESSION_SECRET) console.warn("Studio login is disabled until ADMIN_PASSWORD and SESSION_SECRET are configured.");
});
void flushNotificationOutbox().catch((error) => console.error(`Could not flush notification outbox: ${error instanceof Error ? error.message : "unknown error"}`));
const outboxInterval = setInterval(() => {
  void flushNotificationOutbox().catch((error) => console.error(`Could not flush notification outbox: ${error instanceof Error ? error.message : "unknown error"}`));
}, 60_000);

function shutdown() {
  clearInterval(outboxInterval);
  server.close(async () => {
    await db.close();
    process.exit(0);
  });
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
