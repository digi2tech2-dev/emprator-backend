# Emperor Store: sender phone deposits

## Scope and preservation

Backend only. No server/environment/PM2/Nginx configuration or actual .env file
was modified for this task. No deployment, production DB connection, historical
data update, database recreation or supplier request was performed.

Before editing, all 22 pre-existing changed/untracked project files were copied.
The preserved snapshot is .tmp/deposit-change-backup-20261022-231027.zip. Every
archive entry was CRC-checked and SHA-256 compared with its source copy; the 22
working files were also compared against that snapshot with zero differences.
The ZIP avoids Jest discovering backup copies as extra test suites.

## Design decision

The actual deposit model is Mongoose DepositRequest. transactionId is a real
payment reference: it is checked for duplicate Electronic Wallet submissions and
used by the authenticated Vodafone SMS reconciliation path. paymentTransactionId
and labelled notes are historical reconciliation fallbacks. These fields must
not silently become phone numbers.

The existing senderDetails object already stores sender identity/wallet/address
information. Reuse it for the new meaning with an explicit discriminator rather
than adding another persisted phone field or changing transactionId:

    senderDetails.field = 'senderPhoneNumber'
    senderDetails.value = normalized sender phone
    senderDetails.label = server-defined sender phone label

There is no schema/index migration and no new DB column/field definition. No old
record is rewritten or inferred to be a phone because it happens to contain digits.
The top-level senderPhoneNumber is an additive input, not a renamed transactionId
and not a new top-level response/storage field.

## API contract

Both POST /api/deposits and POST /api/me/deposits accept multipart/form-data:

- requestedAmount, currency and paymentMethodId: existing fields and validation.
- senderPhoneNumber: explicit new sender-phone input, required and non-empty when
  this field is supplied. Instead, a caller may send senderDetails JSON with
  field='senderPhoneNumber' and value containing the phone.
- receipt: required in this explicit phone workflow, including Electronic Wallet
  methods. The same upload restrictions, image analysis and PDF support run.
- notes: existing optional notes. Optional transactionId must still mean an actual
  transaction reference when supplied; existing duplicate checks still apply.

The normal success/history/detail/admin response shape remains unchanged; phone
submissions return the phone in senderDetails and a null transactionId when no
actual transaction ID was provided. Callers must not map the phone into a
transaction-number response or copy it into notes as a transaction reference.

An explicit blank/null/invalid phone is rejected. If neither phone input nor its
senderDetails discriminator is supplied, legacy submission rules remain: wallet
transactionId is still required, and old non-wallet receipt submissions continue.
This opt-in distinction is necessary to keep existing API clients compatible.
Conflicting explicit phone and senderDetails values are rejected rather than
silently overwriting one of them.

The existing shared phone normalizer handles local numbers and international
numbers, ASCII/Arabic/Persian digits, spaces, hyphens and parentheses. It retains
leading local zeroes and an explicitly supplied +, and validates 7-15 digits.
Raw input is limited to 64 characters and must be a string. No Egyptian-only
restriction or guessed country calling code was added: payment settings have
method types but no authoritative sender-country numbering metadata. Validation
is structural; it does not prove phone ownership or a successful transfer.
Existing wallet addresses/legacy sender aliases are unaffected.

## Review, receipts and money safety

New phone submissions always start PENDING. Amount/currency/rate/fee calculations,
admin privileges, ownership checks, receipt analysis, review statuses and the
transactional compare-and-swap for wallet credit remain unchanged. A phone is not
unique: the same person can send multiple payments. The existing real-reference
duplicate guard remains active when a transactionId is supplied. As with the
pre-existing receipt workflow, absence of a transaction ID requires manual review;
this change does not claim a new receipt-replay detection mechanism.

Phone-only deposits cannot match an SMS transaction by a phone or labelled note:
extractDepositTransactionId returns null for the explicit phone workflow unless
an actual transactionId is present. With an actual transaction reference, the
existing amount/method/phone matching remains in use. An explicit international
phone that cannot match the Egyptian SMS parser is a mismatch, rather than being
silently ignored. Old reconciliation fallbacks are retained for old deposits.

The phone remains available to authorized customer/admin API views. It is redacted
in the new-flow request audit metadata and validation logs. No phone is added to
notification text or generic error messages. Audit events and financial metadata
are retained.

## Frontend work required separately

The adjacent frontend was inspected read-only. PaymentDetails.jsx, useTopupStore.js
and realApi.js currently submit transactionId and aliases; realApi.js can also put
transaction numbers into notes. The new UI must send senderPhoneNumber (including
multipart serialization), or the explicit senderDetails discriminator above, and
include a receipt. Change the label/input and validation from transaction number
to sender phone for the new workflow. Do not put a phone in transactionId,
transactionNumber/paymentReference aliases, or the transaction note fallback.

AdminPayments.jsx already consumes senderDetails.label/value. New display logic
should show those as sender phone when field='senderPhoneNumber', while preserving
actual old transaction IDs under their original label. Old rows must not be
relabelled as phones. Existing sender details and transaction responses are
preserved, so the current frontend continues its legacy behavior until updated.
No frontend file was modified.

## Files inspected

Backend deposit model/service/controllers/routes/validation and payment-method
requirements; me.controller.js and me.routes.js; admin.routes.js deposit list,
detail, edit, approve/reject/review endpoints and admin.validation.js; receiptAnalyzer
and upload middleware; shared phone normalization; authentication, active/profile
and validation/error middleware; notifications and deposit audit paths; payment
Event model/parser/service and HMAC entry tests; package.json and test setup.

The usage scan also covered target transactionNumber, referral payout references
and wallet-ledger transactionId. Those identifiers belong to different operations
and were left unchanged. Frontend consumers inspected read-only: PaymentDetails.jsx,
AdminPayments.jsx, services/realApi.js, useTopupStore.js, useTargetStore.js and the
referenced target/history components. No compatibility assumption is made about
unavailable external clients; the legacy API contract is retained for them.

## Files changed

| File | Reason |
| --- | --- |
| src/modules/deposits/deposit.service.js | Explicit phone normalization into existing senderDetails, shared evidence checks, redacted new-flow audit metadata, direct-service validation. Existing approval/rejection/amount logic untouched. |
| src/modules/deposits/deposit.controller.js | Accept phone+receipt workflow while retaining legacy transaction behavior. |
| src/modules/deposits/deposit.validation.js | Validate the additive phone input through the same shared normalizer. |
| src/modules/deposits/deposit.routes.js | Document the two compatible submission modes. Route permissions unchanged. |
| src/modules/me/me.controller.js | Apply the same evidence rules on the second create endpoint. |
| src/modules/me/me.routes.js | Validate/document phone input on the second endpoint. |
| src/modules/paymentEvents/paymentEvent.service.js | Prevent phone/note-only automatic reconciliation; do not ignore an explicit incompatible sender phone. |
| src/tests/depositSenderPhone.test.js | Local API/model/admin/receipt/privacy/backward-compatibility tests. |
| src/tests/paymentEvent.test.js | Prove phone+amount cannot auto-approve without a reference and an explicit incompatible phone does not match. |
| docs/deposit-sender-phone.md | Document contract, compatibility, frontend integration, inspected files, preserved changes and verification. |

## Validation

Focused final run: 6 suites, 115 tests passed, 17.812 seconds. It covers real local
multipart uploads with synthetic image fixtures, actual existing image analysis,
empty/invalid phones, local/international/Arabic-digit phones, persistence/history,
admin views/approval/idempotence/permissions, amount/status tampering protection,
legacy transactions/duplicates/history, wallet-address compatibility, audit/log
redaction, and payment-event safeguards.

Early test fixture issues (missing profile phone and expecting 400 rather than the
existing 422 business-rule response) were corrected without changing authorization
or error status behavior. An initial broad test run found copied backup tests via
Jest's glob: 3 backup suites failed to load; it was not counted as a passing full
run. The verified backup was archived before the final clean run.

Database tests use a disposable local MongoMemoryReplSet and the cached local test
mongod binary. HTTP requests target only the local test listener. Notifications are
mocked in the new API tests. Production config/data is not used.

node --check passed on all 7 changed runtime files and both affected test files.
git diff --check passed. package.json provides no lint/build scripts, so no such
checks are claimed. The final complete Jest result is appended after completion.


Final clean full run (2026-10-22, Cairo date): npm test passed all 44 suites and
974 tests, exit code 0, in 89.267 seconds. Full log: .tmp-deposit-phone-full-final.log.
Focused final log: .tmp-deposit-phone-targeted-final.log. Existing duplicate-index
warnings and the package's --forceExit/open-handle notice remain; no separate
open-handle audit is claimed. A final SHA-256 comparison against the ZIP snapshot
confirmed all 22 pre-existing changed files still match. No production action was
performed.
