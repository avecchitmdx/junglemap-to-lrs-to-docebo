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

## Step 5 — Write to Veracity (batched)

Collect the per-user statements into a list and POST the **array** to the LRS in
batches (e.g. 50–100 per call), rather than one call per user.

- Method: `POST`
- URL: `<VERACITY_STORE>/statements`  *(fill in the actual store xAPI endpoint)*
- Headers:
  - `Authorization` = `Basic <base64(key:secret)>`  *(Veracity per-store key/secret)*
  - `X-Experience-API-Version` = `1.0.3`  *(required by xAPI — easy to forget)*
  - `Content-Type` = `application/json`
- Body: the JSON array of statements.

**TODO (need from the LRS owner):** the Veracity store's xAPI endpoint URL and
its Basic auth key/secret.

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
