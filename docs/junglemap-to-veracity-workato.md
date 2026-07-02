# JungleMap → Veracity LRS (Workato build guide)

How to pull training completion data out of the JungleMap / NanoLearning API
and record it in the Veracity LRS as xAPI statements, built entirely inside
Workato (the embedded Docebo Connect instance). A later phase uses Docebo's
Workato to send overdue-course notifications.

```
JungleMap (NanoLearning) API ──> Veracity LRS (xAPI)        [this guide]
                                      │
                                      └──> Docebo/Workato overdue notifications   [phase 2]
```

## Credentials

Stored as Workato secrets / connection fields — **never hardcode them in a
recipe or commit them to this repo.**

| Name | Where it goes |
|------|---------------|
| `JUNGLEMAP_USERNAME` | the long `username` value from NanoLearning |
| `JUNGLEMAP_PASSWORD` | the `password` value from NanoLearning |
| `client_id` | the literal string `fp` (not the username) |

> Note: NanoLearning's published cURL example has a typo — `username=<username>S`
> with a stray trailing `S`. Use the raw username with nothing appended.

## Auth — the part that bites everyone

JungleMap's `/token` endpoint is an **OAuth2 password (resource-owner) grant**,
*not* HTTP Basic auth and *not* client-credentials. Workato's connection-level
auth types do **not** fit it:

- **Client-credentials grant** — has no `username` field at all → server
  returns `invalid_grant: "Username is required"`.
- **Authorization-code grant** — wrong flow (interactive redirect).
- **Custom** — only does *static* Basic/header/URL-param auth; it can't perform
  a token exchange.

**Solution: do the token exchange inside the recipe.** Set the HTTP connection's
Authentication type to **None**, leave the **Base URL blank** (a set Base URL
locks every call to that one URL), and click Connect — it succeeds instantly.

## Step 1 — Get a bearer token

HTTP "Send request":

- Method: `POST`
- URL: `https://go.nanolearning.com/token`
- Request body type: **URL encoded form** (not JSON)
- Body fields:
  - `grant_type` = `password`
  - `client_id` = `fp`
  - `username` = `{JUNGLEMAP_USERNAME}`
  - `password` = `{JUNGLEMAP_PASSWORD}`

Response (the field you need is `access_token`):

```json
{ "access_token": "…", "token_type": "bearer", "expires_in": 3599, "…": "…" }
```

The token is valid ~60 minutes. For a daily scheduled run, fetching it once at
the start of the job is fine.

Equivalent cURL (for testing creds outside Workato):

```bash
curl -X POST https://go.nanolearning.com/token \
  -H 'content-type: application/x-www-form-urlencoded' \
  --data-urlencode 'grant_type=password' \
  --data-urlencode 'client_id=fp' \
  --data-urlencode 'username=<JUNGLEMAP_USERNAME>' \
  --data-urlencode 'password=<JUNGLEMAP_PASSWORD>'
```

## Step 2 — List activity plans

HTTP "Send request":

- Method: `GET`
- URL: `https://go.nanolearning.com/api/Integrations/GetActivityPlans?stage=Production&includeActivities=true`
- Header: `Authorization` = `Bearer {access_token}`

Returns an array of plans. Current production data has a single plan:

```json
[{ "Id": 146291, "Name": "Information security awareness 2025 (ENG)", "Activities": [ … 17 activities … ] }]
```

## Step 3 — Get statistics (the users)

HTTP "Send request":

- Method: `POST`
- URL: `https://go.nanolearning.com/api/Integrations/GetStatistics`
- Headers: `Authorization` = `Bearer {access_token}`, `Content-Type` = `application/json`
- Request body type: **JSON**
- Body:

```json
{ "ActivityPlanId": 146291, "IncludeActivityStatistics": true }
```

> Robustness: wrap Steps 3+ in a **Repeat** over the Step 2 plan list and map
> `ActivityPlanId` to each plan's `Id`, so new plans are picked up automatically.

Returns an array where **each element is a user**. Real 2025 production shape
(differs from NanoLearning's older documented example):

```json
{
  "DistributionUserId": 39498884,
  "Email": "user@transmedics.com",
  "ExternalId": "1364fc2d-0093-494d-99d4-5af9c086d544",
  "DistributionName": "Security Awareness Training",
  "StartedActivities": 9,
  "StartedCount": 0,
  "CompletedCount": 0,
  "CourseCompletionStatus": "Pending",
  "StarPointsScore1to5": 1,
  "ActivityStatistics": [
    {
      "Title": "Email security and ransomware",
      "HasStarted": false,
      "HasCompleted": false,
      "ActivityId": 4675866,
      "Type": "Nano",
      "Started": "0001-01-01T00:00:00",
      "Completed": "0001-01-01T00:00:00",
      "DistributionActivityStarted": "2026-03-10T13:30:57.763",
      "PersonalInformationHidden": false
    }
  ],
  "ActivityCount": 16,
  "FirstStartedActivity": "0001-01-01T00:00:00.000000+00:49",
  "LastCompletedActivity": "0001-01-01T00:00:00.000000+00:49"
}
```

Semantics (confirmed against production data, 2026-07):

- **`CourseCompletionStatus`** is the authoritative roll-up (`Pending`,
  presumably `Completed`) — use it for the verb instead of comparing counts.
- **Sentinel dates, not nulls:** "never started/completed" comes back as
  .NET DateTime.MinValue — `0001-01-01T00:00:00`. Guard every date formula
  with *starts-with-`0001` ⇒ treat as absent*.
- **This is a drip campaign.** `ActivityStatistics` contains only activities
  whose *distribution has begun* (`DistributionActivityStarted` runs monthly,
  Nov 2025 → …). `StartedActivities` counts released activities, **not** user
  starts. So the array grows over the campaign; don't assume its length equals
  `ActivityCount` (16 — the plan's 17 minus the admin-only Readme).
- **`StartedCount`/`CompletedCount`** are the user's own starts/completions
  (per-user roll-ups of `HasStarted`/`HasCompleted`).
- **No `SecondsUsed` in the 2025 response** — the statement carries no
  `result.duration`.

> ⚠️ With `IncludeActivityStatistics: true` this response is large (every user ×
> every activity). It will crash the browser if you try to expand it in Workato's
> output preview — that's the UI rendering, not the recipe. Don't open the full
> blob; pipe the array straight into a Repeat and process per user.

## Step 4 — Statement model: one per module event, plus a course completion

> Earlier drafts used one compiled statement per user with the whole
> `ActivityStatistics` array in `result.extensions`. Rejected: xAPI queries and
> Veracity dashboards can't see into extensions, and every monthly module
> release forced a fresh snapshot statement for all ~1000 users. The
> per-module model below is queryable, needs no snapshot churn, and its
> idempotency is simpler.

For each user in the batch, emit:

- **One statement per module the user has touched:**
  - `HasCompleted` (real `Completed` date) → verb `completed`
  - else `HasStarted` (real `Started` date) → verb `attempted`
  - released but untouched → **no statement** (so new monthly releases write
    nothing until someone acts)
  - `object` = `https://go.nanolearning.com/activities/{ActivityId}` (type
    `module`), named from `Title`
  - `timestamp` = the module's own `Started`/`Completed` time (assumed UTC —
    open question — with `Z` appended, since xAPI requires a zone)
  - `context.contextActivities.parent` = the course activity, so per-course
    rollups group the modules
- **One course-level statement when `CourseCompletionStatus == "Completed"`:**
  verb `completed`, `object` = `https://go.nanolearning.com/activityplans/{planId}`
  (type `course`), timestamped from `LastCompletedActivity`.

All of this is implemented in
[`workato/build-xapi-statements.js`](../workato/build-xapi-statements.js) —
including the year-0001 sentinel guard and an `account`-based actor fallback
for users without an email.

### How the lifecycle lands in the LRS

The recipe polls state daily; deterministic ids turn that into an event log:

1. *User starts module 7* → next run emits `attempted module-7` (timestamped
   with the real start time). Every later run regenerates the identical
   statement — same id, same content — which the LRS ignores. One event, once.
2. *User finishes module 7* → next run adds `completed module-7`. The earlier
   `attempted` stays — that's the history, not a duplicate.
3. *User finishes the last released module* → JungleMap flips
   `CourseCompletionStatus` → the same run emits `completed course`.
4. *JungleMap releases module 10* → nothing is written for anyone until they
   act. (If the release flips completed users back to `Pending`, their course
   completion simply recurs later with a new date — a true second completion.)

Phase-2 overdue check becomes a standard LRS query — e.g. "actors with no
`completed` statement for activity `…/activities/{newest module id}`" — no
JSON parsing required.

## Step 5 — Write to Veracity (batched, idempotent, test-store first)

GetStatistics hands you ~1000 users in one blob. Three different things can
"crash" here, and each has its own fix — don't conflate them:

| Failure point | What actually breaks | Fix |
|---|---|---|
| Workato output preview | The browser tab, rendering a huge JSON tree | Never expand the full array in the UI; only preview single-batch outputs |
| One giant POST to Veracity | Request rejected or timed out (body-size / request limits) | Batch 50 statements per POST (~20 calls for 1000 users) |
| A re-run after a partial failure | Duplicate statements in the LRS | Deterministic statement `id` — replays become no-ops |

### 5a. Get the store credentials

From the Veracity store owner (goes into **Workato connection fields /
secrets, not into a recipe body and not into this repo**):

- the store's xAPI endpoint — for this project:
  `https://transmedics.enterprise.lrs.io/junglemap/xapi/`
- an **access key** (username + password pair) for that store, created in
  Veracity under the store's *Access Keys*. Ask for a key with **write**
  permission scoped to just this store. Referenced below as
  `VERACITY_KEY` / `VERACITY_SECRET`.

### 5b. Smoke-test the credentials with ONE statement

Before wiring anything into the pipeline, prove the endpoint + key work with a
single hand-written statement (from a terminal, or a throwaway Workato job):

```bash
curl -X POST 'https://transmedics.enterprise.lrs.io/junglemap/xapi/statements' \
  -u "$VERACITY_KEY:$VERACITY_SECRET" \
  -H 'X-Experience-API-Version: 1.0.3' \
  -H 'Content-Type: application/json' \
  -d '[{
    "id": "00000000-0000-4000-8000-000000000001",
    "actor": { "objectType": "Agent", "mbox": "mailto:smoketest@example.com", "name": "smoketest" },
    "verb": { "id": "http://adlnet.gov/expapi/verbs/completed", "display": { "en-US": "completed" } },
    "object": { "objectType": "Activity", "id": "https://go.nanolearning.com/activityplans/smoketest" }
  }]'
```

A `200` with a JSON array containing the statement id = good. `401` = key
wrong; `403` = key lacks write on this store. The fixed `id` means you can run
this as many times as you like — it stays one statement.

### 5c. Use a test store for the first full run

Veracity lets one account hold multiple stores, each with its own endpoint and
keys. Create (or ask the owner for) a **scratch store** and point the recipe at
it for the first end-to-end run. Verify the statements look right in Veracity's
statement viewer, then switch the endpoint/key connection fields to the real
store and run again. Because store choice lives in the connection, the recipe
itself doesn't change — no risk of a half-edited recipe writing test data to
prod.

### 5d. Deterministic statement IDs (what makes retries safe)

Give every statement an explicit `id`, derived from the event instead of
random:

```
module event:      {DistributionUserId} | {ActivityId} | {verb} | {event timestamp}
course completion: {DistributionUserId} | {planId} | course-completed | {LastCompletedActivity}
```

A module event is immutable — once completed, its statement never changes — so
the id never needs to change either. Implemented in
[`workato/build-xapi-statements.js`](../workato/build-xapi-statements.js)
(FNV-1a hash formatted as an RFC-4122-shaped UUID).

Why this matters: per the xAPI spec, POSTing a statement whose `id` the LRS has
already seen (with identical content) is a **no-op**. So if batch 7 of 20 fails
and the job retries from the top, batches 1–6 don't double-write. It also makes
the daily schedule naturally incremental — already-recorded events regenerate
identical statements the LRS ignores; only genuinely new events land.

> One statement id with *different* content returns `409 Conflict` — if you see
> 409s, the id recipe above isn't including every field that can change.

### 5e. The batched write in Workato

Connection note: the recipe uses a **secondary HTTP connection** for Veracity
(Basic auth — access key as username, secret as password), alongside the
auth-None JungleMap connection. Verified working 2026-07-01. If the LRS
answers `401 {"message":"invalid login"}`, the key/secret are swapped or the
connection isn't Basic.

1. Inside the plan loop after GetStatistics, add a **Repeat** over the user
   array in **"Batch of items"** mode, **batch size 25**. Each iteration hands
   you a list of ≤25 users instead of one. (25, not 50: with per-module
   statements a batch can carry ~17 statements per user, and 25 keeps each
   POST comfortably small.)
2. Inside the loop, a **JavaScript by Workato** action builds the statement
   array — full code in
   [`workato/build-xapi-statements.js`](../workato/build-xapi-statements.js).
   Inputs: `users` (the batch datapill), `planId`, `planName` (from the plan
   loop). Outputs: `body` (JSON string, the statement array) and `count`.
   This one action does the verb roll-up, sentinel-date guard, no-email actor
   fallback, deterministic ids (5d), and the extensions passthrough.
3. HTTP "Send request" per batch (Veracity connection):
   - Method: `POST`
   - URL: `https://transmedics.enterprise.lrs.io/junglemap/xapi/statements`
   - Headers: `X-Experience-API-Version` = `1.0.3`, `Content-Type` =
     `application/json` (Authorization comes from the connection's Basic auth)
   - Body (raw): the `body` datapill from the JavaScript action
   - **Wait for response: Yes** (off = fire-and-forget, no status code, no
     retries), response timeout ~120 s.
4. Wrap the POST in Workato's **error monitor** with **retry: 3, with delay**
   so a transient 429/5xx retries that batch only. Thanks to 5d, even a
   full-job re-run is safe.
5. Success response is a JSON array of the accepted statement ids — log
   `batch index` + the JS action's `count` per iteration (small, safe to
   preview) rather than the statement bodies.

Sequential batches of 50 also act as a natural throttle — Workato runs loop
iterations one at a time, so Veracity never sees more than one in-flight
request from this recipe.

### 5f. First-run checklist

- [x] 5b smoke test passes (2026-07-01 — 200 from the `junglemap` store via
      the secondary Basic-auth connection)
- [ ] **Limited trial first** (no scratch store exists, so trial in place):
      temporarily add `users = users.slice(0, 5);` as the first line of the
      JavaScript action's `main`, run once, spot-check those 5 users in
      Veracity's viewer: verb roll-up right, `ActivityStatistics` extension
      intact, ids stable
- [ ] Remove the slice, full run — all ~20 batches return 200
- [ ] Re-run the whole job — statement count in the store must **not** grow
      (proves 5d idempotency)
- [ ] Switch the trigger from every-5-minutes to **daily** (idempotency makes
      frequent runs harmless, but they burn tasks)
- [ ] Only then leave the recipe running on schedule

## Phase 2 — Overdue notifications (Docebo / Workato)

Out of scope for the ingestion above. Either the ingestion flags overdue users
(`CompletedCount < ActivityCount` past a due date), or a Docebo Workato recipe
queries Veracity for who lacks a `completed` statement, then sends the reminders
through Docebo's native notification connector.

## Open questions

- **Timezone:** JungleMap timestamps (`2020-01-15T18:33:51.297`) carry no zone.
  Confirm with NanoLearning whether they're UTC before relying on them in
  statement timestamps.
- **Volume / Workato limits:** if the user count makes a single GetStatistics
  response exceed Workato job-size limits, we may need to chunk. The API exposes
  no pagination, so the response is all-or-nothing per plan.
