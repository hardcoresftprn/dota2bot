import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker, { statement, getMeta, setMeta, saveEvent, checkPatches, checkNews, deliver, scheduled, handleUpdate } from '../src/worker.js';
import { basicSummary, render, newsCategories, newsEvent, versionOf, notes, loadPatch } from '../src/content.js';

class D1 {
  constructor() { this.db = new DatabaseSync(':memory:'); this.db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8')); }
  prepare(sql) {
    const db = this.db;
    return { bind(...args) {
      return {
        async first() { return db.prepare(sql).get(...args) || null; },
        async all() { return { results: db.prepare(sql).all(...args) }; },
        async run() { const result = db.prepare(sql).run(...args); return { meta: { changes: Number(result.changes) } }; },
      };
    } };
  }
  async batch(statements) {
    this.db.exec('BEGIN');
    try { const result = []; for (const stmt of statements) result.push(await stmt.run()); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
}
const envFor = t => {
  const env = { DB: new D1(), TELEGRAM_BOT_TOKEN: 'fake', TELEGRAM_WEBHOOK_SECRET: 'test-secret' };
  t.after(() => env.DB.db.close()); return env;
};
const event = (version = '7.99a', published = 10) => ({ key: `patch:${version}`, version, title: `Патч ${version}`, published,
  url: `https://www.dota2.com/patches/${version}`, categories: ['Баланс'], facts: ['Axe: Броня увеличена с 2 до 3'] });
const subscribe = (env, id) => statement(env.DB, 'INSERT INTO chats(id,active) VALUES(?,1)', id).run();
const update = (command, id = 1, chat = { id: 42, type: 'private' }) => ({ update_id: id, message: { text: command, chat, from: { id: 42 } } });
const json = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
const patchData = version => ({ patch_number: version, heroes: [{ hero_id: 2, hero_notes: [{ note: 'Броня увеличена с 2 до 3' }] }] });

test('canonical ID and official news redirect preserved', () => {
  assert.equal(versionOf('7.99a Gameplay Patch'), '7.99a');
  const row = { gid: '123', title: 'Update', contents: 'Matchmaking update now available', date: 10,
    url: 'https://steamstore-a.akamaihd.net/news/externalpost/steam_community_announcements/123' };
  assert.equal(newsEvent(row).url, row.url);
  assert.throws(() => newsEvent({ ...row, url: 'https://unknown.invalid/' }));
});
test('cosmetics, bug fixes, tournaments, future heroes excluded', () => {
  for (const text of ['New hero sets available now', 'Fixed Axe animation', 'Ranked teams fight for a new trophy', 'A new hero coming soon']) assert.deepEqual(newsCategories(text, ''), []);
  assert.deepEqual(newsCategories('Matchmaking update', 'New calibration rules'), ['Рейтинговая система']);
});
test('nested notes and HTML escaping', () => {
  assert.deepEqual(notes([{ title: 'Economy', generic: [{ note: 'Gold changed' }] }]), ['Economy: Gold changed']);
  const item = { ...event(), title: '<script> & Axe' };
  const digest = render(item, basicSummary(item), true);
  assert.ok(digest.includes('&lt;script&gt;'));
  assert.ok(!digest.includes('<script>'));
  assert.ok(digest.length < 4096);
});
test('atomic outbox trigger and duplicate ingestion', async t => {
  const env = envFor(t);
  await subscribe(env, 1); await subscribe(env, 2);
  await saveEvent(env.DB, event(), 'Первый разбор 🎮');
  await saveEvent(env.DB, event(), 'duplicate');
  assert.equal((await statement(env.DB, 'SELECT * FROM deliveries').all()).results.length, 2);
  await subscribe(env, 3);
  await saveEvent(env.DB, event(), 'repeat again');
  assert.equal((await statement(env.DB, 'SELECT * FROM deliveries').all()).results.length, 2);
});
test('baseline has latest digest without historical broadcast', async t => {
  const env = envFor(t);
  await subscribe(env, 1);
  await saveEvent(env.DB, event(), 'digest', false);
  assert.equal((await statement(env.DB, 'SELECT * FROM deliveries').all()).results.length, 0);
  assert.equal((await statement(env.DB, 'SELECT message FROM events').first()).message, 'digest');
});
test('new subscriber only receives new events', async t => {
  const env = envFor(t);
  await saveEvent(env.DB, event(), 'old'); await subscribe(env, 1);
  await saveEvent(env.DB, event('7.99b', 20), 'new');
  assert.deepEqual((await statement(env.DB, 'SELECT event_key FROM deliveries').all()).results.map(row => row.event_key), ['patch:7.99b']);
});
test('start, duplicate webhook, stop and resubscribe do not replay patches', async t => {
  const env = envFor(t); const sent = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => { sent.push(JSON.parse(options.body)); return json({ ok: true, result: {} }); });
  await handleUpdate(env, update('/start'));
  await handleUpdate(env, update('/start'));
  assert.equal(sent.length, 1);
  await saveEvent(env.DB, event(), 'digest');
  await handleUpdate(env, update('/stop', 2));
  await handleUpdate(env, update('/start', 3));
  assert.equal((await statement(env.DB, 'SELECT status FROM deliveries').first()).status, 'cancelled');
});
test('group subscriptions require administrator', async t => {
  const env = envFor(t); let status = 'member';
  t.mock.method(globalThis, 'fetch', async url => json({ ok: true, result: String(url).endsWith('getChatMember') ? { status } : {} }));
  const chat = { id: -42, type: 'group' };
  await handleUpdate(env, update('/start', 1, chat));
  assert.equal(await statement(env.DB, 'SELECT * FROM chats').first(), null);
  status = 'administrator';
  await handleUpdate(env, update('/start', 2, chat));
  assert.equal((await statement(env.DB, 'SELECT active FROM chats').first()).active, 1);
});
test('allowlist rejects command author outside list', async t => {
  const env = { ...envFor(t), ALLOWED_USER_IDS: '100,200' };
  await handleUpdate(env, update('/start'));
  assert.equal(await statement(env.DB, 'SELECT * FROM chats').first(), null);
});
test('commands addressed to another bot ignored', async t => {
  const env = envFor(t);
  await setMeta(env.DB, 'bot_username', 'our_bot');
  await handleUpdate(env, update('/start@other_bot'));
  assert.equal(await statement(env.DB, 'SELECT * FROM chats').first(), null);
});
test('webhook secret required before parsing or database access', async () => {
  const request = new Request('https://bot.example/telegram', { method: 'POST', body: '{}' });
  assert.equal((await worker.fetch(request, { TELEGRAM_WEBHOOK_SECRET: 'secret' })).status, 403);
  assert.equal((await worker.fetch(new Request('https://bot.example/healthz'), {})).status, 200);
  assert.equal((await worker.fetch(new Request('https://bot.example/'), {})).status, 404);
});
test('malformed authenticated webhook rejected', async () => {
  const request = new Request('https://bot.example/telegram', { method: 'POST', body: 'not-json', headers: { 'X-Telegram-Bot-Api-Secret-Token': 'secret' } });
  assert.equal((await worker.fetch(request, { TELEGRAM_WEBHOOK_SECRET: 'secret' })).status, 400);
});
test('first patch check then new release sends only once', async t => {
  const env = envFor(t); await subscribe(env, 1);
  let versions = ['7.99a'];
  t.mock.method(globalThis, 'fetch', async url => {
    const parsed = new URL(url);
    return json(parsed.pathname.endsWith('patchnoteslist') ? { success: true, patches: versions.map((patch_number, index) => ({ patch_number, patch_timestamp: 10 + index })) } : patchData(parsed.searchParams.get('version')));
  });
  await checkPatches(env);
  assert.equal((await statement(env.DB, 'SELECT * FROM deliveries').all()).results.length, 0);
  versions = ['7.99a', '7.99b'];
  await checkPatches(env); await checkPatches(env);
  assert.equal((await statement(env.DB, 'SELECT * FROM deliveries').all()).results.length, 1);
});
test('failed first patch fetch leaves baseline retryable', async t => {
  const env = envFor(t);
  t.mock.method(globalThis, 'fetch', async url => String(url).includes('patchnoteslist')
    ? json({ success: true, patches: [{ patch_number: '7.99a', patch_timestamp: 10 }] }) : new Response('failed', { status: 503 }));
  await assert.rejects(checkPatches(env));
  assert.equal(await getMeta(env.DB, 'patches_initialized'), undefined);
});
test('same patch from Steam does not duplicate Dota outbox', async t => {
  const env = envFor(t); await subscribe(env, 1); await saveEvent(env.DB, event(), 'digest');
  await setMeta(env.DB, 'news_cursor', '10');
  t.mock.method(globalThis, 'fetch', async () => json({ appnews: { newsitems: [{ gid: '123', title: '7.99a Gameplay Patch', contents: 'Patch out now', date: 11, appid: 570, feedname: 'steam_community_announcements' }] } }));
  await checkNews(env);
  assert.equal((await statement(env.DB, 'SELECT * FROM deliveries').all()).results.length, 1);
  assert.ok(await statement(env.DB, "SELECT key FROM events WHERE key='news:123'").first());
});
test('Steam baseline cannot suppress missing patchnotes', async t => {
  const env = envFor(t);
  t.mock.method(globalThis, 'fetch', async () => json({ appnews: { newsitems: [{ gid: '123', title: '7.99a Gameplay Patch', date: 10, appid: 570, feedname: 'steam_community_announcements' }] } }));
  await checkNews(env);
  assert.equal(await statement(env.DB, "SELECT key FROM events WHERE key='patch:7.99a'").first(), null);
});
test('news backlog pagination resumes across invocations', async t => {
  const env = envFor(t); await setMeta(env.DB, 'news_cursor', '100000');
  const page = Array.from({ length: 20 }, (_, index) => ({ gid: String(index + 1), title: 'Tournament results', contents: '', date: 100100 - index, appid: 570, feedname: 'steam_community_announcements', url: `https://store.steampowered.com/news/externalpost/steam_community_announcements/${index + 1}` }));
  let requestEnd;
  t.mock.method(globalThis, 'fetch', async url => {
    requestEnd = new URL(url).searchParams.get('enddate');
    return json({ appnews: { newsitems: requestEnd ? [] : page } });
  });
  // Drain two articles per run, then advance the backward page cursor.
  for (let i = 0; i < 10; i++) await checkNews(env);
  assert.equal(await getMeta(env.DB, 'news_scan_end'), '100080');
  await checkNews(env);
  assert.equal(requestEnd, '100080');
  assert.equal(await getMeta(env.DB, 'news_scan_end'), undefined);
  assert.equal(await getMeta(env.DB, 'news_scan_started'), undefined);
  assert.equal((await statement(env.DB, 'SELECT * FROM events').all()).results.length, 20);
});
test('Telegram 429 reschedules without advancing another recipient', async t => {
  const env = envFor(t); await subscribe(env, 1); await subscribe(env, 2); await saveEvent(env.DB, event(), 'digest');
  t.mock.method(globalThis, 'fetch', async () => json({ ok: false, error_code: 429, parameters: { retry_after: 30 } }));
  await deliver(env);
  const rows = (await statement(env.DB, 'SELECT status,next_attempt FROM deliveries ORDER BY chat_id').all()).results;
  assert.equal(rows[0].status, 'pending'); assert.ok(rows[0].next_attempt > Date.now() / 1000);
  assert.equal(rows[1].next_attempt, 0);
});
test('ambiguous timeout is not automatically resent', async t => {
  const env = envFor(t); await subscribe(env, 1); await saveEvent(env.DB, event(), 'digest');
  const stub = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Read timeout'); });
  await deliver(env); await deliver(env);
  assert.equal(stub.mock.callCount(), 1);
  assert.equal((await statement(env.DB, 'SELECT status FROM deliveries').first()).status, 'uncertain');
});
test('blocked subscriber does not prevent another friend receiving digest', async t => {
  const env = envFor(t); await subscribe(env, 1); await subscribe(env, 2); await saveEvent(env.DB, event(), 'digest');
  t.mock.method(globalThis, 'fetch', async (_url, options) => JSON.parse(options.body).chat_id === 1
    ? json({ ok: false, error_code: 403 }) : json({ ok: true, result: {} }));
  await deliver(env);
  assert.equal((await statement(env.DB, 'SELECT active FROM chats WHERE id=1').first()).active, 0);
  assert.equal((await statement(env.DB, 'SELECT status FROM deliveries WHERE chat_id=2').first()).status, 'sent');
});
test('stale sending status becomes uncertain after interrupted process', async t => {
  const env = envFor(t); await subscribe(env, 1); await saveEvent(env.DB, event(), 'digest');
  await statement(env.DB, "UPDATE deliveries SET status='sending',started=0").run();
  const stub = t.mock.method(globalThis, 'fetch', async () => { throw new Error('must not send'); });
  await deliver(env); assert.equal(stub.mock.callCount(), 0);
  assert.equal((await statement(env.DB, 'SELECT status FROM deliveries').first()).status, 'uncertain');
});
test('overlapping cron invocation excluded by durable lease', async t => {
  const env = envFor(t);
  await statement(env.DB, 'INSERT INTO leases VALUES(?,?,?)', 'cron', 'other', Math.floor(Date.now() / 1000) + 200).run();
  const stub = t.mock.method(globalThis, 'fetch', async () => { throw new Error('must not fetch'); });
  await scheduled(env); assert.equal(stub.mock.callCount(), 0);
});
test('source failure still allows delivery queue to progress', async t => {
  const env = envFor(t); await subscribe(env, 1); await saveEvent(env.DB, event(), 'digest');
  t.mock.method(globalThis, 'fetch', async url => String(url).includes('api.telegram.org')
    ? json({ ok: true, result: {} }) : new Response('offline', { status: 503 }));
  await scheduled(env, 0);
  assert.equal((await statement(env.DB, 'SELECT status FROM deliveries').first()).status, 'sent');
  assert.equal(await statement(env.DB, 'SELECT * FROM leases').first(), null);
});
