// Vercel Serverless Function: shared syllabus requests with authenticated voting and owner-only deletion.
// Configure SUPABASE_URL and SUPABASE_ANON_KEY as Vercel environment variables.
// Deliberately fail closed when configuration is missing; never silently fall back to production.
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';
const VERCEL_ENV = process.env.VERCEL_ENV || 'development';
const PREVIEW_WRITES_ENABLED = process.env.NEXUS_ALLOW_PREVIEW_WRITES === 'true';
const PRODUCTION_ORIGIN = 'https://spaced-repetition-tracker-delta.vercel.app';
const MAX_BODY = 12000;
const KV_REST_API_URL = (process.env.Nexus_KV_REST_API_URL || '').replace(/\/$/, '');
const KV_REST_API_TOKEN = process.env.Nexus_KV_REST_API_TOKEN || '';
const RATE_LIMIT_SCRIPT = "local n = redis.call('INCR', KEYS[1]); if n == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]); end; return {n, redis.call('PTTL', KEYS[1])};";
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const NEXUS_ADMIN_USER_ID = (process.env.NEXUS_ADMIN_USER_ID || '').trim();
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_REPOSITORY = (process.env.GITHUB_REPOSITORY || 'kkmalithmalshan2000-png/Spaced-Repetition-Tracker').trim();
const SYNC_BATCH_SIZE = 20;
const isAdmin = user => !!(user && NEXUS_ADMIN_USER_ID && user.id === NEXUS_ADMIN_USER_ID);
const json = (res, status, payload) => {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
};
const clean = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const isUuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
function clientAddress(req) {
  const direct = req.headers['x-real-ip'];
  const forwarded = req.headers['x-forwarded-for'];
  const value = (typeof direct === 'string' && direct.trim()) ||
    (typeof forwarded === 'string' && forwarded.split(',')[0].trim()) || 'unknown';
  // Hash the address before storing it as a Redis key.
  return require('crypto').createHash('sha256').update(value).digest('hex').slice(0, 32);
}
async function consumeRateLimit(key, limit, windowMs = RATE_LIMIT_WINDOW_MS) {
  if (!KV_REST_API_URL || !KV_REST_API_TOKEN) {
    throw new Error('Rate limiter is not configured. Check the Nexus KV environment variables.');
  }
  const response = await fetch(KV_REST_API_URL, {
    method: 'POST',
    cache: 'no-store',
    headers: {
      Authorization: 'Bearer ' + KV_REST_API_TOKEN,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(['EVAL', RATE_LIMIT_SCRIPT, '1', key, String(windowMs)])
  });
  if (!response.ok) throw new Error('Rate limiter request failed (' + response.status + ').');
  const payload = await response.json();
  if (!Array.isArray(payload.result) || payload.result.length < 1) {
    throw new Error('Rate limiter returned an unexpected response.');
  }
  return Number(payload.result[0]) <= limit;
}
async function applyIpRateLimit(req, res) {
  const method = String(req.method || 'GET').toUpperCase();
  const routeLimit = method === 'GET' ? 120 : 60;
  try {
    const allowed = await consumeRateLimit(
      'nexus:syllabus-api:ip:' + clientAddress(req) + ':' + method.toLowerCase(),
      routeLimit
    );
    if (!allowed) {
      res.setHeader('Retry-After', '60');
      json(res, 429, { error: 'Too many requests. Please wait a minute and try again.' });
      return false;
    }
    return true;
  } catch (error) {
    console.error('Nexus API IP rate limit unavailable:', error && error.message);
    // Preserve public read access during a Redis outage, but fail closed for writes.
    if (method === 'GET') return true;
    json(res, 503, { error: 'Request protection is temporarily unavailable. Please try again shortly.' });
    return false;
  }
}
async function applyUserRateLimit(user, req, res, action) {
  const isSync = action === 'sync-github';
  const limit = isSync ? 3 : 20;
  try {
    const allowed = await consumeRateLimit(
      'nexus:syllabus-api:user:' + user.id + ':' + (isSync ? 'github-sync' : 'write'),
      limit
    );
    if (!allowed) {
      res.setHeader('Retry-After', '60');
      json(res, 429, { error: isSync
        ? 'GitHub synchronisation is limited to 3 attempts per minute. Please wait and try again.'
        : 'Too many changes in a short period. Please wait a minute and try again.' });
      return false;
    }
    return true;
  } catch (error) {
    console.error('Nexus API user rate limit unavailable:', error && error.message);
    json(res, 503, { error: 'Request protection is temporarily unavailable. Please try again shortly.' });
    return false;
  }
}
async function currentUser(token) {
  if (!token) return null;
  const response = await fetch(SUPABASE_URL + '/auth/v1/user', {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + token }
  });
  if (!response.ok) return null;
  const user = await response.json();
  return user && user.id ? user : null;
}
async function db(path, token, options = {}) {
  return fetch(SUPABASE_URL + '/rest/v1/' + path, {
    method: options.method || 'GET',
    cache: 'no-store',
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: 'Bearer ' + token,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Prefer: options.prefer || 'return=representation'
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
}
async function serviceDb(path, options = {}) {
  if (!SUPABASE_SERVICE_ROLE_KEY) throw new Error('Server-side community database access is not configured.');
  return fetch(SUPABASE_URL + '/rest/v1/' + path, {
    method: options.method || 'GET',
    cache: 'no-store',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Prefer: options.prefer || 'return=representation'
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
}
async function fetchVoteCounts() {
  const response = await fetch(SUPABASE_URL + '/rest/v1/rpc/get_nexus_syllabus_vote_counts', {
    method: 'POST', cache: 'no-store',
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: '{}'
  });
  if (!response.ok) return null;
  const rows = await response.json();
  if (!Array.isArray(rows)) return null;
  return new Map(rows.map(row => [row.request_id, Number(row.vote_count)]));
}
async function fetchMyVotes(token) {
  const response = await fetch(SUPABASE_URL + '/rest/v1/rpc/get_my_nexus_syllabus_votes', {
    method: 'POST', cache: 'no-store',
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: 'Bearer ' + token,
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: '{}'
  });
  if (!response.ok) return null;
  const rows = await response.json();
  if (!Array.isArray(rows)) return null;
  return new Set(rows.map(row => row.request_id));
}
async function setVote(requestId, token, upvote) {
  const response = await fetch(SUPABASE_URL + '/rest/v1/rpc/set_nexus_syllabus_vote', {
    method: 'POST', cache: 'no-store',
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: 'Bearer ' + token,
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ p_request_id: requestId, p_upvote: upvote })
  });
  if (!response.ok) return null;
  const rows = await response.json();
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

const githubHeaders = () => ({
  Accept: 'application/vnd.github+json',
  Authorization: 'Bearer ' + GITHUB_TOKEN,
  'X-GitHub-Api-Version': '2022-11-28',
  'Content-Type': 'application/json'
});
async function github(path, options = {}) {
  if (!GITHUB_TOKEN) throw new Error('GitHub request tracking is not configured. Add GITHUB_TOKEN in Vercel environment variables.');
  const response = await fetch('https://api.github.com/repos/' + GITHUB_REPOSITORY + path, {
    method: options.method || 'GET', cache: 'no-store', headers: githubHeaders(),
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const payload = response.status === 204 ? null : await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload && payload.message ? payload.message : 'GitHub request failed (' + response.status + ').');
  return payload;
}
const requestMarker = id => 'Nexus Request ID: ' + id;
function issueBody(request) {
  return [
    'A curriculum request submitted through Nexus: Spaced Repetition Tracker.',
    '',
    '**Requested curriculum:** ' + clean(request.name, 120),
    '**Category / exam board:** ' + clean(request.category, 100),
    '',
    '**Topics / chapters requested:**',
    clean(request.topics, 3000) || 'No topic outline provided.',
    '',
    '---',
    requestMarker(request.id),
    'Submitted from the Nexus community request form.'
  ].join('\n');
}
async function listGithubIssues() {
  const all = [];
  for (let page = 1; page <= 10; page++) {
    const batch = await github('/issues?state=all&per_page=100&page=' + page);
    const issues = Array.isArray(batch) ? batch.filter(x => !x.pull_request) : [];
    all.push(...issues);
    if (!Array.isArray(batch) || batch.length < 100) break;
  }
  return all;
}
async function createGithubIssue(request) {
  return github('/issues', { method: 'POST', body: {
    title: '[Nexus Curriculum Request] ' + clean(request.name, 120),
    body: issueBody(request)
  }});
}
function findGithubIssue(issues, id) {
  const marker = requestMarker(id);
  return issues.find(issue => String(issue.body || '').includes(marker)) || null;
}
async function closeGithubIssueForRequest(id, reason) {
  if (!GITHUB_TOKEN) return { closed: false, configured: false };
  try {
    const issue = findGithubIssue(await listGithubIssues(), id);
    if (!issue || issue.state === 'closed') return { closed: !!issue, configured: true };
    await github('/issues/' + issue.number, { method: 'PATCH', body: { state: 'closed', state_reason: reason || 'completed' } });
    return { closed: true, configured: true };
  } catch (error) {
    console.error('Could not close mirrored Nexus issue:', error && error.message);
    return { closed: false, configured: true };
  }
}
async function syncGithubBatch(requests) {
  if (!GITHUB_TOKEN) throw new Error('GitHub request tracking is not configured. Add GITHUB_TOKEN in Vercel environment variables.');
  const issues = await listGithubIssues();
  const missing = requests.filter(request => !findGithubIssue(issues, request.id));
  const batch = missing.slice(0, SYNC_BATCH_SIZE);
  let synced = 0;
  for (const request of batch) { await createGithubIssue(request); synced++; }
  return { synced, total: requests.length, remaining: Math.max(0, missing.length - synced) };
}
async function adminDeleteRequest(id) {
  if (!SUPABASE_SERVICE_ROLE_KEY) throw new Error('Admin deletion is not configured yet. Add SUPABASE_SERVICE_ROLE_KEY in Vercel environment variables.');
  return fetch(SUPABASE_URL + '/rest/v1/nexus_syllabus_requests?id=eq.' + encodeURIComponent(id), {
    method: 'DELETE', cache: 'no-store',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY,
      Accept: 'application/json',
      Prefer: 'return=representation'
    }
  });
}

module.exports = async function handler(req, res) {
  const origin = String(req.headers.origin || '');
  const previewOrigin = process.env.VERCEL_URL ? 'https://' + process.env.VERCEL_URL : '';
  const allowedOrigins = new Set([PRODUCTION_ORIGIN, previewOrigin].filter(Boolean));
  if (allowedOrigins.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Authorization');
  res.setHeader('Access-Control-Max-Age', '600');
  if (req.method === 'OPTIONS') {
    if (origin && !allowedOrigins.has(origin)) return json(res, 403, { error: 'Origin not allowed.' });
    res.statusCode = 204; return res.end();
  }
  if (req.method !== 'OPTIONS') {
    const rateLimitPassed = await applyIpRateLimit(req, res);
    if (!rateLimitPassed) return;
  }
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return json(res, 503, { error: 'Community API is not configured for this deployment.' });
  }
  if (VERCEL_ENV === 'preview' && req.method !== 'GET' && !PREVIEW_WRITES_ENABLED) {
    return json(res, 403, { error: 'Community writes are disabled in preview deployments.' });
  }
  const auth = String(req.headers.authorization || '');
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  try {
    if (req.method === 'GET') {
      const user = await currentUser(token);
      const requestsResponse = await fetch(SUPABASE_URL + '/rest/v1/rpc/get_nexus_syllabus_requests', {
        method: 'POST', cache: 'no-store',
        headers: {
          apikey: SUPABASE_ANON_KEY,
          ...(token ? { Authorization: 'Bearer ' + token } : {}),
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache, no-store, max-age=0'
        },
        body: '{}'
      });
      if (!requestsResponse.ok) return json(res, 503, { error: 'Community wishlist storage is not configured or is temporarily unavailable. Check the Supabase setup guide.' });
      const requests = await requestsResponse.json();
      const voteCounts = await fetchVoteCounts();
      if (!voteCounts) return json(res, 503, { error: 'Could not load community vote totals. Please try again shortly.' });
      let myVotes = new Set();
      if (user) {
        myVotes = await fetchMyVotes(token);
        if (!myVotes) return json(res, 503, { error: 'Could not load your upvote status. Please try again shortly.' });
      }
      return json(res, 200, { requests: requests.map(x => ({
        id: x.id, name: x.name, category: x.category, topics: x.topics || '',
        createdAt: x.created_at, votes: voteCounts.get(x.id) || 0,
        isOwner: x.is_owner === true, hasUpvoted: myVotes.has(x.id), status: 'community'
      })), signedIn: !!user, isAdmin: isAdmin(user) });
    }
    if (req.method !== 'POST' && req.method !== 'DELETE') {
      res.setHeader('Allow', 'GET, POST, DELETE, OPTIONS');
      return json(res, 405, { error: 'Method not allowed.' });
    }
    const user = await currentUser(token);
    if (!user) return json(res, 401, { error: 'Sign in to Nexus to submit, upvote, or delete community requests.' });
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > MAX_BODY) return json(res, 413, { error: 'Request is too large.' });
    }
    let input;
    try { input = JSON.parse(raw || '{}'); } catch (_) { return json(res, 400, { error: 'Invalid request body.' }); }
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return json(res, 400, { error: 'Request body must be a JSON object.' });
    }
    const requestedAction = req.method === 'POST' ? clean(input.action, 30) : '';
    if (!(await applyUserRateLimit(user, req, res, requestedAction))) return;
    if (req.method === 'POST' && requestedAction === 'sync-github') {
      if (!isAdmin(user)) return json(res, 403, { error: 'Only the Nexus administrator can synchronise requests to GitHub.' });
      const response = await serviceDb('nexus_syllabus_requests?select=id,name,category,topics,created_at&order=created_at.desc&limit=200');
      if (!response.ok) return json(res, 502, { error: 'Could not read the community request list for synchronisation.' });
      const result = await syncGithubBatch(await response.json());
      return json(res, 200, { ...result, issuesUrl: 'https://github.com/' + GITHUB_REPOSITORY + '/issues?q=is%3Aissue+is%3Aopen+%5BNexus+Curriculum+Request%5D' });
    }
    if (req.method === 'DELETE') {
      const id = clean(String(input.id || ''), 80);
      if (!isUuid(id)) return json(res, 400, { error: 'A valid request ID is required.' });
      const admin = isAdmin(user);
      let deleted;
      if (admin) {
        deleted = await adminDeleteRequest(id);
        if (!deleted.ok) return json(res, 502, { error: 'Could not delete this request. Please check the server configuration and try again.' });
        const rows = await deleted.json();
        if (!rows.length) return json(res, 404, { error: 'This request no longer exists.' });
      } else {
        deleted = await fetch(SUPABASE_URL + '/rest/v1/rpc/delete_my_nexus_syllabus_request', {
          method: 'POST', cache: 'no-store',
          headers: {
            apikey: SUPABASE_ANON_KEY,
            Authorization: 'Bearer ' + token,
            Accept: 'application/json',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ p_request_id: id })
        });
        if (!deleted.ok) return json(res, 502, { error: 'Could not delete this request. Please try again.' });
        const result = await deleted.json();
        if (!Array.isArray(result) || !result[0] || result[0].deleted !== true) {
          return json(res, 403, { error: 'You can delete only requests you created.' });
        }
      }
      const githubResult = await closeGithubIssueForRequest(id, admin ? 'completed' : 'not_planned');
      return json(res, 200, { deleted: true, id, isAdmin: admin, githubIssueClosed: githubResult.closed, githubConfigured: githubResult.configured });
    }
    const action = clean(input.action, 30);
    if (action === 'upvote' || action === 'remove-upvote') {
      const id = clean(String(input.id || ''), 80);
      if (!isUuid(id)) return json(res, 400, { error: 'A valid request ID is required.' });
      const result = await setVote(id, token, action === 'upvote');
      if (!result) return json(res, 502, { error: action === 'upvote' ? 'Could not save your upvote. Please try again.' : 'Could not remove your upvote. Please try again.' });
      return json(res, 200, {
        upvoted: action === 'upvote', id,
        votes: Number(result.vote_count || 0),
        changed: result.changed === true
      });
    }
    const name = clean(input.name, 120), category = clean(input.category, 100), topics = clean(input.topics, 3000);
    if (!name || !category) return json(res, 400, { error: 'Subject/course name and category are required.' });

    // Enforce one active request per authenticated user. The unique database index
    // in supabase/migrations/20261014_one_active_syllabus_request_per_user.sql
    // closes the race between simultaneous submissions; this check provides a clear message.
    const activeRequest = await fetch(SUPABASE_URL + '/rest/v1/rpc/has_my_active_nexus_syllabus_request', {
      method: 'POST', cache: 'no-store',
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + token, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: '{}'
    });
    if (!activeRequest.ok) return json(res, 503, { error: 'Could not verify your existing requests. Please try again shortly.' });
    const hasActiveRequest = await activeRequest.json();
    if (hasActiveRequest === true) {
      return json(res, 409, {
        code: 'ACTIVE_REQUEST_EXISTS',
        error: 'You already have an active syllabus request. Delete your current request, or ask the admin to remove it, before submitting another.'
      });
    }

    const inserted = await fetch(SUPABASE_URL + '/rest/v1/rpc/create_nexus_syllabus_request', {
      method: 'POST', cache: 'no-store',
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + token, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_name: name, p_category: category, p_topics: topics })
    });
    if (!inserted.ok) {
      const insertError = await inserted.json().catch(() => ({}));
      const errorText = [insertError.message, insertError.details, insertError.hint].filter(Boolean).join(' ');
      const looksLikeOwnerConflict = /nexus_syllabus_requests_one_active_per_owner|duplicate key|unique constraint/i.test(errorText);
      if (inserted.status === 409 || insertError.code === '23505' || looksLikeOwnerConflict) {
        return json(res, 409, {
          code: 'ACTIVE_REQUEST_EXISTS',
          error: 'You already have an active syllabus request. Each account can have only one at a time. Delete your current request, or ask the admin to remove it, before submitting another.'
        });
      }
      // Some PostgREST/database configurations return a generic error body for a
      // unique-index rejection. Verify whether the account already owns a request
      // before showing the unrelated schema/policy troubleshooting message.
      const existingAfterFailure = await db('nexus_syllabus_requests?select=id&owner_id=eq.' + encodeURIComponent(user.id) + '&limit=1', token);
      if (existingAfterFailure.ok) {
        const existingRows = await existingAfterFailure.json();
        if (Array.isArray(existingRows) && existingRows.length) {
          return json(res, 409, {
            code: 'ACTIVE_REQUEST_EXISTS',
            error: 'You already have an active syllabus request. Each account can have only one at a time. Delete your current request, or ask the admin to remove it, before submitting another.'
          });
        }
      }
      return json(res, 502, { error: 'Could not save the request. Ensure the Supabase syllabus tables and policies are installed.' });
    }
    const rows = await inserted.json();
    const row = rows[0];
    let githubSynced = false, githubIssueUrl = '';
    try {
      const issue = await createGithubIssue(row);
      githubSynced = true;
      githubIssueUrl = issue && issue.html_url || '';
    } catch (error) {
      console.error('Nexus request saved but GitHub mirror failed:', error && error.message);
    }
    return json(res, 201, { request: { id: row.id, name: row.name, category: row.category, topics: row.topics || '', createdAt: row.created_at, votes: 0, isOwner: true, hasUpvoted: false, status: 'community' }, githubSynced, githubIssueUrl });
  } catch (error) {
    console.error('Syllabus request API failed:', error && error.message);
    return json(res, 500, { error: 'Unable to process this request right now.' });
  }
};
