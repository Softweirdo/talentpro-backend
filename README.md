# TalentPro API

Node.js · Express 5 · Mongoose · TypeScript. Serves both the employee mobile app and the admin panel from one process.

## Setup

```bash
cp .env.example .env      # MONGODB_URI + four secrets
npm install
npm run seed:fresh        # wipes and reseeds with the prototype's demo data
npm run dev               # http://localhost:4000
```

Generate the secrets with `openssl rand -base64 48`. With `SMS_PROVIDER=mock` (the default) the OTP is logged *and* returned in the API response outside production, so the whole auth flow works with no gateway.

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Watch mode |
| `npm run seed` / `seed:fresh` | Seed, or wipe and seed |
| `npm test` | 38 unit tests (state machine, IST date maths, mobile normalisation, audience tiers, CSV) |
| `npm run tenure:run` | Run the tenure sweep once, now |
| `npm run reconcile` | Recompute every denormalised counter and report drift |
| `npm run typecheck` | `tsc --noEmit` |

`bash scripts/e2e.sh` exercises the whole product against a running server — 53 checks covering OTP login and rate limits, apply, refer (including first-referrer-wins and self-referral), the pipeline, inline organization editing with history archiving, code assignment, the tenure cron and its idempotency, payout with an edited amount, exports, and refresh-token reuse detection.

## Layout

```
src/
  config/     env (Zod-validated), db, logger, indexes
  models/     Employee Job Application Referral Reward Category
              Setting Otp RefreshToken Admin Notification AuditLog Counter
  modules/    auth employees jobs applications referrals rewards
              categories analytics exports settings notifications
  services/   tokens, employment, referralService, referralStateMachine,
              notify, sms/ (mock|fast2sms|msg91), push/ (mock|fcm)
  jobs/       tenureCron, reconcileCounters, scheduler
  middleware/ auth, rateLimit, validate, error
  utils/      dates (IST), mobile (E.164), crypto, csv, paginate, constants
  seed/       demo data lifted from the prototype
```

## Design decisions worth knowing

**Separate JWT secrets per audience.** An employee token presented to an admin route fails at *signature verification*, not at a claim check. The classic privilege-escalation bug in this architecture is a forgotten `aud` check; here it is unrepresentable.

**Refresh tokens rotate, and reuse is detected.** Presenting an already-rotated token revokes the whole family and forces re-authentication. For a passwordless app this is the cheapest meaningful defence.

**Stage transitions are events, not just a status field.** The dashboard funnel counts stages *ever reached* — once a candidate moves from shortlisted to hired, "how many were ever shortlisted" cannot be answered from `applications.status`. Hence `application_status_events`.

**Critical indexes are built and verified at startup.** MongoDB rejects `$ne`/`$nin` inside `partialFilterExpression` *silently*; Mongoose swallows the error, leaving a unique index that does not exist. Two business rules depend on such indexes, so `config/indexes.ts` asserts them and the server refuses to start in production without them.

**One writer per invariant.** `setCurrentOrganization` is the only thing that writes an employee's employer. `setApplicationStatus` is the only thing that moves an application. `transitionReferral` is the only thing that changes a referral's status. Every surface — inline edit, slide-out panel, pipeline drag, bulk action, mobile withdraw — routes through them.

## API

Base `/api/v1`. Errors are always `{ error: { code, message, details? } }` — branch on `code`, never on message text.

**Public** — `POST /auth/otp/request` · `/auth/otp/verify` · `/auth/register` · `/auth/refresh` · `/auth/logout` · `GET /categories` · `GET /config`

**Mobile** (employee token) — `GET|PATCH /me` · `/me/stats` · `/me/devices` · `GET /jobs` · `/jobs/recommended` · `/jobs/:id` · `POST /jobs/:id/apply` · `GET /applications` · `/applications/:id` · `DELETE /applications/:id` · `POST|GET /referrals` · `/referrals/stats` · `GET /rewards` · `/notifications`

**Admin** (admin token, `/api/v1/admin`) — `auth/login` · `analytics/{overview,funnel,jobs-by-category,employees-by-category,top-referrers,action-items}` · CRUD `jobs` `categories` `employees` · `applications/board` · `PATCH applications/:id/status` · `referrals` + `cancel`/`break-tenure` · `rewards` + `approve`/`hold`/`bulk-approve` · `employees/:id/current-organization` (PUT/DELETE) · `employees/:id/employment-history` · `exports/:entity.csv` · `settings`

## Cron

| Time (IST) | Job |
|---|---|
| 00:30 | Tenure sweep — complete due tenures, mint rewards, expire stale referrals |
| 09:00 | Health check — alerts if anything is past due but still running |
| 03:00 | Reconcile every denormalised counter, log any drift |

Set `ENABLE_CRON=false` when running more than one instance, and run the jobs from a single worker instead.
