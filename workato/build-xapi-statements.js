// JavaScript by Workato action — builds one xAPI statement per user for a
// batch of GetStatistics users, ready to POST to Veracity as a single array.
//
// Input schema (define on the action):
//   users    : list   (map the batch datapill from the "Batch of items" repeat)
//   planId   : string (e.g. "146291", from the GetActivityPlans loop)
//   planName : string (e.g. "Information security awareness 2025 (ENG)")
// Output schema:
//   body  : string  (JSON array of statements — map into the HTTP request body)
//   count : integer (statements in this batch — cheap to log per iteration)

exports.main = ({ users, planId, planName }) => {
  // FNV-1a over the id key, four passes with different salts, formatted as an
  // RFC-4122-shaped UUID. Deterministic: same user-state => same statement id,
  // which is what makes re-runs and retries no-ops in the LRS.
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
    const b = hex8(fnv1a('' + s, 0x811c9dc5));
    const c = hex8(fnv1a(s + '', 0x01000193));
    const d = hex8(fnv1a('' + s + '', 0x01000193));
    const variant = ((parseInt(c[3], 16) & 0x3) | 0x8).toString(16);
    return (
      a + '-' + b.slice(0, 4) + '-4' + b.slice(4, 7) + '-' +
      variant + c.slice(0, 3) + '-' + c.slice(4, 8) + d.slice(0, 8)
    );
  };

  // JungleMap returns .NET DateTime.MinValue, not null, for "never".
  const isSentinel = (t) => !t || String(t).startsWith('0001');

  const VERBS = {
    completed:  { id: 'http://adlnet.gov/expapi/verbs/completed',  display: { 'en-US': 'completed' } },
    attempted:  { id: 'http://adlnet.gov/expapi/verbs/attempted',  display: { 'en-US': 'attempted' } },
    registered: { id: 'http://adlnet.gov/expapi/verbs/registered', display: { 'en-US': 'registered' } },
  };

  const statements = users.map((u) => {
    const completed = u.CourseCompletionStatus === 'Completed';
    const verb = completed ? VERBS.completed
      : (u.StartedCount > 0 ? VERBS.attempted : VERBS.registered);

    // StartedActivities (count of *released* modules) must be in the key: a
    // monthly release changes every user's ActivityStatistics extension, so
    // the statement content changes and the id has to change with it.
    const idKey = [
      u.DistributionUserId, planId, verb.id,
      u.StartedActivities, u.StartedCount, u.CompletedCount,
      isSentinel(u.LastCompletedActivity) ? '' : u.LastCompletedActivity,
    ].join('|');

    const actor = u.Email
      ? { objectType: 'Agent', mbox: 'mailto:' + u.Email, name: u.Email }
      : {
          objectType: 'Agent',
          account: { homePage: 'https://go.nanolearning.com', name: String(u.DistributionUserId) },
          name: 'JungleMap user ' + u.DistributionUserId,
        };

    return {
      id: uuidFrom(idKey),
      actor,
      verb,
      object: {
        objectType: 'Activity',
        id: 'https://go.nanolearning.com/activityplans/' + planId,
        definition: {
          name: { 'en-US': planName },
          type: 'http://adlnet.gov/expapi/activities/course',
        },
      },
      result: {
        completion: completed,
        extensions: {
          'https://go.nanolearning.com/xapi/extensions/activities': u.ActivityStatistics || [],
        },
      },
    };
  });

  return { body: JSON.stringify(statements), count: statements.length };
};
