# Brand One Card provider

This integration is for https://api.brand-one-card.com. The existing
`brand1-card` provider and its aliases still use `AlkasrVipAdapter`.

Create a provider with these settings (replace the token):

```json
{
  "name": "Brand One Card",
  "adapterType": "brand-one-card",
  "baseUrl": "https://api.brand-one-card.com",
  "apiToken": "YOUR_API_TOKEN",
  "isActive": true
}
```

The factory also resolves slug `brand-one-card` and names `brand one card`
or `brandonecard`. No production provider record is created by this code change.

Provider accounts can use USD, EGP or another active platform currency. Product
prices are converted to internal USD using the currency's configured
`platformRate` (local units per USD). For example, 50 EGP at a rate of 50
is imported as 1 USD. Configure and activate EGP in the platform before syncing.
Missing, inactive or invalid currency rates cause an explicit sync error rather
than importing incorrectly priced products. If a product omits currency, the
adapter reads it from the account profile. Original supplier prices and currency
remain in `rawPayload`; balance continues to use the supplier account currency.
Product `params`, `params_info`, `product_type`, currency and other metadata are
preserved in `rawPayload`. Map customer fields to the exact API keys in `params`
(for example `playerId` or `serverId`) through the existing provider mapping.
Products with `qty_values: null` are imported with minimum and maximum quantity 1.

Order placement uses the existing order number as `order_uuid`. Direct adapter
callers must supply a stable `referenceId`, `orderUuid` or `order_uuid` and reuse
it on every retry. `accept`, `wait` and `reject` map to Completed, Pending and
Cancelled. Explicit API errors are rejections; lost or unexpected responses
trigger UUID lookup and remain `PLACEMENT_UNCERTAIN` if lookup cannot recover
them. The existing fulfillment poller then retries reference lookup and can
escalate unresolved orders to manual review without automatically refunding them.

This integration uses polling via `/client/api/check`; no webhook receiver is
added. `getContent(categoryId)` exposes category browsing when needed.

Before live use, allow the backend's public outbound IP on the provider's API
page, disable purchase 2FA for API orders, and keep traffic within the documented
limits (300 requests/minute/IP, including at most 120 newOrder requests/minute).
The adapter does not add a shared rate limiter across backend workers.

Automated tests mock HTTP and do not spend provider balance. Live verification
requires the real token and allowed server IP; start with a balance/catalog
request before placing an explicitly authorized test order.
