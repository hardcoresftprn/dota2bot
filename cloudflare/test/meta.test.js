import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { D1 } from './helpers/d1.js';
import { POSITIONS, CACHE_TTL, MAX_CACHE_AGE, normalizeSlice, loadMeta, renderMeta, parseMetaArgs, parseMetaCallback, rankMenu } from '../src/meta.js';
import worker, { handleUpdate, statement } from '../src/worker.js';

const fixtures = Object.fromEntries(POSITIONS.map(role => [role.key, JSON.parse(readFileSync(new URL(`fixtures/meta-${role.key}.json`, import.meta.url), 'utf8'))]));
const NOW = Math.floor(Date.parse(fixtures.carry.updatedAt) / 1000) + 60;
const fresh = (role = 'carry') => structuredClone(fixtures[role]);
const json = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
function envFor(t) {
  const env = { DB: new D1(), TELEGRAM_BOT_TOKEN: 'fake', TELEGRAM_WEBHOOK_SECRET: 'test-secret' };
  t.after(() => env.DB.db.close());
  t.mock.method(Date, 'now', () => NOW * 1000);
  return env;
}
const cache = (db, data) => statement(db, 'INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)', `hero_meta:v1:${data.requestedRank}:${data.position}`, JSON.stringify(data)).run();
const command = (text, id = 1) => ({ update_id: id, message: { text, chat: { id: 42, type: 'private' }, from: { id: 42 } } });
const callback = (data, id = 2) => ({ update_id: id, callback_query: { id: String(id), data, from: { id: 42 }, message: { message_id: 50, chat: { id: 42, type: 'private' }, from: { id: 999, is_bot: true } } } });

test('meta command parses roles and ranks with bounded choices', () => {
  assert.deepEqual(parseMetaArgs('/meta'), { position: 0, rank: 'all' });
  assert.deepEqual(parseMetaArgs('/meta@our_bot 2 legend'), { position: 2, rank: 'legend' });
  assert.deepEqual(parseMetaArgs('/meta мид легенда'), { position: 2, rank: 'legend' });
  for (const input of ['/meta 6', '/meta banana', '/meta 1 2', '/meta legend ancient', '/meta ../../../secret']) assert.ok(parseMetaArgs(input).error);
});
test('callbacks only accept known ranks and positions', () => {
  assert.deepEqual(parseMetaCallback('meta:legend:4'), { ranksMenu: false, rank: 'legend', position: 4 });
  assert.equal(parseMetaCallback('meta-ranks:all:0').ranksMenu, true);
  for (const data of ['meta:all:6', 'meta:unknown:1', 'meta:all:1:extra', 'other:all:1']) assert.equal(parseMetaCallback(data), null);
  assert.equal(rankMenu('all', 3).reply_markup.inline_keyboard.flat().length, 9);
});
test('rejects aggregate/wrong-role stats and malformed dates', () => {
  assert.throws(() => normalizeSlice({ ...fresh(), position: 'mid' }, 'all', 'carry', NOW));
  assert.throws(() => normalizeSlice({ ...fresh(), rank: 'legend' }, 'all', 'carry', NOW));
  assert.throws(() => normalizeSlice({ ...fresh(), updatedAt: 'unknown', fetchedAt: 'unknown' }, 'all', 'carry', NOW));
  assert.throws(() => normalizeSlice({ ...fresh(), unavailable: 'not enough games' }, 'all', 'carry', NOW));
});
test('ranks by source meta score rather than the largest raw win rate', () => {
  const data = fresh();
  data.rows[1].winrate = 95;
  data.rows[1].score = 1;
  const normalized = normalizeSlice(data, 'all', 'carry', NOW);
  assert.equal(normalized.heroes[0].heroId, data.rows[0].heroId);
  assert.notEqual(normalized.heroes[0].winrate, 95);
});
test('invalid or low-sample rows are excluded, not promoted to top heroes', () => {
  const data = fresh();
  data.rows.unshift({ ...data.rows[0], heroId: 9999, score: 100, matches: 2 });
  data.rows.unshift({ ...data.rows[1], heroId: 9998, score: 100, winrate: 150 });
  assert.ok(normalizeSlice(data, 'all', 'carry', NOW).heroes.every(row => row.heroId < 9998));
});
test('all five positions load from their actual position-specific source slices', async t => {
  const env = envFor(t), positions = [];
  const stub = t.mock.method(globalThis, 'fetch', async url => {
    const parsed = new URL(url); const role = parsed.searchParams.get('position');
    positions.push(role); assert.equal(parsed.searchParams.get('rank'), 'all');
    return json(fresh(role));
  });
  const slices = await loadMeta(env.DB, 'all', 0, NOW);
  assert.equal(stub.mock.callCount(), 5);
  assert.deepEqual(positions.sort(), POSITIONS.map(role => role.key).sort());
  assert.ok(slices.every(slice => slice.data.position === slice.role.key));
  assert.equal((await statement(env.DB, 'SELECT * FROM leases').all()).results.length, 0);
});
test('hourly cache avoids repeated API calls and stays separate by rank', async t => {
  const env = envFor(t);
  const stub = t.mock.method(globalThis, 'fetch', async url => {
    const parsed = new URL(url); return json({ ...fresh(), rank: parsed.searchParams.get('rank') });
  });
  await loadMeta(env.DB, 'all', 1, NOW);
  await loadMeta(env.DB, 'all', 1, NOW + 20);
  assert.equal(stub.mock.callCount(), 1);
  await loadMeta(env.DB, 'legend', 1, NOW + 20);
  assert.equal(stub.mock.callCount(), 2);
  await loadMeta(env.DB, 'all', 1, NOW + CACHE_TTL + 1);
  assert.equal(stub.mock.callCount(), 3);
});
test('source failure uses explicitly stale cache and a retry backoff', async t => {
  const env = envFor(t); const data = normalizeSlice(fresh(), 'all', 'carry', NOW - CACHE_TTL - 1);
  await cache(env.DB, data);
  const stub = t.mock.method(globalThis, 'fetch', async () => new Response('down', { status: 503 }));
  const slices = await loadMeta(env.DB, 'all', 1, NOW);
  assert.equal(slices[0].data.checkedAt, data.checkedAt);
  assert.equal(slices[0].data.failedAt, NOW);
  assert.ok(renderMeta(slices, 'all', 1, '7.41f', NOW).text.includes('устарели'));
  await loadMeta(env.DB, 'all', 1, NOW + 20);
  assert.equal(stub.mock.callCount(), 1);
});
test('very old cache is not presented as current meta', async t => {
  const env = envFor(t); const data = { ...normalizeSlice(fresh(), 'all', 'carry', NOW), checkedAt: NOW - MAX_CACHE_AGE - 1 };
  await cache(env.DB, data);
  t.mock.method(globalThis, 'fetch', async () => new Response('down', { status: 503 }));
  const result = await loadMeta(env.DB, 'all', 1, NOW);
  assert.equal(result[0].data, null);
  assert.ok(renderMeta(result, 'all', 1, '7.41f', NOW).text.includes('временно недоступна'));
});
test('one failed position does not suppress the other four positions', async t => {
  const env = envFor(t);
  t.mock.method(globalThis, 'fetch', async url => {
    const role = new URL(url).searchParams.get('position');
    return role === 'mid' ? new Response('down', { status: 503 }) : json(fresh(role));
  });
  const slices = await loadMeta(env.DB, 'all', 0, NOW);
  assert.equal(slices.filter(slice => slice.data).length, 4);
  const result = renderMeta(slices, 'all', 0, '7.41f', NOW);
  assert.ok(result.text.includes('временно недоступна'));
  assert.ok(result.text.includes('Lich'));
});
test('render discloses older patch, stale source date, and widened rank scope', () => {
  const data = normalizeSlice({ ...fresh(), fallback: 'all-ranks' }, 'immortal', 'carry', NOW);
  const slices = [{ role: POSITIONS[0], data }];
  const result = renderMeta(slices, 'immortal', 1, '7.42', NOW + 3 * 86400);
  assert.ok(result.text.includes('у Valve уже 7.42'));
  assert.ok(result.text.includes('расширил выборку'));
  assert.ok(result.text.includes('устарели'));
});
test('overview and details include period, sample, source and safe HTML', () => {
  const slices = POSITIONS.map(role => ({ role, data: normalizeSlice(fresh(role.key), 'all', role.key, NOW) }));
  slices[0].data.heroes[0].name = '<script>& Hero';
  const overview = renderMeta(slices, 'all', 0, '7.41f', NOW);
  assert.ok(overview.text.includes('29.10.2026'));
  assert.ok(overview.text.includes('&lt;script&gt;'));
  assert.ok(!overview.text.includes('<script>'));
  assert.ok(overview.text.length < 4096);
  const detailed = renderMeta([slices[0]], 'all', 1, '7.41f', NOW);
  assert.ok(detailed.text.includes('пики'));
  assert.ok(detailed.text.includes('матчей'));
  assert.ok(detailed.text.includes('statsdota.com/en/meta/all/carry'));
  assert.ok(detailed.text.length < 4096);
});
test('/meta sends one interactive reply without adding notification deliveries', async t => {
  const env = envFor(t), sent = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (String(url).includes('api.telegram.org')) { sent.push({ method: String(url).split('/').at(-1), body: JSON.parse(options.body) }); return json({ ok: true, result: {} }); }
    return json(fresh(new URL(url).searchParams.get('position')));
  });
  await handleUpdate(env, command('/meta'));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].method, 'sendMessage');
  assert.equal(sent[0].body.reply_markup.inline_keyboard.flat().length, 7);
  assert.equal((await statement(env.DB, 'SELECT * FROM deliveries').all()).results.length, 0);
});
test('callbacks acknowledge before loading, edit existing reply, and check clicking user', async t => {
  const env = { ...envFor(t), ALLOWED_USER_IDS: '42' }, methods = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (String(url).includes('api.telegram.org')) { methods.push(String(url).split('/').at(-1)); return json({ ok: true, result: {} }); }
    assert.equal(methods[0], 'answerCallbackQuery');
    return json(fresh(new URL(url).searchParams.get('position')));
  });
  await handleUpdate(env, callback('meta:all:2'));
  assert.deepEqual(methods, ['answerCallbackQuery', 'editMessageText']);
});
test('duplicate callback does not edit message twice', async t => {
  const env = envFor(t), methods = [];
  t.mock.method(globalThis, 'fetch', async url => { methods.push(String(url).split('/').at(-1)); return json({ ok: true, result: {} }); });
  const item = callback('meta-ranks:all:0');
  await handleUpdate(env, item); await handleUpdate(env, item);
  assert.equal(methods.filter(method => method === 'editMessageText').length, 1);
});
test('unchanged message is a successful callback, not a new chat message', async t => {
  const env = envFor(t); const methods = [];
  t.mock.method(globalThis, 'fetch', async url => {
    const method = String(url).split('/').at(-1); methods.push(method);
    return method === 'editMessageText' ? json({ ok: false, error_code: 400, description: 'Bad Request: message is not modified' }) : json({ ok: true, result: {} });
  });
  await assert.doesNotReject(handleUpdate(env, callback('meta-ranks:all:0')));
  assert.ok(!methods.includes('sendMessage'));
});
test('authenticated webhook handles callback updates', async t => {
  const env = envFor(t);
  t.mock.method(globalThis, 'fetch', async () => json({ ok: true, result: {} }));
  const request = new Request('https://bot.example/telegram', { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': 'test-secret' }, body: JSON.stringify(callback('meta-ranks:all:0')) });
  assert.equal((await worker.fetch(request, env)).status, 200);
});
