import { loadCounters, rankCounters } from './counters.js';
import { loadMeta, POSITIONS, RANKS, metaURL, META_ORIGIN, isSliceStale, olderPatch } from './meta.js';
import { now } from './content.js';
import { HERO_IMAGES } from './hero-images.js';
import { analyzeMatch, analyzePlayer } from './analysis.js';
import { heroBuild, heroBuildContext, itemCatalogue, counterItems } from './builds.js';
import { steamAccount, startSteam, finishSteam, unlinkSteam, steamResult } from './steam.js';
import { DataError } from './dota-data.js';
import names from './names.js';

const query = (db, sql, ...args) => db.prepare(sql).bind(...args);
const encoder = new TextEncoder();
const json = (data, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
const selection = value => value && Object.hasOwn(RANKS, value.rank) && Number.isInteger(value.position) && value.position >= 1 && value.position <= 5;

// Trust only signed, recent Telegram initData. The user ID never comes from the request body.
export async function verifyInitData(raw, token, timestamp = now()) {
  if (!token || !raw || raw.length > 8192) return null;
  const params = new URLSearchParams(raw);
  if (new Set(params.keys()).size !== [...params.keys()].length) return null;
  const hash = params.get('hash');
  if (!/^[a-f0-9]{64}$/.test(hash || '')) return null;
  params.delete('hash');
  const authDate = Number(params.get('auth_date'));
  if (!Number.isInteger(authDate) || authDate < timestamp - 3600 || authDate > timestamp + 60) return null;
  const key = await crypto.subtle.importKey('raw', encoder.encode('WebAppData'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const secret = await crypto.subtle.sign('HMAC', key, encoder.encode(token));
  const signingKey = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const data = [...params].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, val]) => `${key}=${val}`).join('\n');
  const valid = await crypto.subtle.verify('HMAC', signingKey, Uint8Array.from(hash.match(/../g), byte => parseInt(byte, 16)), encoder.encode(data));
  if (!valid) return null;
  try {
    const user = JSON.parse(params.get('user'));
    return Number.isSafeInteger(user?.id) && user.id > 0 && typeof user.first_name === 'string' ? user : null;
  } catch { return null; }
}

export async function miniappAPI(request, env) {
  const url = new URL(request.url);
  try {
    if (url.pathname === '/api/heroes' && request.method === 'GET') return json({ heroes: Object.entries(names.heroes).map(([id, name]) => ({ id: Number(id), name, image: HERO_IMAGES[id] || null })).sort((a, b) => a.name.localeCompare(b.name)) });
    if (url.pathname === '/api/counter-items' && request.method === 'GET') {
      const raw = url.searchParams.get('enemies') || '';
      const position = Number(url.searchParams.get('position') || 1), enemies = raw.split(',').map(Number);
      if (!/^\d+(,\d+){0,4}$/.test(raw) || new Set(enemies).size !== enemies.length || enemies.some(id => !Object.hasOwn(names.heroes, id)) || !Number.isInteger(position) || position < 1 || position > 5) return json({ error: 'Выберите от одного до пяти разных героев и позицию.' }, 400);
      const catalogue = await itemCatalogue(env);
      return json({ items: counterItems(catalogue, enemies, position), itemsUpdatedAt: catalogue.fetchedAt, itemsStale: now() - catalogue.fetchedAt > 3 * 86400 });
    }
    if (url.pathname === '/api/steam/callback' && request.method === 'GET') {
      try { await finishSteam(request, env.DB); return steamResult('Steam подтверждён и привязан к вашему аккаунту Telegram.', true); }
      catch { return steamResult('Вернитесь в приложение и начните подключение заново. Подтверждение Steam отменено, истекло или не прошло проверку.'); }
    }
    if (url.pathname.startsWith('/api/steam/') && ['GET', 'POST'].includes(request.method)) {
      if (request.method === 'POST' && request.headers.get('Origin') && request.headers.get('Origin') !== url.origin) return json({ error: 'Forbidden' }, 403);
      const user = await verifyInitData(request.headers.get('X-Telegram-Init-Data'), env.TELEGRAM_BOT_TOKEN);
      if (!user) return json({ error: 'Откройте приложение заново через Telegram, чтобы подключить Steam.' }, 401);
      const allowed = String(env.ALLOWED_USER_IDS || '').split(',').map(id => id.trim()).filter(Boolean);
      if (allowed.length && !allowed.includes(String(user.id))) return json({ error: 'Нет доступа.' }, 403);
      if (url.pathname === '/api/steam/status' && request.method === 'GET') return json({ steam: await steamAccount(env.DB, user.id) });
      if (url.pathname === '/api/steam/start' && request.method === 'POST') return json(await startSteam(env.DB, user.id, url.origin));
      if (url.pathname === '/api/steam/unlink' && request.method === 'POST') { await unlinkSteam(env.DB, user.id); return json({ steam: null }); }
      return json({ error: 'Not found' }, 404);
    }
    if (url.pathname === '/api/analysis/player' && request.method === 'GET') return json(await analyzePlayer(env.DB, url.searchParams.get('id')));
    if (url.pathname === '/api/analysis/match' && request.method === 'GET') return json(await analyzeMatch(env.DB, url.searchParams.get('id')));
    if (['/api/build', '/api/build-context'].includes(url.pathname) && request.method === 'GET') {
      const raw = url.searchParams.get('enemies');
      const enemies = raw ? raw.split(',').map(Number) : [];
      const position = Number(url.searchParams.get('position') || 1);
      if ((raw && !/^\d+(,\d+){0,4}$/.test(raw)) || new Set(enemies).size !== enemies.length || enemies.some(id => !Object.hasOwn(names.heroes, id)) || !Number.isInteger(position) || position < 1 || position > 5) return json({ error: 'Неверный список врагов или позиция.' }, 400);
      return json(await (url.pathname === '/api/build-context' ? heroBuildContext : heroBuild)(env, url.searchParams.get('hero'), enemies, position));
    }
    if (url.pathname === '/api/counters' && request.method === 'GET') {
      const raw = url.searchParams.get('enemies');
      const position = Number(url.searchParams.get('position') || 1);
      if (raw && (!/^\d+(,\d+){0,4}$/.test(raw) || new Set(raw.split(',')).size !== raw.split(',').length)) return json({ error: 'Выберите от одного до пяти разных героев.' }, 400);
      if (!Number.isInteger(position) || position < 1 || position > 5) return json({ error: 'Неверная позиция.' }, 400);
      const data = await loadCounters(env.DB, now(), env.ASSETS);
      const latest = await query(env.DB, "SELECT key FROM events WHERE key LIKE 'patch:%' ORDER BY published DESC LIMIT 1").first();
      data.stale ||= olderPatch(data.patch, latest?.key.slice(6)) || now() - data.catalogueUpdatedAt > 2 * 86400;
      if (!raw) return json({ heroes: data.heroes, patch: data.patch, checkedAt: data.checkedAt, stale: data.stale });
      const enemies = raw.split(',').map(Number);
      if (enemies.some(id => !data.heroes.some(h => h.id === id))) return json({ error: 'Неизвестный герой.' }, 400);
      const result = rankCounters(data, enemies, position);
      try {
        const catalogue = await itemCatalogue(env);
        result.items = counterItems(catalogue, enemies, position);
        result.itemsUpdatedAt = catalogue.fetchedAt;
        result.itemsStale = now() - catalogue.fetchedAt > 3 * 86400;
      } catch { result.items = []; result.itemsIssue = 'Каталог предметов временно недоступен.'; }
      result.itemsNotice = 'Ситуационные советы по механикам, а не статистический рейтинг. Приоритет учитывает позицию и число выбранных врагов. Покупка зависит от героя, тайминга и предметов противника.';
      return json(result);
    }
    if (url.pathname === '/api/meta' && request.method === 'GET') {
      const rank = url.searchParams.get('rank') || 'all';
      const position = Number(url.searchParams.get('position') || 1);
      if (!selection({ rank, position })) return json({ error: 'Неверный ранг или позиция.' }, 400);
      const latest = await query(env.DB, "SELECT key FROM events WHERE key LIKE 'patch:%' ORDER BY published DESC LIMIT 1").first();
      const knownPatch = latest?.key.slice(6) || null;
      const [{ role, data }] = await loadMeta(env.DB, rank, position);
      if (!data) return json({ error: 'Источник временно недоступен. Попробуйте позже.' }, 503);
      return json({ ...data, role, knownPatch, stale: isSliceStale(data, knownPatch), olderPatch: olderPatch(data.patch, knownPatch),
        sourceURL: metaURL(rank, role.key), methodologyURL: `${META_ORIGIN}/en/meta/methodology`,
        heroes: data.heroes.map(hero => ({ ...hero, image: HERO_IMAGES[hero.heroId] || null, url: `${META_ORIGIN}/en/heroes/${hero.slug}` })) });
    }
    if (url.pathname === '/api/patches' && request.method === 'GET') {
      const rows = (await query(env.DB, 'SELECT key,published,message FROM events WHERE message IS NOT NULL ORDER BY published DESC LIMIT 20').all()).results;
      return json({ events: rows });
    }
    if (url.pathname === '/api/profile' && ['GET', 'POST'].includes(request.method)) {
      if (request.method === 'POST' && request.headers.get('Origin') && request.headers.get('Origin') !== url.origin) return json({ error: 'Forbidden' }, 403);
      const user = await verifyInitData(request.headers.get('X-Telegram-Init-Data'), env.TELEGRAM_BOT_TOKEN);
      if (!user) return json({ error: 'Откройте приложение заново через меню Telegram-бота.' }, 401);
      const allowed = String(env.ALLOWED_USER_IDS || '').split(',').map(id => id.trim()).filter(Boolean);
      if (allowed.length && !allowed.includes(String(user.id))) return json({ error: 'Нет доступа.' }, 403);
      const key = `miniapp_prefs:${user.id}`;
      if (request.method === 'POST') {
        const body = await request.text();
        if (body.length > 1024) return json({ error: 'Слишком большой запрос.' }, 413);
        let value;
        try { value = JSON.parse(body); } catch { return json({ error: 'Неверный формат.' }, 400); }
        if (!selection(value)) return json({ error: 'Неверный ранг или позиция.' }, 400);
        await query(env.DB, 'INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, JSON.stringify({ rank: value.rank, position: value.position })).run();
      }
      const stored = await query(env.DB, 'SELECT value FROM meta WHERE key=?', key).first();
      let preferences = { position: 1, rank: 'all' };
      try { const value = JSON.parse(stored?.value); if (selection(value)) preferences = value; } catch { /* First visit. */ }
      const chat = await query(env.DB, 'SELECT active FROM chats WHERE id=?', user.id).first();
      return json({ name: user.first_name.slice(0, 80), preferences, subscribed: Boolean(chat?.active) });
    }
    return json({ error: 'Not found' }, 404);
  } catch (error) {
    if (error instanceof DataError) return json({ error: error.message, ...(error.clientFallback ? { clientFallback: true } : {}) }, error.status);
    console.warn('Mini App request failed');
    return json({ error: 'Не удалось загрузить данные. Попробуйте ещё раз.', ...(url.pathname === '/api/counters' && /^Counter source: /.test(error.message) ? { sourceIssue: error.message.slice(16) } : {}) }, 503);
  }
}

export const APP_URL = 'https://dota2bot.sdsbtw.workers.dev/app/';
export function appKeyboard(privateChat) {
  return { inline_keyboard: [[privateChat ? { text: '🎮 Открыть приложение', web_app: { url: APP_URL } }
    : { text: '🎮 Открыть в личном чате', url: 'https://t.me/dota2sds_bot?start=app' }]] };
}
