# Platform appearance backend

This KA installation is one platform with one published appearance. Only the existing `ADMIN` role can edit or purchase the developer-owned customization entitlement. Ordinary users can read the published theme for display. The platform data uses new `PlatformThemeSettings`, `PlatformThemeHistory`, `PlatformThemeSubscription`, `PlatformThemePayment`, and `PlatformThemeActivationCode` collections keyed by `scopeKey: "main"`. The earlier per-user theme collections, if any, are left untouched and grant no privileges through mounted routes. There is no destructive data migration. After reviewing the target database, run `node scripts/ensure-theme-indexes.js` with its `MONGO_URI` to create new indexes. Publishing requires a MongoDB replica set for transactions. The script has not been run against production.

## API

All `/api/admin/theme/*` routes require a verified active `ADMIN` account and use the existing `{ success, message, data }` envelope. `/api/theme/published` is public and returns only the published configuration and version.

| Route | Behavior |
| --- | --- |
| `GET /api/admin/theme/settings` | Published theme, draft, version, plan, and authoritative eligibility |
| `GET /api/admin/theme/presets` | Approved presets and supported option values |
| `POST /api/admin/theme/preview/validate` | Validate a complete theme object without storing it |
| `POST /api/admin/theme/draft` | Store a validated unpublished draft |
| `POST /api/admin/theme/draft/reset` | Clear the stored draft |
| `POST /api/admin/theme/publish` | Publish a complete validated theme in a transaction |
| `POST /api/admin/theme/restore` | Publish a previous version given `{ "version": 1 }`; normal cooldown applies |
| `GET /api/admin/theme/history?page=1` | Up to 20 platform versions |
| `GET /api/admin/theme/entitlement` | Current entitlement and checkout availability |
| `GET /api/admin/theme/subscription` | Subscription plan, entitlement, and manual USDT instructions |
| `GET /api/admin/theme/subscription/payment-status` | Latest 20 payment records for the signed-in administrator |
| `POST /api/admin/theme/subscription/manual-order` | Create/reuse a pending PRO (24.99 USDT), ULTRA (29.99 USDT), or PRO-to-ULTRA upgrade (5.00 USDT) order for `BINANCE_ID`, `TRC20`, or `BEP20`; returns reference and prefilled WhatsApp URL |
| `POST /api/admin/theme/subscription/manual-order/confirm` | After manual receipt verification, accepts only `{ reference, chainTransactionId }`, creates a random code, and sends it through the connected server WhatsApp session to the payer's profile phone; never returns the code |
| `POST /api/admin/theme/subscription/manual-order/reissue-code` | Replaces an unredeemed code and attempts delivery again through the connected server WhatsApp session; never returns the code |
| `POST /api/admin/theme/subscription/redeem` | Paying admin redeems a verified transfer's one-time 10-digit code before its 48-hour expiry |
| `POST /api/admin/theme/media/upload` | Verified PRO or ULTRA: upload a signed JPG/PNG/WebP logo or slide, 128–6000 pixels and at most 5 MB |
| `POST /api/admin/theme/subscription/checkout` | Returns 503 until the developer merchant gateway is integrated |
| `POST /api/payments/webhook` | Returns 503 until a verified webhook provider is integrated |

Theme payloads must be complete. Start with a configuration from `/api/admin/theme/presets`, then change supported fields. `schemaVersion` is 2: `modes.light` and `modes.dark` have separate palettes, fonts, and visual settings; `brand` contains one optional logo, its width, and four optional homepage slide paths. The server rejects unknown fields, unsupported values, invalid hex colors, unsafe image paths, and insufficient text contrast. Valid stored version-1 themes are read as version 2 without deleting their records. The public endpoint returns `null` until the first publish so the frontend keeps its existing design tokens.

Free administrators can edit both palettes, use the `classic`, `midnight`, and `warm` presets, and use Cairo/Tajawal or Inter/Arial. The free plan allows two successful publishes or restores total, with at least 30 days between them. Thirteen extra presets (`ocean`, `forest`, `royal`, `sunset`, `graphite`, `gold`, `silver`, `copper`, `ruby`, `orchid`, `aurora`, `desert`, `frost`), extra fonts, font sizing, button/card/navigation controls, logo size, logo upload, and four slide uploads require a verified active PRO or ULTRA subscription. Each preset includes separate light and dark palettes. Drafting and previewing remain available without consuming a publish; the server enforces paid features again inside the publish transaction. ULTRA also unlocks ready sidebar templates and editing WhatsApp numbers. When a paid plan expires, the last published appearance and images stay visible, but further paid-feature publishing and uploads lock until renewal.

The platform administrator can publish twice total on the free plan, with one successful change per rolling 30 days. Drafts and validation do not consume a publish. PRO and ULTRA, backed by an active verified developer-merchant payment record, bypass the cooldown until `expiresAt`. Every successful publish updates `lastSuccessfulPublishAt`, including paid publishes. The effective paid status is calculated from server time on each request, so an expired record grants no access even before its stored status is updated. Three-month expiry uses UTC calendar month arithmetic, clamping month-end dates. The cooldown error includes `nextFreeEditAt`.

## Manual USDT payment

### PRO, ULTRA, and upgrades

New subscriptions last three calendar months: **PRO costs 24.99 USDT** and **ULTRA costs 29.99 USDT** (limited offer, displayed against $70). Pass `planId: "THEME_PRO"` or `"THEME_ULTRA"` to `manual-order`. The server chooses the amount; clients cannot supply a price. ULTRA includes all PRO features plus the `royal` and `glass` sidebar templates and editing public WhatsApp contacts and the private notification recipient.

An active PRO subscription can upgrade to ULTRA for **5.00 USDT**. The upgrade keeps the original PRO expiry date. It is bound to that PRO subscription; the same subscription must still be active at confirmation and redemption. Payment status includes `planId`, `isUpgrade`, and `redeemed` so the editor uses only an unredeemed verified transfer for activation. Existing orders without plan metadata remain PRO orders.

The notification recipient is the database setting `adminNotificationWhatsApp`, configured under Admin → Payment methods by an active ULTRA subscriber. A country code is required, e.g. `+201012345678`; Arabic digits and the `00` international prefix are accepted. The old `ADMIN_NOTIFICATION_NUMBER` environment variable is no longer read. Save the notification recipient before enabling live notifications on deployment. This private number is omitted from public payment settings; activation codes still go to the paying administrator's profile phone.

The free plan allows **two successful changes in total**, with the existing 30-day interval. Drafts and previews consume none. Free restores count as changes; new paid publishes do not consume the free allowance. History records predating plan metadata count conservatively as free changes. Eligibility returns `freeChangesUsed` and `freeChangesRemaining`, and publishing/restoring beyond the cap returns `THEME_FREE_LIMIT`. The initial free-plan modal links to the plan benefits, payment instructions and shared code-activation panel.

The developer's receiving details are stored server-side in `manualPayment.service.js`: WhatsApp `01019603238` (`wa.me/201019603238`), Binance ID `202657125` / `ENG-SHARKAWY`, TRC20 `TLDFTsLDpk9GkeSiD9oLUJuBJ4FZW8cU5b`, and BEP20 `0x5882e7536635340790eb9c33e6e914e0d3499b52`. PRO costs **24.99 USDT** and ULTRA costs **29.99 USDT**, each for three UTC calendar months. An active PRO can upgrade to ULTRA for the **5.00 USDT difference** and keeps the original end date. Previously activated ten-month subscriptions retain their original end dates; pending ten-month orders retain their terms. Network fees are the sender's responsibility. The server generates a unique pending order reference and WhatsApp message. The administrator must attach the transfer screenshot in WhatsApp; the app cannot attach it automatically. A screenshot, chat message, or client callback never activates Pro.

Before using the review panel in production, set `THEME_PAYMENT_REVIEWER_IDS` to a comma-separated allowlist of the MongoDB `User._id` values that may verify transfers. The server fails closed until it is configured. After independently confirming the matching network, destination, unique transfer ID, and the exact plan or upgrade amount actually received in the developer's account, an allowed reviewer opens **Platform appearance** and enters the order reference and the transaction ID in **Confirm transfer and send code**. The browser cannot choose a recipient or supply a code. The live server creates a random one-time ten-digit code, stores only its salted hash, and sends the supplied Arabic confirmation message through the already connected server-side WhatsApp account to the paying administrator's saved profile phone. The response contains delivery status only, never the code.

The code remains invalid until manual receipt verification succeeds, expires after 48 hours, and can be assigned only once across all orders. If WhatsApp is disconnected or the profile phone is invalid, the payment is still recorded as verified and the delivery is marked failed; reconnect WhatsApp, then use **Issue and send a new code** in the same panel. This invalidates the old unredeemed code and creates a new one. `SAFE_LOCAL_PRODUCTION_MODE=true` records `SKIPPED` and deliberately sends no WhatsApp message. `THEME_CODE_PEPPER` should be a stable deployment secret (the existing `JWT_SECRET` is the fallback) because it keys the permanent code-use fingerprints. The legacy standalone code scripts now refuse to run so plaintext codes cannot be printed in a terminal. Duplicate confirmation is rejected, and the unique transaction index prevents reuse across orders. This is a manual review process, not automatic blockchain verification. No electronic merchant gateway is configured; `/subscription/checkout` and `/api/payments/webhook` continue to return 503. `payment.provider.js` remains the future electronic integration seam.

Uploaded images use the application's existing local `uploads` directory. Production deployment must provide persistent storage for that directory; ephemeral filesystems would lose custom images after restart. Create indexes with `node scripts/ensure-theme-indexes.js` only after reviewing the target database. No production database operation or payment confirmation was run here.

The older per-user `/api/subscriptions/*` and theme mutation routes are not mounted. Platform administrators share the one platform theme and entitlement; ordinary users cannot reach editor or billing APIs.

## Production deployment check

Before deployment, run `npm run verify:production` with the server's production environment loaded. Then run `node scripts/ensure-theme-indexes.js` once against the production MongoDB replica set. After the backend is live, verify `GET /health` and `GET /api/theme/published`; the latter returns a successful response with `published: null` until the first platform theme is published. Build the frontend only after setting `VITE_DATA_PROVIDER=real` and `VITE_API_BASE_URL` to this backend's public `/api` URL. The backend `ALLOWED_ORIGINS` value must include the exact frontend origin.

## Temporary activation codes and neon effects

After independent receipt verification, the running server marks the payment verified, issues a random one-time 10-digit code, and sends it to the payer's saved WhatsApp number. It is stored as a salted hash, bound to that payer and payment, and expires after 48 hours. The editor finds the verified transfer automatically, so the payer enters only the received code; only successful redemption creates the three-calendar-month subscription for a new order. The redeem endpoint is rate limited per administrator. A lost or expired unredeemed code can be replaced from the confirmation panel; the old code is invalidated. No code is created or sent before verified receipt, and no HTTP endpoint reveals a code. `PlatformThemeCodeUse` permanently records keyed fingerprints to prevent assigning a code twice; its unique index is prepared by `scripts/ensure-theme-indexes.js`.

Each light and dark appearance supports independent `neon` settings for `purchase`, `hero`, `categories`, and `bestSellers`, each with an enabled flag, hex color, and speed of 3, 5, 8, or 12 seconds. Publishing any nondefault neon setting requires verified active Pro access. The public page displays the last published neon settings and honors the visitor's reduced-motion preference. The new `PlatformThemeActivationCode` collection is included in `scripts/ensure-theme-indexes.js`.
