import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { D1 } from './helpers/d1.js';
import { miniappAPI } from '../src/miniapp.js';
import { epoch } from '../src/dota-data.js';
import { clientPublicData } from '../public/app/public-data.js';
import { summarizeMatch, summarizePlayer } from '../public/app/dota-core.js';
const catalogue = JSON.parse(readFileSync(new URL('../public/item-data.json', import.meta.url)));
const env = () => ({ DB: new D1(), ASSETS: { fetch: async () => Response.json(catalogue) } });
const req = path => new Request('https://example.com' + path);
const heroes = { 14: { id: 14, name: 'Pudge', image: null } };

test('upstream 429 enables public browser fallback, keeps cooldown, and build context needs no upstream', async t => {
  const bindings = env(); let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response('Rate limit', { status: 429 }); });
  const first = await miniappAPI(req('/api/build?hero=2'), bindings);
  assert.equal(first.status, 429); assert.equal((await first.json()).clientFallback, true);
  assert.equal((await miniappAPI(req('/api/analysis/match?id=9000000001'), bindings)).status, 429); assert.equal(calls, 1);
  const context = await miniappAPI(req('/api/build-context?hero=2&enemies=44&position=3'), bindings);
  assert.equal(context.status, 200); const body = await context.json(); assert.equal(body.hero.name, 'Axe'); assert.ok(body.items.length > 200); assert.ok(body.situational.length);
  assert.equal(calls, 1);
});

test('own application quota is not marked as an upstream browser-fallback case', async t => {
  const bindings = env(); t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected network'); });
  bindings.DB.db.prepare('INSERT INTO meta VALUES(?,?)').run(`opendota_budget:60:${Math.floor(epoch() / 60)}`, '45');
  const response = await miniappAPI(req('/api/build?hero=3'), bindings);
  assert.equal(response.status, 429); assert.equal((await response.json()).clientFallback, undefined);
});

test('browser match normalization equals Worker normalization and never forwards Telegram data', async t => {
  const raw = { match_id: 9000000002, radiant_win: true, duration: 2000, players: [{ hero_id: 14, account_id: 123, player_slot: 0, kills: 3, deaths: 4, assists: 8 }] };
  let sourceCalls = 0;
  t.mock.method(globalThis, 'fetch', async (path, options) => {
    assert.equal(options.credentials, 'omit'); assert.equal(options.headers, undefined);
    if (path === '/api/heroes') return Response.json({ heroes: Object.values(heroes) });
    assert.equal(path, 'https://api.opendota.com/api/matches/9000000002'); sourceCalls++; return Response.json(raw);
  });
  const data = await clientPublicData('/api/analysis/match?id=9000000002', { headers: { 'X-Telegram-Init-Data': 'must-not-leak' } });
  const { fetchedAt, stale, ...normalized } = data;
  assert.equal(stale, false); assert.ok(fetchedAt > 0); assert.deepEqual(normalized, summarizeMatch(raw, heroes));
  await clientPublicData('/api/analysis/match?id=9000000002'); assert.equal(sourceCalls, 1);
});

test('browser player normalization preserves missing history and role-aware heuristic exactly', async t => {
  const profile = { profile: { personaname: 'Player' } }, wl = { win: 30, lose: 5 };
  const matches = Array.from({ length: 30 }, (_, i) => ({ match_id: 9000000100 + i, hero_id: 14, radiant_win: i < 25, player_slot: 128, lobby_type: 7, game_mode: 22, duration: 2000, kills: 3, deaths: 4, assists: 5 }));
  t.mock.method(globalThis, 'fetch', async path => {
    if (path === '/api/heroes') return Response.json({ heroes: Object.values(heroes) });
    if (path.endsWith('/wl')) return Response.json(wl);
    if (path.includes('/matches?')) return Response.json(matches);
    assert.equal(path, 'https://api.opendota.com/api/players/555111'); return Response.json(profile);
  });
  const { fetchedAt, stale, ...data } = await clientPublicData('/api/analysis/player?id=555111');
  assert.deepEqual(data, summarizePlayer(555111, profile, matches, wl, heroes));
});

test('browser builds preserve server draft context and respect a visitor-side 429 without retrying', async t => {
  const bindings = env(); let sourceCalls = 0;
  t.mock.method(globalThis, 'fetch', async (path, options) => {
    assert.equal(options.credentials, 'omit');
    if (path.startsWith('/api/build-context')) return miniappAPI(req(path), bindings);
    assert.equal(path, 'https://api.opendota.com/api/heroes/4/itemPopularity'); sourceCalls++;
    return Response.json({ start_game_items: { 44: 3 }, early_game_items: {}, mid_game_items: { 116: 10 }, late_game_items: {} });
  });
  const data = await clientPublicData('/api/build?hero=4&enemies=44&position=1');
  assert.equal(data.hero.name, 'Bloodseeker'); assert.equal(data.stages[2].items[0].key, 'black_king_bar'); assert.ok(data.situational.length); assert.equal(sourceCalls, 1);
  sourceCalls = 0;
  t.mock.method(globalThis, 'fetch', async path => {
    if (path === '/api/heroes') return Response.json({ heroes: [] });
    sourceCalls++; return new Response('Limited', { status: 429 });
  });
  await assert.rejects(clientPublicData('/api/analysis/match?id=9000000003'), /ограничил/); assert.equal(sourceCalls, 1);
});

test('browser public fallback rejects private routes and invalid IDs without network calls', async t => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected network'); });
  await assert.rejects(clientPublicData('/api/steam/status'), /Неподдерживаемый/);
  await assert.rejects(clientPublicData('/api/analysis/player?id=https://evil.example'), /Проверьте ID/);
  await assert.rejects(clientPublicData('/api/analysis/match?id=oops'), /Проверьте ID/);
});
