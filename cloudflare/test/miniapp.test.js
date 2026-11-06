import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { D1 } from './helpers/d1.js';
import { miniappAPI, verifyInitData, appKeyboard } from '../src/miniapp.js';
import { normalizeSlice, POSITIONS } from '../src/meta.js';
const token = 'test-token';
const timestamp = Math.floor(Date.now() / 1000);
function signed(id = 100, extra = {}) {
  const params = new URLSearchParams({ auth_date: String(timestamp), user: JSON.stringify({ id, first_name: 'Игрок' }), signature: 'signed-value', ...extra });
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  params.set('hash', createHmac('sha256', secret).update([...params].sort(([a], [b]) => a < b ? -1 : 1).map(([key, value]) => `${key}=${value}`).join('\n')).digest('hex'));
  return params.toString();
}
const req = (path, options = {}) => new Request(`https://example.com/api/${path}`, options);
const auth = id => ({ 'X-Telegram-Init-Data': signed(id) });

test('Telegram validation includes signature, rejects tampering, expiry, future, duplicates and malformed users', async () => {
  assert.equal((await verifyInitData(signed(), token)).id, 100);
  for (const data of [signed().replace('Игрок', 'x').replace('auth_date=', 'auth_date=0'), signed() + '&auth_date=1', signed(100, { auth_date: String(timestamp - 3601) }), signed(100, { auth_date: String(timestamp + 61) }), signed(-1), signed(100, { user: '{}' }), signed(100, { user: 'invalid' }), 'hash=x']) assert.equal(await verifyInitData(data, token), null);
  assert.equal(await verifyInitData(signed().replace('signed-value', 'tampered'), token), null);
  assert.equal(await verifyInitData(signed(), 'wrong-token'), null);
});

test('profile is private, persists only validated selection and isolates Telegram users', async () => {
  const DB = new D1(), env = { DB, TELEGRAM_BOT_TOKEN: token };
  assert.equal((await miniappAPI(req('profile'), env)).status, 401);
  const saved = await miniappAPI(req('profile', { method: 'POST', headers: auth(100), body: JSON.stringify({ position: 2, rank: 'legend', id: 200 }) }), env);
  assert.equal(saved.status, 200); assert.equal(saved.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual((await saved.json()).preferences, { position: 2, rank: 'legend' });
  assert.deepEqual((await (await miniappAPI(req('profile', { headers: auth(200) }), env)).json()).preferences, { position: 1, rank: 'all' });
  assert.deepEqual((await (await miniappAPI(req('profile', { headers: auth(100) }), env)).json()).preferences, { position: 2, rank: 'legend' });
  assert.equal((await miniappAPI(req('profile', { method: 'POST', headers: { ...auth(100), Origin: 'https://evil.example' }, body: '{}' }), env)).status, 403);
  assert.equal((await miniappAPI(req('profile', { headers: auth(100) }), { ...env, ALLOWED_USER_IDS: '200' })).status, 403);
  assert.equal((await miniappAPI(req('profile', { method: 'POST', headers: auth(100), body: '{' }), env)).status, 400);
  assert.equal((await miniappAPI(req('profile', { method: 'POST', headers: auth(100), body: '{"position":6,"rank":"all"}' }), env)).status, 400);
  assert.deepEqual(DB.db.prepare('SELECT * FROM chats').all(), []);
});

test('public meta serves each actual role with trusted images and preserves freshness disclosures', async () => {
  const DB = new D1(); DB.db.prepare('INSERT INTO events(key,published) VALUES(?,?)').run('patch:7.42', timestamp);
  for (const role of POSITIONS) {
    const raw = JSON.parse(readFileSync(new URL(`./fixtures/meta-${role.key}.json`, import.meta.url)));
    const data = normalizeSlice(raw, 'all', role.key, timestamp);
    DB.db.prepare('INSERT INTO meta(key,value) VALUES(?,?)').run(`hero_meta:v1:all:${role.key}`, JSON.stringify(data));
    const response = await miniappAPI(req(`meta?position=${role.id}&rank=all`), { DB });
    assert.equal(response.status, 200);
    const body = await response.json(); assert.equal(body.role.id, role.id); assert.equal(body.position, role.key); assert.equal(body.heroes.length, 5);
    assert.equal(body.stale, true); assert.equal(body.olderPatch, true); assert.equal(body.knownPatch, '7.42');
    for (const hero of body.heroes) { assert.match(hero.image, /^https:\/\/cdn.cloudflare.steamstatic.com\//); assert.match(hero.url, /^https:\/\/statsdota.com\/en\/heroes\//); }
  }
  for (const query of ['position=0', 'position=6', 'position=NaN', 'rank=unknown', 'rank=__proto__']) assert.equal((await miniappAPI(req('meta?' + query), { DB })).status, 400);
});

test('patch feed contains only saved public digests and never queues another broadcast', async () => {
  const DB = new D1(); DB.db.prepare('INSERT INTO chats VALUES(?,1)').run(999);
  DB.db.prepare('INSERT INTO events(key,published,message,broadcast) VALUES(?,?,?,0)').run('patch:7.41f', timestamp, '<b>Патч 7.41f</b>');
  DB.db.prepare('INSERT INTO events(key,published) VALUES(?,?)').run('patch:7.41e', timestamp - 1);
  const body = await (await miniappAPI(req('patches'), { DB })).json();
  assert.equal(body.events.length, 1); assert.deepEqual(Object.keys(body.events[0]), ['key', 'published', 'message']);
  assert.equal(DB.db.prepare('SELECT COUNT(*) AS n FROM deliveries').get().n, 0);
  assert.equal((await miniappAPI(req('profile', { method: 'DELETE' }), { DB })).status, 404);
});

test('web app launch buttons are limited to private chats', () => {
  assert.ok(appKeyboard(true).inline_keyboard[0][0].web_app.url.endsWith('/app/'));
  assert.equal(appKeyboard(false).inline_keyboard[0][0].web_app, undefined);
  assert.match(appKeyboard(false).inline_keyboard[0][0].url, /^https:\/\/t.me\/dota2sds_bot/);
});
