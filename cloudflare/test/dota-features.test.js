import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { D1 } from './helpers/d1.js';
import { miniappAPI } from '../src/miniapp.js';
import { startSteam, finishSteam, steamAccount, unlinkSteam } from '../src/steam.js';
import { accountID, cachedData, openDota, epoch } from '../src/dota-data.js';
import { assessSmurf, summarizeMatch, analyzePlayer, analyzeMatch } from '../src/analysis.js';
import { counterItems, heroBuild } from '../src/builds.js';
const token = 'test-token';
function auth(id = 100) {
  const params = new URLSearchParams({ auth_date: String(epoch()), user: JSON.stringify({ id, first_name: 'Игрок' }) });
  const key = createHmac('sha256', 'WebAppData').update(token).digest();
  params.set('hash', createHmac('sha256', key).update([...params].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n')).digest('hex'));
  return { 'X-Telegram-Init-Data': params.toString() };
}
const req = (path, options = {}) => new Request(`https://example.com/api/${path}`, options);
const catalogue = JSON.parse(readFileSync(new URL('../public/item-data.json', import.meta.url)));
const assets = { fetch: async () => Response.json(catalogue) };
function callback(start) {
  const login = new URL(start.url), url = new URL(login.searchParams.get('openid.return_to'));
  for (const [key, value] of Object.entries({ ns: 'http://specs.openid.net/auth/2.0', mode: 'id_res', op_endpoint: 'https://steamcommunity.com/openid/login', claimed_id: 'https://steamcommunity.com/openid/id/76561198030654385', identity: 'https://steamcommunity.com/openid/id/76561198030654385', return_to: url.href, response_nonce: new Date().toISOString().replace(/\.\d+Z$/, 'Z') + 'random', assoc_handle: 'association', signed: 'op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle', sig: 'server-signature' })) url.searchParams.set(`openid.${key}`, value);
  return url;
}
test('Steam and Dota IDs stay exact and reject anonymous or foreign URLs', () => {
  assert.equal(accountID('76561198030654385'), 70388657);
  assert.equal(accountID('https://steamcommunity.com/profiles/76561198030654385/'), 70388657);
  assert.equal(accountID('70388657'), 70388657);
  for (const value of ['0', '-1', '4294967295', '76561197960265728', 'https://evil.test/profiles/76561198030654385', 'https://steamcommunity.com/id/custom-name', '1e9', undefined]) assert.equal(accountID(value), null);
});
test('Steam endpoints verify Telegram, origin, allowlist and isolate users', async () => {
  const DB = new D1(), env = { DB, TELEGRAM_BOT_TOKEN: token };
  assert.equal((await miniappAPI(req('steam/start', { method: 'POST' }), env)).status, 401);
  assert.equal((await miniappAPI(req('steam/start', { method: 'POST', headers: { ...auth(), Origin: 'https://evil.test' } }), env)).status, 403);
  assert.equal((await miniappAPI(req('steam/status', { headers: auth() }), { ...env, ALLOWED_USER_IDS: '200' })).status, 403);
  const response = await miniappAPI(req('steam/start', { method: 'POST', headers: auth() }), env);
  assert.equal(response.status, 200); const start = await response.json();
  assert.equal(new URL(start.url).hostname, 'steamcommunity.com');
  assert.equal(new URL(new URL(start.url).searchParams.get('openid.return_to')).origin, 'https://example.com');
  DB.db.prepare('INSERT INTO steam_accounts VALUES(?,?,?)').run(100, '76561198030654385', epoch());
  assert.equal((await (await miniappAPI(req('steam/status', { headers: auth(200) }), env)).json()).steam, null);
  assert.equal((await (await miniappAPI(req('steam/status', { headers: auth() }), env)).json()).steam.accountId, 70388657);
  await miniappAPI(req('steam/unlink', { method: 'POST', headers: auth() }), env);
  assert.equal(DB.db.prepare('SELECT COUNT(*) AS n FROM steam_auth').get().n, 0); assert.equal(await steamAccount(DB, 100), null);
});
test('Steam verifies signatures server-side and consumes state once', async t => {
  const DB = new D1(), start = await startSteam(DB, 100, 'https://example.com'); let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls++; assert.equal(url, 'https://steamcommunity.com/openid/login'); assert.equal(new URLSearchParams(options.body).get('openid.mode'), 'check_authentication');
    assert.equal(options.headers['Content-Type'], 'application/x-www-form-urlencoded;charset=UTF-8');
    assert.equal(typeof options.body, 'string'); assert.equal(options.redirect, 'manual');
    return new Response('ns:http://specs.openid.net/auth/2.0\nis_valid:true\n');
  });
  const url = callback(start); await finishSteam(new Request(url), DB);
  assert.equal((await steamAccount(DB, 100)).accountId, 70388657);
  await assert.rejects(finishSteam(new Request(url), DB), /истекла|использована/); assert.equal(calls, 1); assert.equal(await steamAccount(DB, 200), null);
});
test('Steam rejects substituted identity, callback, endpoint, nonce and signed fields before network', async t => {
  const DB = new D1(), start = await startSteam(DB, 100, 'https://example.com');
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected network'); });
  for (const [key, value] of [['openid.return_to', 'https://evil.test'], ['openid.op_endpoint', 'https://evil.test'], ['openid.identity', 'https://steamcommunity.com/openid/id/76561198030654386'], ['openid.signed', 'claimed_id'], ['openid.response_nonce', '2000-01-01T00:00:00Zold']]) {
    const url = callback(start); url.searchParams.set(key, value); await assert.rejects(finishSteam(new Request(url), DB), /не подтвердил/);
  }
  const duplicate = callback(start); duplicate.searchParams.append('state', 'other'); await assert.rejects(finishSteam(new Request(duplicate), DB), /Неверный ответ/);
  assert.equal(await steamAccount(DB, 100), null);
});
test('Invalid signatures, expired, replaced and disconnected Steam states cannot link', async t => {
  const DB = new D1(); t.mock.method(globalThis, 'fetch', async () => new Response('is_valid:false\n'));
  const first = await startSteam(DB, 100, 'https://example.com'); await assert.rejects(finishSteam(new Request(callback(first)), DB), /не подтверждена/);
  const second = await startSteam(DB, 100, 'https://example.com'); await assert.rejects(finishSteam(new Request(callback(first)), DB), /истекла|использована/);
  DB.db.prepare('UPDATE steam_auth SET expires=?').run(epoch() - 1); await assert.rejects(finishSteam(new Request(callback(second)), DB), /истекла|использована/);
  const third = await startSteam(DB, 100, 'https://example.com'); await unlinkSteam(DB, 100); await assert.rejects(finishSteam(new Request(callback(third)), DB), /истекла|использована/);
});
const ranked = (i, overrides = {}) => ({ match_id: 9000000000 + i, hero_id: 1, lobby_type: 7, game_mode: 22, duration: 2100, player_slot: 0, radiant_win: i < 24, kills: 15, assists: 10, deaths: 3, ...overrides });
test('Smurf heuristic requires comparable ranked games and reports evidence without a probability', () => {
  const matches = Array.from({ length: 30 }, (_, i) => ranked(i));
  assert.equal(assessSmurf(matches.slice(0, 19), 30).level, 'insufficient');
  const result = assessSmurf(matches, 100); assert.equal(result.level, 'elevated'); assert.equal(result.winrate, 80); assert.equal(result.sampleSize, 30);
  assert.deepEqual(result.signals.map(s => s.key), ['wins', 'kda', 'history']); assert.equal(result.probability, undefined);
  for (const extra of [{ game_mode: 23 }, { lobby_type: 0 }, { radiant_win: null }]) assert.equal(assessSmurf(matches.map(m => ({ ...m, ...extra })), 100).sampleSize, 0);
  assert.equal(assessSmurf(matches.map((m,i) => ({ ...m, radiant_win: i < 15, kills: 3, assists: 4, deaths: 7 })), 10).level, 'ordinary');
});
test('Match analysis respects Dire slots, anonymous players and missing parsed fields', () => {
  const data = summarizeMatch({ match_id: 9000000000, radiant_win: false, duration: 2000, players: [
    { account_id: 4294967295, player_slot: 0, hero_id: 1, kills: 3, deaths: 4, assists: 1 },
    { account_id: 70388657, player_slot: 128, hero_id: 14, kills: 8, deaths: 2, assists: 9, gold_per_min: 600, tower_damage: 4000 },
  ] });
  assert.equal(data.winner, 'Dire'); assert.equal(data.parsed, false); assert.equal(data.players[0].accountId, null); assert.equal(data.players[0].gpm, null);
  assert.equal(data.players[1].won, true); assert.equal(data.players[0].won, false); assert.equal(data.players[1].hero.name, 'Pudge');
  assert.equal(data.insights.find(row => row.title.includes('золота')).hero, 'Pudge');
});
test('Player analysis caches responses and does not present upstream outages as private history', async t => {
  const DB = new D1(); let calls = 0;
  t.mock.method(globalThis, 'fetch', async url => {
    calls++;
    if (url.endsWith('/wl')) return Response.json({ win: 80, lose: 20 });
    if (url.includes('/matches?')) return Response.json(Array.from({ length: 30 }, (_, i) => ranked(i)));
    return Response.json({ profile: { personaname: '<script>name</script>' }, rank_tier: 54 });
  });
  assert.equal((await analyzePlayer(DB, '70388657')).smurf.level, 'elevated');
  assert.equal((await analyzePlayer(DB, '76561198030654385')).accountId, 70388657); assert.equal(calls, 3);
  t.mock.method(globalThis, 'fetch', async () => new Response('Unavailable', { status: 503 }));
  await assert.rejects(analyzePlayer(DB, '999'), /недоступен/); await assert.rejects(analyzeMatch(DB, 'x'), /числовой/);
});
test('Shared upstream budget rejects excess requests and cache fallback discloses staleness', async t => {
  const DB = new D1(); let calls = 0; t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json({ ok: true }); });
  DB.db.prepare('INSERT INTO meta VALUES(?,?)').run(`opendota_budget:60:${Math.floor(epoch() / 60)}`, '45');
  await assert.rejects(openDota(DB, '/heroes'), /Лимит/); assert.equal(calls, 0);
  DB.db.prepare('INSERT INTO meta VALUES(?,?)').run('test-cache', JSON.stringify({ value: { old: true }, fetchedAt: epoch() - 500 }));
  const result = await cachedData(DB, 'test-cache', 1, async () => { throw new Error('offline'); }); assert.equal(result.stale, true); assert.deepEqual(result.value, { old: true });
});
test('Counter-items target actual invisibility/evasion heroes and prefer the selected role', async () => {
  for (const hero of [21,44]) assert.ok(counterItems(catalogue, [hero], 1).some(item => item.key === 'monkey_king_bar'));
  assert.ok(counterItems(catalogue, [32], 5).some(item => item.key === 'ward_sentry'));
  assert.ok(!counterItems(catalogue, [97], 5).some(item => item.key === 'dust'));
  const support = counterItems(catalogue, [22,25], 5); assert.equal(support[0].roleFit, true); assert.ok(support.some(item => item.key === 'glimmer_cape'));
  const response = await miniappAPI(req('counter-items?enemies=32,44&position=5'), { DB: new D1(), ASSETS: assets }); assert.equal(response.status, 200); assert.ok((await response.json()).items.length);
  for (const query of ['enemies=32,32','enemies=9999','enemies=32&position=6','enemies=']) assert.equal((await miniappAPI(req('counter-items?' + query), { ASSETS: assets })).status, 400);
});
test('Builds show purchase counts, omit recipes/cheap late components and cache by hero', async t => {
  const DB = new D1(); let calls = 0;
  const bkb = catalogue.items.find(item => item.key === 'black_king_bar'), recipe = catalogue.items.find(item => item.key.startsWith('recipe_'));
  t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json({ start_game_items: { 44: 80 }, early_game_items: { 29: 60 }, mid_game_items: { [bkb.id]: 70, 16: 100, [recipe.id]: 100 }, late_game_items: { [bkb.id]: 30 } }); });
  const data = await heroBuild({ DB, ASSETS: assets }, '1', [44], 1); assert.equal(data.hero.name, 'Anti-Mage'); assert.equal(data.stages[2].items.length, 1); assert.equal(data.stages[2].items[0].key, 'black_king_bar'); assert.equal(data.stages[2].items[0].purchases, 70); assert.ok(data.situational.length);
  await heroBuild({ DB, ASSETS: assets }, '1', [32], 5); assert.equal(calls, 1); await assert.rejects(heroBuild({ DB, ASSETS: assets }, '__proto__'), /Неизвестный/);
  for (const query of ['hero=1&enemies=44,44', 'hero=1&position=6', 'hero=1&enemies=9999']) assert.equal((await miniappAPI(req('build?' + query), { DB, ASSETS: assets })).status, 400);
});
