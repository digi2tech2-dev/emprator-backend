# Order synchronization operations

This change affects backend code only. No production environment, provider record,
order, balance, PM2 process or deployment was changed during development.

## Confirmed configuration cause

The reported PM2 environment has BACKGROUND_JOBS_ENABLED=false and
SAFE_LOCAL_PRODUCTION_MODE=false. server.js therefore skips fulfillmentJob and
syncProvidersJob. The old production preflight only warned and could pass.

ecosystem.config.js sets NODE_ENV only, with one fork instance; it does not assign
BACKGROUND_JOBS_ENABLED. server.js loads dotenv before config, using the current
working directory. dotenv does not override an inherited variable. The false value
may therefore come from the environment captured by PM2 (including a saved process
definition) or from the working-directory .env when no inherited value exists.
The repository cannot establish which originally supplied the reported value.
Do not dump the full PM2 environment: it can contain credentials.

## Operator settings after review

Normal operation: BACKGROUND_JOBS_ENABLED=true, SAFE_LOCAL_PRODUCTION_MODE=false,
BACKGROUND_JOBS_MAINTENANCE=false. ORDER_POLL_INTERVAL_SECONDS defaults to 10
(allowed: 5, 10, 15, 20, 30, 60); review both suppliers' rate limits before rollout.
The enabled flag still defaults to true when
absent for compatibility. Only true/false values are accepted.

Intentional production maintenance requires all three:
BACKGROUND_JOBS_ENABLED=false, BACKGROUND_JOBS_MAINTENANCE=true, and a non-empty
BACKGROUND_JOBS_DISABLED_REASON. The reason is not printed. Both the preflight and
runtime reject an unacknowledged production disable before DB connection/listen.
The maintenance configuration starts the API but schedules neither job.

The verifier reads its own inherited environment plus cwd .env, not the running
PM2 process. Run it with exactly the reviewed environment intended for the process.
Changing .env alone does not override an old PM2 environment. An operator must
reconcile the saved PM2 definition and environment on an approved deployment;
PM2's update-env option is needed when applying changed inherited variables.

## Processing and concurrency

server.js starts fulfillmentJob for order status polling: one immediate cycle on
startup, then */10 * * * * * by default (every 10 seconds, configurable through
ORDER_POLL_INTERVAL_SECONDS). syncProvidersJob remains for product catalog only.
The compatibility orderPolling.job must not be scheduled separately.

No provider order-status webhook route or verified supplier webhook contract was
found in this repository. Fast polling is best effort: detection latency includes
the poll interval, request duration, preceding groups/batches and any in-flight
cycle. It cannot promise same-instant updates or a strict ten-second maximum.
A verified supplier webhook contract with authenticated delivery, replay protection
and order correlation is required to implement push-driven immediate updates;
no undocumented provider callback endpoint, signing secret or payload was invented.
Nothing about either supplier's actual webhook support or allowed polling rate
has been assumed or tested against production.

Fast checks do not burn the retry budget faster: retryCount consumes at most one
window every five minutes, using the new nullable lastRetryAt field. The existing
24-window manual-review budget therefore remains roughly two hours rather than
being exhausted in four minutes. Existing records need no manual migration: the
first check initializes lastRetryAt and retains their stored retry count.
Both service entry points share the same MongoDB background_job_locks document
with _id order-status-poll, so separate processes and overlapping schedulers cannot
poll concurrently. Failure to acquire the lock skips the cycle; DB errors fail closed.

The lock is deliberately not a timed lease: expiring a lock during a slow provider
request could allow duplicate pollers. Finally releases it after a normal run or
exception. A process kill/crash can leave it behind. The next cycle may recover it only when
the lock hostname matches this host and a process-liveness probe returns ESRCH
(the owner PID no longer exists). Permission failures and a reused live PID never
permit recovery. Locks on another host require manual recovery. Lock writes use
majority acknowledgment. Alert on repeated skipped cycles
or an old startedAt. Manual recovery requires stopping ALL pollers, confirming the recorded
host/pid is no longer executing, inspecting the lock, and explicitly removing ONLY
that lock with its recorded owner before resuming. Never clear a live lock. No lock
was removed from any production database during this work. This operational
tradeoff requires review before deployment.

Automatic PROCESSING orders with a providerOrderId (or uncertain placement) are
loaded oldest-check first, capped at 200. providerCode resolves an active Provider
by slug or exact case-insensitive name; keep provider slugs stable. Factory priority
is adapterType, slug, name. The fulfillment poller requests strict resolution,
preventing mock fallback for unknown providers. No Kanz Coins or AD-CARD adapter
or endpoint is guessed. Review each actual Provider's slug, adapterType and baseUrl
against its verified contract. canonical-b2b is suitable only if its contract matches.
Tokens are read from apiToken, then apiKey, then effectiveToken, skipping blanks.
These come from Provider records, not provider-name .env placeholders.

checkOrders results are matched by providerOrderId. accept/completed => COMPLETED;
wait/pending/unknown => PROCESSING; reject/failed => FAILED; cancelled => CANCELED.
Pending retry exhaustion => MANUAL_REVIEW without refund. Batch DNS, timeout and
authentication exceptions leave orders PROCESSING; diagnostics record only safe
categories, never arbitrary error messages/HTTP config. Existing adapters must
continue throwing request/authentication errors rather than synthesizing terminal
order status. Status writes use a PROCESSING compare-and-swap before refund or
notifications, preventing stale snapshots from overwriting manual completion.
Uncertain placement uses reference lookup only, never another placement request.

The failed-order refund guard now commits in the same MongoDB transaction as the
wallet credit (with transaction retries). A concurrent manual completion prevents
that transaction from refunding the completed order. The existing canceled/partial
refund path remains transactional. Historical inconsistent guards are not repaired
by this change. A crash between recording a terminal failure and entering its
refund transaction can still leave a terminal order awaiting reconciliation;
this change does not introduce an automatic terminal-refund recovery worker.

## Safe rollout and unresolved checks

1. Review code and test results. Run npm ci and npm test in an isolated local/staging
   environment; tests use a disposable MongoDB replica set and mocked providers.
2. Review only the necessary flag values and process cwd. Reconcile PM2 environment
   with the intended source; do not print tokens or full environment dumps.
3. Have an authorized operator inspect the two Provider records without exporting
   credentials: active flag, stable code/slug, adapterType, verified baseUrl and whether
   an approved token field is non-empty. Missing-token errors are independent of the
   jobs flag. Check DNS for the configured AD-CARD hostname from the deployment
   host in an approved diagnostic window; ENOTFOUND is independently blocking.
   No production provider was contacted during development.
4. Run npm run verify:production in the exact proposed environment; acknowledged
   maintenance may pass but deliberately keeps polling off. Review that choice.
5. After approval, deploy via the established procedure and apply reviewed variables.
   No restart/deploy was performed by this change. Check startup enabled/disabled
   logs (an immediate cycle and the configured seconds schedule), then polling
   completion, pending/error counts,
   lock age and absence of a separately scheduled compatibility poller.
6. Observe existing orders through read-only views. Never replay placements, modify
   balances, or force terminal states as a verification technique. Maintenance rollback
   uses the explicit flags above; reverting code alone does not correct PM2 flags.

Production recovery is not proven until actual credential, adapter, provider-code
and DNS checks pass and an authorized deployment records successful polling.


## Validation results

Initial synchronization-fix validation (2026-10-22, Cairo date; fast-polling follow-up below):

- npm ci --ignore-scripts --no-audit --no-fund with a workspace-local npm cache:
  735 packages installed; package manifests/lockfile unchanged. Installation hooks
  were disabled to prevent unrelated browser downloads.
- Focused Jest run: 7 suites, 95 tests passed.
- Initial complete npm test: 43 suites, 946 tests passed, exit code 0, 109.996 seconds.
  Output: .tmp-order-sync-full.log (local ignored log).
- node --check passed for every changed runtime JavaScript file and the preflight.
- git diff --check passed.
- There is no separate lint/build script in package.json.

All database tests used MongoMemoryReplSet with a temporary local MongoDB 8.2.1
binary from the official distribution, never a production URI. The binary was
ZIP CRC-verified and version-checked. Local reusable binary cache:
node_modules/.cache/order-sync-mongodb/mongod.exe. To repeat with that binary,
set MONGOMS_SYSTEM_BINARY to its absolute path for the test command only.
Provider checks/placements used mocks. No production supplier HTTP, production
DB access, PM2 changes, restart or deploy was performed.

Early attempts were blocked by missing Jest and unwritable default cache paths.
After installing locally, the first integration run exposed an old assertion
expecting a raw timeout message, a duplicate null idempotency key in a new fixture,
and an existing unit test reading WhatsApp settings without a DB connection.
The assertion now expects a safe error category, fixtures have distinct keys, and
the settings read is mocked in that unit test. The final complete run above passed.
Existing duplicate slug-index warnings and the project's forceExit/open-handle
notice remain; no clean open-handle audit is claimed.

## Changed files and purpose

| File | Purpose |
| --- | --- |
| src/config/backgroundJobs.js | Shared flag and polling-interval validation with explicit maintenance acknowledgment. |
| src/config/orderPolling.js | Configure fast polling and keep the retry budget independent of poll frequency. |
| src/modules/orders/order.model.js | Store nullable lastRetryAt for five-minute retry accounting windows. |
| src/config/config.js | Expose the common policy to startup. |
| src/server.js | Validate before connection/listen; log enabled/disabled jobs clearly. |
| scripts/verify-production-env.js | Fail preflight on accidental or malformed job-disable settings. |
| .env.example | Document maintenance variables without changing any actual environment. |
| src/modules/orders/fulfillmentJob.js | Enforce scheduler policy; safe exception diagnostics. |
| src/modules/orders/orderPolling.job.js | Enforce policy and clarify compatibility-only scheduling. |
| src/modules/providers/syncProvidersJob.js | Enforce the same scheduling policy for catalog sync. |
| src/modules/orders/orderPollLock.js | Share a majority-acknowledged lock across both pollers/processes and safely recover dead local owners. |
| src/modules/orders/safePollError.js | Emit safe error categories without request secrets. |
| src/modules/orders/orderFulfillment.service.js | Lock the polling cycle, prefer slug routing, require supported adapters, guard status writes, use manual review for uncertain exhaustion, and make failed-order refund guard/credit transactional. |
| src/modules/orders/orderPolling.service.js | Share the same polling lock and safe error diagnostics. |
| src/modules/providers/adapters/base.adapter.js | Resolve approved token fields while skipping blank values. |
| src/modules/providers/adapters/canonicalB2B.adapter.js | Treat DNS placement errors as uncertain; reject malformed check envelopes. |
| src/tests/backgroundJobs.test.js | Test actual preflight exit codes and maintenance validation. |
| src/tests/backgroundJobSchedulers.test.js | Test deliberate disable, immediate polling, ten-second schedule, duplicate start and overlapping tick suppression. |
| src/tests/fulfillment.test.js | Test routing, concurrency, stale completion, error redaction, refund atomicity and lock recovery; update exhaustion expectation. |
| src/tests/canonicalB2BAdapter.test.js | Test blank-token fallback, missing token, DNS uncertainty and invalid check responses using fake HTTP. |
| src/tests/safeLocalProductionMode.test.js | Test production startup policy; isolate safe-mode WhatsApp status read. |
| docs/order-sync.md | Explain settings, provenance limits, safe rollout, recovery and test evidence. |

The tracked ecosystem.config.js was inspected and left unchanged. No Frontend
file, actual .env file or production configuration was edited.


## Fast-polling follow-up validation

The user requested updates without a multi-minute polling delay. The scheduler
now checks immediately on startup and every ten seconds by default. The focused
follow-up run passed 100 tests in 7 suites. Added coverage includes immediate
execution, skipped overlapping fast ticks, interval preflight validation, retry
budget preservation, and a pending order completing on the next mocked response
without another placement. The complete follow-up test result is recorded below.


Final fast-polling validation: npm test passed 43 suites and 951 tests, exit code 0,
in 88.758 seconds. Log: .tmp-order-sync-fast-full.log. node --check passed for the
changed runtime modules; git diff --check passed. No production runtime or supplier
connection was used for this follow-up.
