import { q, epoch, accountID, DataError } from './dota-data.js';

const ENDPOINT = 'https://steamcommunity.com/openid/login';
const NS = 'http://specs.openid.net/auth/2.0';
export class SteamAuthError extends DataError {
  constructor(code, message, details = {}) { super(message, 400); this.code = code; this.details = details; }
}
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
  if (new Set(params.keys()).size !== [...params.keys()].length) throw new SteamAuthError('duplicate_fields', 'Неверный ответ Steam: повторяются поля запроса.');
  const state = params.get('state');
  if (!/^[a-f0-9]{64}$/.test(state || '')) throw new SteamAuthError('invalid_state', 'Неверная сессия подключения. Начните подключение в Telegram заново.');
  const pending = await q(db, 'SELECT telegram_id,expires FROM steam_auth WHERE state=?', state).first();
  if (!pending || pending.expires < epoch()) throw new SteamAuthError('expired_state', 'Ссылка истекла, уже использована или заменена новой. Начните одно подключение заново.');
  if (params.get('openid.mode') === 'cancel') throw new SteamAuthError('cancelled', 'Вход отменён на сайте Steam. Можно начать подключение заново.');
  const callback = new URL('/api/steam/callback', url.origin); callback.searchParams.set('state', state);
  const claimed = params.get('openid.claimed_id') || '';
  // The claimed identifier is an identity string, not a URL we fetch. Steam's
  // documentation permits http identifiers; verification still uses fixed HTTPS.
  const id = /^https?:\/\/steamcommunity\.com\/openid\/id\/(\d{17})$/.exec(claimed)?.[1];
  const signed = new Set((params.get('openid.signed') || '').split(','));
  const nonce = params.get('openid.response_nonce') || '';
  const nonceTime = Date.parse(nonce.slice(0, 20)) / 1000;
  const checks = { namespace: params.get('openid.ns') === NS, mode: params.get('openid.mode') === 'id_res', endpoint: params.get('openid.op_endpoint') === ENDPOINT,
    return_to: params.get('openid.return_to') === callback.href, identity: params.get('openid.identity') === claimed && Boolean(id && accountID(id)),
    signed_fields: ['op_endpoint', 'claimed_id', 'identity', 'return_to', 'response_nonce', 'assoc_handle'].every(key => signed.has(key)),
    nonce_time: Number.isFinite(nonceTime) && nonceTime >= epoch() - 600 && nonceTime <= epoch() + 60 };
  const invalidFields = Object.keys(checks).filter(key => !checks[key]);
  if (invalidFields.length) throw new SteamAuthError('invalid_assertion', 'Steam не подтвердил аккаунт: ответ не прошёл проверку. Начните подключение заново.', { invalidFields });
  const verification = new URLSearchParams([...params].filter(([key]) => key.startsWith('openid.')));
  verification.set('openid.mode', 'check_authentication');
  let response;
  try {
    response = await fetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8', Accept: 'text/plain' }, body: verification.toString(), redirect: 'manual', signal: AbortSignal.timeout(12000) });
  } catch { throw new SteamAuthError('steam_transport', 'Сервер не смог связаться со Steam для проверки входа. Попробуйте ещё раз через минуту.'); }
  if (!response.ok) throw new SteamAuthError('steam_http', `Steam временно отклонил проверку входа (HTTP ${response.status}). Попробуйте ещё раз через минуту.`, { httpStatus: response.status });
  const body = await response.text();
  if (!/^is_valid:true\r?$/m.test(body)) throw new SteamAuthError('invalid_signature', 'Подпись Steam не подтверждена. Начните подключение заново.', { responseFormat: /^is_valid:(true|false)\r?$/m.test(body) ? 'openid' : 'unexpected' });
  // Transaction: revoked, expired, or already consumed states cannot establish a link.
  const result = await db.batch([
    q(db, 'INSERT INTO steam_accounts(telegram_id,steam_id,linked_at) SELECT telegram_id,?,? FROM steam_auth WHERE state=? AND expires>=? ON CONFLICT(telegram_id) DO UPDATE SET steam_id=excluded.steam_id,linked_at=excluded.linked_at', id, epoch(), state, epoch()),
    q(db, 'DELETE FROM steam_auth WHERE state=?', state),
  ]);
  if (!result[0].meta.changes) throw new SteamAuthError('consumed_state', 'Сессия уже завершена. Подключите Steam заново.');
}
export async function unlinkSteam(db, userID) {
  await db.batch([q(db, 'DELETE FROM steam_accounts WHERE telegram_id=?', userID), q(db, 'DELETE FROM steam_auth WHERE telegram_id=?', userID)]);
}
export async function recordSteamFailure(db, error) {
  const diagnostic = { at: epoch(), code: error instanceof SteamAuthError ? error.code : 'internal', ...(error instanceof SteamAuthError ? error.details : {}) };
  // No callback URLs, state, signatures, identifiers, cookies or credentials.
  console.warn('Steam connection failed', JSON.stringify(diagnostic));
  try { await q(db, 'INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', 'steam:last_failure', JSON.stringify(diagnostic)).run(); } catch { /* Preserve the original error. */ }
  return diagnostic.code;
}
export function steamResult(message, success = false, code = '') {
  // Only internal, fixed messages reach this document. No OpenID parameters are rendered.
  const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  return new Response(`<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>sds DOTA · Steam</title><link rel="stylesheet" href="/app/app.css?v=3"><body><main class="steam-result"><div class="eyebrow">SDS DOTA / STEAM</div><h1>${success ? 'Аккаунт подключён.' : 'Не удалось подключить.'}</h1><p>${escape(message)}</p>${code ? `<p>Код проверки: ${escape(code)}</p>` : ''}<a class="primary-button" href="https://t.me/dota2sds_bot?startapp">Вернуться в Telegram ↗</a><a class="outline-button" href="/app/#profile">Открыть приложение</a><p>В Telegram откройте «Моё» и нажмите «Проверить подключение».</p></main></body></html>`, {
    status: success ? 200 : 400, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; base-uri 'none'; frame-ancestors 'none'; form-action 'none'", 'X-Content-Type-Options': 'nosniff' },
  });
}
