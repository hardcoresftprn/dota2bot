import test from 'node:test';
import assert from 'node:assert/strict';
import { D1 } from './helpers/d1.js';
import { startSteam, finishSteam, steamAccount, steamResult } from '../src/steam.js';
import { miniappAPI } from '../src/miniapp.js';
function callback(start, scheme = 'https') {
  const url = new URL(new URL(start.url).searchParams.get('openid.return_to'));
  for (const [key, value] of Object.entries({ ns: 'http://specs.openid.net/auth/2.0', mode: 'id_res', op_endpoint: 'https://steamcommunity.com/openid/login', claimed_id: `${scheme}://steamcommunity.com/openid/id/76561198030654385`, identity: `${scheme}://steamcommunity.com/openid/id/76561198030654385`, return_to: url.href, response_nonce: new Date().toISOString().replace(/\.\d+Z$/, 'Z') + 'nonce', assoc_handle: 'association', signed: 'op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle', sig: 'test-signature/+=' })) url.searchParams.set(`openid.${key}`, value);
  return url;
}
test('documented HTTP Steam identifiers still require direct HTTPS signature verification', async t => {
  const DB = new D1(), start = await startSteam(DB, 100, 'https://example.com');
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://steamcommunity.com/openid/login');
    assert.equal(options.headers['Content-Type'], 'application/x-www-form-urlencoded;charset=UTF-8');
    const form = new URLSearchParams(options.body);
    assert.equal(form.get('openid.sig'), 'test-signature/+=');
    assert.equal(form.get('openid.claimed_id'), 'http://steamcommunity.com/openid/id/76561198030654385');
    assert.equal(form.has('state'), false);
    return new Response('ns:http://specs.openid.net/auth/2.0\nis_valid:true\n');
  });
  await finishSteam(new Request(callback(start, 'http')), DB);
  assert.equal((await steamAccount(DB, 100)).accountId, 70388657);
});
test('callback reports upstream HTTP errors without leaking callback parameters or linking a user', async t => {
  const DB = new D1(), start = await startSteam(DB, 100, 'https://example.com');
  t.mock.method(globalThis, 'fetch', async () => new Response('<h1>Forbidden</h1>', { status: 403 }));
  const response = await miniappAPI(new Request(callback(start)), { DB });
  assert.equal(response.status, 400); const html = await response.text();
  assert.match(html, /HTTP 403/); assert.match(html, /steam_http/);
  const row = DB.db.prepare("SELECT value FROM meta WHERE key='steam:last_failure'").get();
  assert.deepEqual(Object.keys(JSON.parse(row.value)).sort(), ['at','code','httpStatus']);
  assert.ok(!row.value.includes('test-signature')); assert.ok(!row.value.includes('7656119'));
  assert.equal(await steamAccount(DB, 100), null);
});
test('invalid assertions report only failed check names and do not contact Steam', async t => {
  const DB = new D1(), start = await startSteam(DB, 100, 'https://example.com');
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected network'); });
  const url = callback(start); url.searchParams.set('openid.return_to', 'https://evil.example');
  const response = await miniappAPI(new Request(url), { DB });
  assert.match(await response.text(), /invalid_assertion/);
  const diagnostic = JSON.parse(DB.db.prepare("SELECT value FROM meta WHERE key='steam:last_failure'").get().value);
  assert.deepEqual(diagnostic.invalidFields, ['return_to']); assert.ok(!JSON.stringify(diagnostic).includes('evil.example'));
  assert.equal(await steamAccount(DB, 100), null);
});
test('network, provider cancellation and negative signatures remain distinct and never create a link', async t => {
  for (const [expected, mock] of [['steam_transport', async () => { throw new TypeError('sensitive request url'); }], ['invalid_signature', async () => new Response('is_valid:false\n')]]) {
    const DB = new D1(), start = await startSteam(DB, 100, 'https://example.com');
    t.mock.method(globalThis, 'fetch', mock);
    await assert.rejects(finishSteam(new Request(callback(start)), DB), error => error.code === expected);
    assert.equal(await steamAccount(DB, 100), null);
  }
  const DB = new D1(), start = await startSteam(DB, 100, 'https://example.com'), url = callback(start);
  url.searchParams.set('openid.mode', 'cancel');
  await assert.rejects(finishSteam(new Request(url), DB), error => error.code === 'cancelled');
});
test('callback result escapes messages and returns directly to the configured Main Mini App', async () => {
  const html = await steamResult('<script>bad</script>', false, 'test').text();
  assert.ok(!html.includes('<script>')); assert.ok(html.includes('&lt;script&gt;')); assert.ok(html.includes('https://t.me/dota2sds_bot?startapp'));
});
