# RabsBeats

RabsBeats is a React/Vite storefront with an installable app shell, browser push alerts, an Express API, SQLite persistence, Paystack checkout, studio bookings, and optional transactional email notifications.

## Run locally

Use Node.js 22.9 or newer (the API uses Node's built-in SQLite and environment-file support).

1. Copy `.env.example` to `.env`.
2. Set `ADMIN_PASSWORD` and `SESSION_SECRET` (at least 32 random characters).
3. Add a Paystack **test** secret key to `PAYSTACK_SECRET_KEY` to enable test checkout and booking deposits. Keep `APP_URL=http://localhost:5173` for local payment returns.
4. Run `npm install`, then `npm run dev`. The command starts the API on port 8787 and Vite on port 5173.

The SQLite database is created at `data/rabsbeats.sqlite`. It is ignored by git. Without a Paystack key, the storefront and admin can still be browsed, but order checkout and paid booking creation return a clear configuration error rather than simulating a payment.

## Payments

Paystack is used for GHS charges. The server calculates prices from its own allowlist; it does not trust prices sent by the browser. Beat license prices are GH₵150 (MP3) and GH₵350 (WAV). A session slot is held for 20 minutes while its 50% deposit is pending. A booking is confirmed only after the server verifies a successful GHS payment and the amount/reference against Paystack.

For production, set `NODE_ENV=production`, set `APP_URL` to the public HTTPS site URL, and register `https://YOUR_DOMAIN/api/paystack/webhook` in Paystack. Live (`sk_live_`) checkout is disabled unless both production mode and a public HTTPS URL are configured; use a test key for local testing. Keep Paystack secret keys on the server only. Expired or conflicting deposits are flagged for manual review instead of silently confirming an occupied slot.

## Studio admin

The studio route still uses the existing frontend, but booking data is fetched from the API only after sign-in. Configure `ADMIN_PASSWORD` and `SESSION_SECRET`; the server issues an HttpOnly, SameSite cookie. This is a simple single-owner password gate; use HTTPS in production and rotate credentials if exposed. Public clients cannot confirm bookings; successful deposit verification is what confirms a slot.

## Email notifications

Set `GMAIL_USER` to the Gmail address that will send email and `GMAIL_APP_PASSWORD` to a Google App Password. Google requires 2-Step Verification to create an App Password. Set `EMAIL_FROM_NAME` to customize the sender name (default: RabsBeats). Paid orders send a branded receipt to the buyer and a separate purchase alert to `GMAIL_USER`; the buyer's email displays each purchased file's Telegram link and matching archive password. Upload password-protected archives to Telegram first, then add the listing in **Studio → Catalog** with its Telegram file link and the WinRAR password for each MP3 and WAV archive. Use the tagged beat for the MP3 archive. MP3 and WAV passwords must be different. Checkout is disabled if a selected license has no delivery link or password, or if the saved MP3/WAV passwords match.

## Install and beat alerts

The storefront is installable from supported mobile and desktop browsers. On a first visit it offers an **Add app** prompt; on iPhone/iPad, use Share → Add to Home Screen. Users can separately opt in to browser notifications for new beat releases; they can turn alerts off from the storefront at any time. Push requires HTTPS in production and `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and `VAPID_SUBJECT` on the API server. Generate a key pair with `npx web-push generate-vapid-keys`, keep the private key only in the server's environment, and expose only the public key through the app.

Add an optional direct TikTok video URL to a beat in **Studio → Catalog** to show its public video thumbnail on the storefront artwork and offer an embedded promo player. Existing listings can be edited in the same section. Thumbnails are retrieved from TikTok's public oEmbed metadata when available; the video URL still saves if TikTok does not provide thumbnail metadata. Use a public promo clip only; do not upload clean or licensed beat files to TikTok or the website.

Create each WinRAR archive with AES-256 encryption and “Encrypt file names” enabled. Delivery links, passwords, push subscriptions, and queued notification bodies are encrypted in SQLite using a key derived from `SESSION_SECRET`; keep that secret stable, private, and backed up. Passwords are not returned to the frontend after saving. Email is sent through Gmail's SMTP service using the App Password; keep it private in `.env`, never use your regular Gmail password, and restart the API after changing the settings.

Clients can create an account or sign in with email and password under **Account**. Passwords are stored as salted scrypt hashes; signed-in clients can view paid beat orders, studio bookings, and their recent beat activity. Preview clicks, license selections, and purchases are saved to the browser for guests and to the client account when signed in; related beats are recommended by genre, mood, and tempo. Account creation is optional and does not block checkout or studio booking.

No email messages are sent unless the corresponding provider environment variables are configured. Push alerts are sent only to browsers that explicitly subscribe. Email delivery failures are recorded in the notification outbox and do not change a verified payment or booking.

## Render hosting

The project includes a Render Blueprint for a Free web service. It builds with `npm ci && npm run build`, serves the frontend and API from one origin, and checks `/api/health`. Free web services sleep after inactivity and can take time to wake; this can delay checkout, even though payments are enabled when production and public HTTPS are configured.

Use Neon PostgreSQL for persistent orders, bookings, accounts, catalog, and delivery data. Create a Neon database, connect this private repository in Render, and provide its connection string as the Render `DATABASE_URL` secret. The service must start once to create the schema before importing existing data. Configure `SESSION_SECRET` to the same value as the current local `.env` so encrypted delivery links and passwords remain readable; also set `ADMIN_PASSWORD` and the live `PAYSTACK_SECRET_KEY` in Render's environment, never in the repository. `APP_URL` can be set to the Render HTTPS URL; otherwise the server uses Render's `RENDER_EXTERNAL_URL`. Register `https://YOUR_RENDER_URL/api/paystack/webhook` in Paystack.

To preserve existing local SQLite records, after the Render service has initialized the Neon schema, add the same Neon connection string to the ignored local `.env` as `DATABASE_URL` and run `npm run migrate:db`. The migration runs locally, copies records only into empty PostgreSQL tables, and refuses to overwrite a populated database. Restart the Render service after migration so its in-memory catalog reloads. Keep `.env` and `data/` private; neither is committed. A fresh local development run without `DATABASE_URL` continues to use SQLite.

## API outline

- `GET /api/health` — integration readiness flags.
- `GET /api/push/config`, `POST /api/push/subscriptions`, `DELETE /api/push/subscriptions` — public key and opt-in browser push subscriptions.
- `GET /api/availability?from=YYYY-MM-DD&to=YYYY-MM-DD` — booked/reserved session slots.
- `POST /api/bookings` — validate and reserve a weekday/time slot, then initialize the 50% Paystack deposit.
- `POST /api/checkout/orders` — initialize a server-priced beat order.
- `GET /api/payments/verify/:reference` and `POST /api/paystack/webhook` — verify/settle Paystack payments.
- `POST /api/admin/login`, `POST /api/admin/logout`, `GET /api/admin/session` — studio sign-in.
- `GET /api/admin/bookings`, `GET /api/admin/notifications` — authenticated studio views.
- `GET /api/admin/delivery`, `PUT /api/admin/delivery` — authenticated per-beat Telegram links, TikTok promo URLs, and per-license archive-password settings.
- `POST /api/admin/catalog/beats` — add a beat listing, optional TikTok promo URL, and Telegram delivery details; the audio itself stays in Telegram.
