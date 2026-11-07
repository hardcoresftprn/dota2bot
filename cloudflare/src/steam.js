import { q, epoch, accountID, DataError } from './dota-data.js';

const ENDPOINT = 'https://steamcommunity.com/openid/login';
const NS = 'http://specs.openid.net/auth/2.0';
export async function steamAccount(db, userID) {
  const row = await q(db, 'SELECT steam_id,linked_at FROM steam_accounts WHERE telegram_id=?', userID).first();
  return row ? { steamId: row.steam_id, accountId: accountID(row.steam_id), linkedAt: row.linked_at, url: `https://steamcommunity.com/profiles/${row.steam_id}` } : null;
}
export async function startSteam(db, userID, origin) {
  const timestamp = epoch();
  const state = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('');
  const callback = new URL('/api/steam/callback', origin); callback.searchParams.set('state', state);
  await db.batch([
    q(db, 'DELETE FROM steam_auth WHERE telegram_id=? OR expires<?', userID, timestamp),
    q(db, 'INSERT INTO steam_auth(state,telegram_id,expires) VALUES(?,?,?)', state, userID, timestamp + 600),
  ]);
  const login = new URL(ENDPOINT);
  login.search = new URLSearchParams({ 'openid.ns': NS, 'openid.mode': 'checkid_setup', 'openid.return_to': callback.href,
    'openid.realm': origin + '/', 'openid.identity': NS + '/identifier_select', 'openid.claimed_id': NS + '/identifier_select' });
  return { url: login.href, expiresAt: timestamp + 600 };
}
export async function finishSteam(request, db) {
  const url = new URL(request.url), params = url.searchParams;
  if (new Set(params.keys()).size !== [...params.keys()].length) throw new DataError('Неверный ответ Steam.', 400);
  const state = params.get('state');
  if (!/^[a-f0-9]{64}$/.test(state || '')) throw new DataError('Неверная сессия подключения.', 400);
  const pending = await q(db, 'SELECT telegram_id,expires FROM steam_auth WHERE state=?', state).first();
  if (!pending || pending.expires < epoch()) throw new DataError('Ссылка истекла или уже использована. Подключите Steam заново.', 400);
  const callback = new URL('/api/steam/callback', url.origin); callback.searchParams.set('state', state);
  const claimed = params.get('openid.claimed_id') || '';
  const id = /^https:\/\/steamcommunity\.com\/openid\/id\/(\d{17})$/.exec(claimed)?.[1];
  const signed = new Set((params.get('openid.signed') || '').split(','));
  const nonce = params.get('openid.response_nonce') || '';
  const nonceTime = Date.parse(nonce.slice(0, 20)) / 1000;
  if (params.get('openid.ns') !== NS || params.get('openid.mode') !== 'id_res' || params.get('openid.op_endpoint') !== ENDPOINT
    || params.get('openid.return_to') !== callback.href || params.get('openid.identity') !== claimed || !id || !accountID(id)
    || !['op_endpoint', 'claimed_id', 'identity', 'return_to', 'response_nonce', 'assoc_handle'].every(key => signed.has(key))
    || !Number.isFinite(nonceTime) || nonceTime < epoch() - 600 || nonceTime > epoch() + 60) throw new DataError('Steam не подтвердил аккаунт.', 400);
  const verification = new URLSearchParams([...params].filter(([key]) => key.startsWith('openid.')));
  verification.set('openid.mode', 'check_authentication');
  const response = await fetch(ENDPOINT, { method: 'POST', body: verification, redirect: 'error', signal: AbortSignal.timeout(12000) });
  const body = await response.text();
  if (!response.ok || !/^is_valid:true\r?$/m.test(body)) throw new DataError('Подпись Steam не подтверждена.', 400);
  // Transaction: revoked, expired, or already consumed states cannot establish a link.
  const result = await db.batch([
    q(db, 'INSERT INTO steam_accounts(telegram_id,steam_id,linked_at) SELECT telegram_id,?,? FROM steam_auth WHERE state=? AND expires>=? ON CONFLICT(telegram_id) DO UPDATE SET steam_id=excluded.steam_id,linked_at=excluded.linked_at', id, epoch(), state, epoch()),
    q(db, 'DELETE FROM steam_auth WHERE state=?', state),
  ]);
  if (!result[0].meta.changes) throw new DataError('Сессия уже завершена. Подключите Steam заново.', 400);
}
export async function unlinkSteam(db, userID) {
  await db.batch([q(db, 'DELETE FROM steam_accounts WHERE telegram_id=?', userID), q(db, 'DELETE FROM steam_auth WHERE telegram_id=?', userID)]);
}
export function steamResult(message, success = false) {
  // Only internal, fixed messages reach this document. No OpenID parameters are rendered.
  return new Response(`<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>sds DOTA · Steam</title><link rel="stylesheet" href="/app/app.css?v=3"><body><main class="steam-result"><div class="eyebrow">SDS DOTA / STEAM</div><h1>${success ? 'Аккаунт подключён.' : 'Не удалось подключить.'}</h1><p>${message}</p><a class="primary-button" href="https://t.me/dota2sds_bot?start=app">Вернуться в Telegram ↗</a><a class="outline-button" href="/app/#profile">Открыть приложение</a><p>В Telegram откройте «Моё» и нажмите «Проверить подключение».</p></main></body></html>`, {
    status: success ? 200 : 400, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; base-uri 'none'; frame-ancestors 'none'; form-action 'none'", 'X-Content-Type-Options': 'nosniff' },
  });
}
