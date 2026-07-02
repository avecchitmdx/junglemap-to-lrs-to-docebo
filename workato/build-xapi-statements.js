// JavaScript by Workato action — builds xAPI statements for a batch of
// GetStatistics users, ready to POST to Veracity as a single array.
//
// Model: per released module, a statement for each lifecycle event that has
// happened — "assigned" (module released to the user, at
// DistributionActivityStarted), "attempted" (user started it), "completed"
// (user finished it) — plus one course-level "completed" statement when
// JungleMap says the whole course is done. Module statements point at their
// course via context.contextActivities.parent, so per-course rollups work,
// and assigned-without-completed is the queryable "overdue" signal.
//
// Statement ids are deterministic (hash of the fields that define the event),
// so a statement for an event the LRS has already stored is a no-op on
// re-POST. The daily schedule therefore only ever adds *new* events.
//
// Input schema (define on the action):
//   users    : list   (map the batch datapill from the "Batch of items" repeat)
//   planId   : string (e.g. "146291", from the GetActivityPlans loop)
//   planName : string (e.g. "Information security awareness 2025 (ENG)")
// Output schema:
//   body  : string  (JSON array of statements — map into the HTTP request body)
//   count : integer (statements in this batch — cheap to log per iteration)

exports.main = ({ users, planId, planName }) => {
  const fnv1a = (str, seed) => {
    let h = seed >>> 0;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h >>> 0;
  };
  const hex8 = (n) => n.toString(16).padStart(8, '0');
  const uuidFrom = (s) => {
    const a = hex8(fnv1a(s, 0x811c9dc5));
    const b = hex8(fnv1a('salt1|' + s, 0x811c9dc5));
    const c = hex8(fnv1a(s + '|salt2', 0x01000193));
    const d = hex8(fnv1a('salt3|' + s + '|salt3', 0x01000193));
    const variant = ((parseInt(c[3], 16) & 0x3) | 0x8).toString(16);
    return (
      a + '-' + b.slice(0, 4) + '-4' + b.slice(4, 7) + '-' +
      variant + c.slice(0, 3) + '-' + c.slice(4, 8) + d.slice(0, 8)
    );
  };

  // JungleMap returns .NET DateTime.MinValue, not null, for "never".
  const isSentinel = (t) => !t || String(t).startsWith('0001');
  // JungleMap timestamps carry no zone; assumed UTC (open question in the
  // build guide). xAPI requires a zone, so append Z.
  const toUtc = (t) => String(t) + 'Z';

  const VERBS = {
    completed: { id: 'http://adlnet.gov/expapi/verbs/completed', display: { 'en-US': 'completed' } },
    attempted: { id: 'http://adlnet.gov/expapi/verbs/attempted', display: { 'en-US': 'attempted' } },
    assigned:  { id: 'https://w3id.org/xapi/dod-isd/verbs/assigned', display: { 'en-US': 'assigned' } },
  };

  const courseIri = 'https://go.nanolearning.com/activityplans/' + planId;
  const courseContext = {
    contextActivities: {
      parent: [{ objectType: 'Activity', id: courseIri }],
    },
  };

  const statements = [];

  for (const u of users) {
    const actor = u.Email
      ? { objectType: 'Agent', mbox: 'mailto:' + u.Email, name: u.Email }
      : {
          objectType: 'Agent',
          account: { homePage: 'https://go.nanolearning.com', name: String(u.DistributionUserId) },
          name: 'JungleMap user ' + u.DistributionUserId,
        };

    // One statement per lifecycle event per released module.
    for (const act of u.ActivityStatistics || []) {
      const events = [];
      if (!isSentinel(act.DistributionActivityStarted)) {
        events.push({ verb: VERBS.assigned, when: act.DistributionActivityStarted });
      }
      if (act.HasStarted && !isSentinel(act.Started)) {
        events.push({ verb: VERBS.attempted, when: act.Started });
      }
      if (act.HasCompleted && !isSentinel(act.Completed)) {
        events.push({ verb: VERBS.completed, when: act.Completed });
      }

      for (const { verb, when } of events) {
        const stmt = {
          id: uuidFrom([u.DistributionUserId, act.ActivityId, verb.id, when].join('|')),
          actor,
          verb,
          timestamp: toUtc(when),
          object: {
            objectType: 'Activity',
            id: 'https://go.nanolearning.com/activities/' + act.ActivityId,
            definition: {
              name: { 'en-US': act.Title },
              type: 'http://adlnet.gov/expapi/activities/module',
            },
          },
          context: courseContext,
        };
        if (verb === VERBS.completed) stmt.result = { completion: true };
        statements.push(stmt);
      }
    }

    // Course-level completion, only when JungleMap says the whole course is
    // done. If a later module release flips the user back to Pending and they
    // finish again, LastCompletedActivity moves -> new id -> a second course
    // completion is recorded, which is the true history.
    if (u.CourseCompletionStatus === 'Completed') {
      const when = isSentinel(u.LastCompletedActivity) ? '' : u.LastCompletedActivity;
      const stmt = {
        id: uuidFrom([u.DistributionUserId, planId, 'course-completed', when].join('|')),
        actor,
        verb: VERBS.completed,
        object: {
          objectType: 'Activity',
          id: courseIri,
          definition: {
            name: { 'en-US': planName },
            type: 'http://adlnet.gov/expapi/activities/course',
          },
        },
        result: { completion: true },
      };
      if (when) stmt.timestamp = toUtc(when);
      statements.push(stmt);
    }
  }

  return { body: JSON.stringify(statements), count: statements.length };
};
