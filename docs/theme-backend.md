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
| `POST /api/admin/theme/subscription/manual-order` | Create/reuse a pending 24.99 USDT order for `BINANCE_ID`, `TRC20`, or `BEP20`; returns reference and prefilled WhatsApp URL |
| `POST /api/admin/theme/subscription/redeem` | Paying admin redeems a verified transfer's one-time 10-digit code before its 48-hour expiry |
| `POST /api/admin/theme/media/upload` | Verified Pro only: upload a signed JPG/PNG/WebP logo or slide, 128–6000 pixels and at most 5 MB |
| `POST /api/admin/theme/subscription/checkout` | Returns 503 until the developer merchant gateway is integrated |
| `POST /api/payments/webhook` | Returns 503 until a verified webhook provider is integrated |

Theme payloads must be complete. Start with a configuration from `/api/admin/theme/presets`, then change supported fields. `schemaVersion` is 2: `modes.light` and `modes.dark` have separate palettes, fonts, and visual settings; `brand` contains one optional logo, its width, and four optional homepage slide paths. The server rejects unknown fields, unsupported values, invalid hex colors, unsafe image paths, and insufficient text contrast. Valid stored version-1 themes are read as version 2 without deleting their records. The public endpoint returns `null` until the first publish so the frontend keeps its existing design tokens.

Free administrators can edit both palettes, use the `classic`, `midnight`, and `warm` presets, and use Cairo/Tajawal or Inter/Arial. Thirteen extra presets (`ocean`, `forest`, `royal`, `sunset`, `graphite`, `gold`, `silver`, `copper`, `ruby`, `orchid`, `aurora`, `desert`, `frost`), extra fonts, font sizing, button/card/navigation controls, logo size, logo upload, and four slide uploads require a verified active Pro subscription. Each preset includes separate light and dark palettes. Drafting and previewing remain available without consuming a publish; the server enforces Pro features again inside the publish transaction. When Pro expires, the last published appearance and images stay visible, but further Pro-feature publishing and uploads lock until renewal.

The platform administrator can publish once per rolling 30 days without a paid entitlement. Drafts and validation do not consume an edit. Theme Customization Pro, if backed by an active verified developer-merchant payment record, bypasses the cooldown until `expiresAt`. Every successful publish updates `lastSuccessfulPublishAt`, including paid publishes. The effective paid status is calculated from server time on each request, so an expired record grants no access even before its stored status is updated. Three-month expiry uses UTC calendar month arithmetic, clamping month-end dates. The cooldown error includes `nextFreeEditAt`.

## Manual USDT payment

The developer's receiving details are stored server-side in `manualPayment.service.js`: WhatsApp `01019603238` (`wa.me/201019603238`), Binance ID `202657125` / `ENG-SHARKAWY`, TRC20 `TLDFTsLDpk9GkeSiD9oLUJuBJ4FZW8cU5b`, and BEP20 `0x5882e7536635340790eb9c33e6e914e0d3499b52`. The requested net amount is **24.99 USDT**, one-time for three UTC calendar months. Previously activated ten-month subscriptions retain their original end dates; pending ten-month orders retain their terms. Network fees are the sender's responsibility. The server generates a unique pending order reference and WhatsApp message. The administrator must attach the transfer screenshot in WhatsApp; the app cannot attach it automatically. A screenshot, chat message, or client callback never activates Pro.

After independently confirming the matching network, destination, unique transfer ID, and **24.99 USDT actually received** in the developer's account, an operator with deployment/database access runs:

```text
node scripts/confirm-theme-usdt.js --reference=THEME-... --network=TRC20 --txid=... --reviewer=... --received=24.99 --confirm-received
```

This operator-only script verifies the pending order's server-recorded facts and creates the verified payment and one-time code atomically. To assign one of the preselected ten-digit codes, append `--code=0123456789` to this command after verifying receipt. The code remains invalid until this command succeeds, expires 48 hours after assignment, and can be assigned only once across all orders. If the transfer was already verified using an automatically generated code, the operator can run `reissue-theme-code.js --reference=THEME-... --reviewer=... --code=0123456789 --reissue-code` to replace it before redemption. Keep the printed code private; plaintext codes are never stored in the database. `THEME_CODE_PEPPER` should be a stable deployment secret (the existing `JWT_SECRET` is the fallback) because it keys the permanent code-use fingerprints. It is never mounted as an HTTP endpoint. Duplicate confirmation is rejected, and the unique transaction index prevents reuse across orders. This is a manual review process, not automatic blockchain verification. No electronic merchant gateway is configured; `/subscription/checkout` and `/api/payments/webhook` continue to return 503. `payment.provider.js` remains the future electronic integration seam.

Uploaded images use the application's existing local `uploads` directory. Production deployment must provide persistent storage for that directory; ephemeral filesystems would lose custom images after restart. Create indexes with `node scripts/ensure-theme-indexes.js` only after reviewing the target database. No production database operation or payment confirmation was run here.

The older per-user `/api/subscriptions/*` and theme mutation routes are not mounted. Platform administrators share the one platform theme and entitlement; ordinary users cannot reach editor or billing APIs.

## Production deployment check

Before deployment, run `npm run verify:production` with the server's production environment loaded. Then run `node scripts/ensure-theme-indexes.js` once against the production MongoDB replica set. After the backend is live, verify `GET /health` and `GET /api/theme/published`; the latter returns a successful response with `published: null` until the first platform theme is published. Build the frontend only after setting `VITE_DATA_PROVIDER=real` and `VITE_API_BASE_URL` to this backend's public `/api` URL. The backend `ALLOWED_ORIGINS` value must include the exact frontend origin.

## Temporary activation codes and neon effects

After independent receipt verification, `confirm-theme-usdt.js` marks the payment verified and issues a random one-time 10-digit code unless an operator supplies one with `--code`. The operator sends the issued code privately to the paying administrator. It is stored as a salted hash, bound to that payer and payment, and expires after 48 hours. The admin editor finds the verified transfer automatically, so the payer enters only the code; only successful redemption creates the three-calendar-month subscription for a new order. The redeem endpoint is rate limited per administrator. A lost or expired unredeemed code can be replaced with `node scripts/reissue-theme-code.js --reference=THEME-... --reviewer=... --reissue-code`; the old code is invalidated. No code is created or sent before verified receipt, and no HTTP endpoint reveals a code. `PlatformThemeCodeUse` permanently records keyed fingerprints to prevent assigning a code twice; its unique index is prepared by the operator scripts and by `scripts/ensure-theme-indexes.js`.

Each light and dark appearance supports independent `neon` settings for `purchase`, `hero`, `categories`, and `bestSellers`, each with an enabled flag, hex color, and speed of 3, 5, 8, or 12 seconds. Publishing any nondefault neon setting requires verified active Pro access. The public page displays the last published neon settings and honors the visitor's reduced-motion preference. The new `PlatformThemeActivationCode` collection is included in `scripts/ensure-theme-indexes.js`.
