import test from 'node:test';
import assert from 'node:assert/strict';
import { requestReplayParse, watchReplayParse } from '../public/app/replay-parse.js';
import { clientPublicData } from '../public/app/public-data.js';
import { summarizeMatch, analyzeMatch } from '../src/analysis.js';
import { epoch } from '../src/dota-data.js';
import { D1 } from './helpers/d1.js';

const matchId = '9077595260';
const rawMatch = (parsed = false) => ({ match_id: Number(matchId), version: parsed ? 22 : null, players: [{ hero_id: 14, player_slot: 0, xp_per_min: 500 }] });
const immediate = async () => {};

test('parse submission is a single validated POST without credentials or Telegram data', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls++;
    assert.equal(url, `https://api.opendota.com/api/request/${matchId}`);
    assert.equal(options.method, 'POST'); assert.equal(options.credentials, 'omit');
    assert.equal(options.headers, undefined); assert.equal(options.body, undefined);
    return Response.json({ job: { jobId: 12345 } });
  });
  for (const id of ['0', 'nope', 'https://evil.test', '1/../../steam', '1000000000000']) await assert.rejects(requestReplayParse(id), /ID матча/);
  assert.equal(calls, 0);
  assert.equal(await requestReplayParse(matchId, { headers: { 'X-Telegram-Init-Data': 'never-forward' } }), '12345');
  assert.equal(calls, 1);
});

test('rate limits, network errors and malformed queue responses never retry the POST', async t => {
  for (const reply of [() => new Response('', { status: 429 }), () => { throw new TypeError('Network'); }, () => Response.json({ job: {} })]) {
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => { calls++; return reply(); });
    await assert.rejects(requestReplayParse(matchId)); assert.equal(calls, 1);
  }
});

test('queue completion refreshes match data and tolerates publication delay without a second POST', async t => {
  let polls = 0, refreshes = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://api.opendota.com/api/request/12345'); assert.equal(options.method, 'GET');
    return Response.json(++polls === 1 ? { jobId: '12345' } : null);
  });
  const result = await watchReplayParse(matchId, '12345', { pause: immediate, loadMatch: async (path, options) => {
    assert.equal(path, `/api/analysis/match?id=${matchId}`); assert.equal(options.refresh, true);
    return { parsed: ++refreshes === 2 };
  } });
  assert.equal(result.state, 'complete'); assert.equal(polls, 3); assert.equal(refreshes, 2);
});

test('a vanished job without parsed fields is reported as unavailable, never as success', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json(null));
  let refreshes = 0;
  const result = await watchReplayParse(matchId, '12345', { pause: immediate, loadMatch: async () => { refreshes++; return { parsed: false }; } });
  assert.equal(result.state, 'unavailable'); assert.equal(refreshes, 3);
});

test('long-running jobs stop polling after a bounded wait and retain the existing job', async t => {
  let polls = 0, waits = 0;
  t.mock.method(globalThis, 'fetch', async () => { polls++; return Response.json({ jobId: '12345' }); });
  const result = await watchReplayParse(matchId, '12345', { pause: async ms => { assert.equal(ms, 10000); waits++; }, loadMatch: () => { throw new Error('Still queued'); } });
  assert.equal(result.state, 'pending'); assert.equal(polls, 18); assert.equal(waits, 17);
});

test('switching matches cancels polling and pre-aborted requests never reach OpenDota', async t => {
  const controller = new AbortController(); let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json({ jobId: '12345' }); });
  await assert.rejects(watchReplayParse(matchId, '12345', { signal: controller.signal, pause: async () => { controller.abort(); controller.signal.throwIfAborted(); } }), { name: 'AbortError' });
  assert.equal(calls, 1);
  await assert.rejects(requestReplayParse(matchId, { signal: controller.signal }), { name: 'AbortError' }); assert.equal(calls, 1);
});

test('unknown job responses and upstream limits stop polling without claiming completion', async t => {
  for (const response of [Response.json({ jobId: '999' }), Response.json({ error: 'failed' }), new Response('', { status: 429 }), new Response('', { status: 404 })]) {
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => { calls++; return response; });
    await assert.rejects(watchReplayParse(matchId, '12345', { pause: immediate })); assert.equal(calls, 1);
  }
});

test('refresh after parsing bypasses browser cache and replaces the cached unparsed result', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (path, options) => {
    if (path === '/api/heroes') return Response.json({ heroes: [] });
    assert.equal(options.credentials, 'omit'); calls++;
    if (calls === 2) assert.equal(options.cache, 'no-store');
    return Response.json(rawMatch(calls >= 2));
  });
  const path = `/api/analysis/match?id=${matchId}`;
  assert.equal((await clientPublicData(path)).parsed, false);
  assert.equal((await clientPublicData(path)).parsed, false); assert.equal(calls, 1);
  assert.equal((await clientPublicData(path, { refresh: true })).parsed, true);
  assert.equal((await clientPublicData(path)).parsed, true); assert.equal(calls, 2);
});

test('Worker unparsed cache expires after 30 seconds while parsed results retain the normal cache', async t => {
  const DB = new D1(); let calls = 0;
  const key = `match_analysis:v2:${matchId}`;
  DB.db.prepare('INSERT INTO meta VALUES(?,?)').run(key, JSON.stringify({ value: summarizeMatch(rawMatch()), fetchedAt: epoch() - 31 }));
  t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json(rawMatch(true)); });
  assert.equal((await analyzeMatch(DB, matchId)).parsed, true); assert.equal(calls, 1);
  DB.db.prepare('UPDATE meta SET value=? WHERE key=?').run(JSON.stringify({ value: summarizeMatch(rawMatch(true)), fetchedAt: epoch() - 31 }), key);
  assert.equal((await analyzeMatch(DB, matchId)).parsed, true); assert.equal(calls, 1);
});

test('replay farming metrics preserve real zeros and missing values independently', () => {
  const raw = rawMatch(true);
  raw.players[0] = { ...raw.players[0], gold_t: Array(11).fill(0), lh_t: Array(11).fill(35), lane_efficiency_pct: 57 };
  const player = summarizeMatch(raw).players[0];
  assert.equal(player.goldAt10, 0); assert.equal(player.lastHitsAt10, 35); assert.equal(player.laneEfficiency, 57);
  const missing = summarizeMatch(rawMatch()).players[0];
  assert.equal(missing.goldAt10, null); assert.equal(missing.lastHitsAt10, null); assert.equal(missing.laneEfficiency, null);
});
