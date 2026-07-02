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

Returns an array where **each element is a user**:

```json
{
  "DistributionUserId": 364343,
  "Email": "user@example.com",
  "StartedCount": 1,
  "CompletedCount": 1,
  "SecondsUsed": 232,
  "ActivityCount": 1,
  "ActivityStatistics": [
    { "Title": "Become a STAR in information security", "HasStarted": true,
      "HasCompleted": true, "ActivityId": 4675859, "Type": "Nano",
      "Started": "2020-01-15T18:33:27.367", "Completed": "2020-01-15T18:33:51.297" }
  ],
  "FirstStartedActivity": "…", "LastCompletedActivity": "…"
}
```

> ⚠️ With `IncludeActivityStatistics: true` this response is large (every user ×
> every activity). It will crash the browser if you try to expand it in Workato's
> output preview — that's the UI rendering, not the recipe. Don't open the full
> blob; pipe the array straight into a Repeat and process per user.

## Step 4 — One xAPI statement per user

Add a **Repeat over the user array** (one level — do *not* split activities into
separate statements). For each user, emit a single statement; the per-course
detail rides inside `result.extensions` as the user's `ActivityStatistics` array.

```json
{
  "actor":  { "objectType": "Agent", "mbox": "mailto:{Email}", "name": "{Email}" },
  "verb":   { "id": "http://adlnet.gov/expapi/verbs/completed", "display": { "en-US": "completed" } },
  "object": {
    "objectType": "Activity",
    "id": "https://go.nanolearning.com/activityplans/146291",
    "definition": {
      "name": { "en-US": "Information security awareness 2025 (ENG)" },
      "type": "http://adlnet.gov/expapi/activities/course"
    }
  },
  "result": {
    "completion": true,
    "duration": "PT{SecondsUsed}S",
    "extensions": {
      "https://go.nanolearning.com/xapi/extensions/activities": "{ActivityStatistics array}"
    }
  }
}
```

Field logic:

- **`verb` / `result.completion`** — treat the user as having completed the
  training when `CompletedCount == ActivityCount`. Otherwise use verb
  `http://adlnet.gov/expapi/verbs/attempted` (if they started anything) or
  `http://adlnet.gov/expapi/verbs/registered` (if they haven't started), with
  `result.completion: false`. The per-course truth is preserved in the extension
  either way, so the top-level flag is just a roll-up.
- **`result.extensions`** — drop the whole `ActivityStatistics` array in. xAPI
  extensions accept arbitrary JSON, so the per-course `HasStarted`/`HasCompleted`
  list travels with the statement, no transformation needed.
- **`duration`** — ISO-8601: `PT{SecondsUsed}S`.

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

Give every statement an explicit `id`, derived from the data instead of
random, e.g. a UUIDv5/hash of:

```
{DistributionUserId} | {ActivityPlanId} | {verb} | {LastCompletedActivity or ""}
```

In Workato formula mode this can be built with something like
`Digest::MD5.hexdigest(...)` formatted into UUID shape
(`xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`).

Why this matters: per the xAPI spec, POSTing a statement whose `id` the LRS has
already seen (with identical content) is a **no-op**. So if batch 7 of 20 fails
and the job retries from the top, batches 1–6 don't double-write. It also makes
the daily schedule naturally incremental — an unchanged user re-generates the
same id and is ignored; a user whose state changed (new `LastCompletedActivity`
or new verb) produces a new id and a new statement.

> One statement id with *different* content returns `409 Conflict` — if you see
> 409s, the id recipe above isn't including every field that can change.

### 5e. The batched write in Workato

1. In the Step 4 **Repeat**, switch the repeat mode to **"Batch of items"**
   with **batch size 50**. Each iteration now hands you a list of ≤50 users
   instead of one.
2. Inside the loop, build the statement array for the batch. Two workable
   options:
   - **Message-template / formula body:** set the HTTP request body to raw JSON
     and construct the array with a formula over the batch list (map each user
     to the Step 4 statement shape, then `.to_json`).
   - **Lists by Workato:** accumulate per-user statements into a list variable,
     then feed the list datapill into the request body.
3. HTTP "Send request" per batch:
   - Method: `POST`
   - URL: `https://transmedics.enterprise.lrs.io/junglemap/xapi/statements`
   - Headers: `Authorization` = `Basic <key:secret>` (or the connection's basic
     auth), `X-Experience-API-Version` = `1.0.3`, `Content-Type` = `application/json`
   - Body: the JSON **array** of ≤50 statements.
4. Wrap the POST in Workato's **error monitor** with **retry: 3, with delay**
   so a transient 429/5xx retries that batch only. Thanks to 5d, even a
   full-job re-run is safe.
5. Success response is a JSON array of the accepted statement ids — log
   `batch index` + `count` per iteration (small, safe to preview) rather than
   the statement bodies.

Sequential batches of 50 also act as a natural throttle — Workato runs loop
iterations one at a time, so Veracity never sees more than one in-flight
request from this recipe.

### 5f. First-run checklist

- [ ] 5b smoke test passes against the **test** store
- [ ] Recipe run against test store with the Step 3 body pointed at the real
      plan — all ~20 batches return 200
- [ ] Spot-check a handful of users in Veracity's viewer: verb roll-up right,
      `ActivityStatistics` extension intact, duration sane
- [ ] Re-run the whole job against the test store — statement count in the
      store must **not** grow (proves 5d idempotency)
- [ ] Flip connection to prod store, run once, spot-check again
- [ ] Only then enable the daily schedule

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
