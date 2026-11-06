import { DOTA, STEAM, getJSON, loadPatch, newsEvent, summarize, now } from './content.js';
import { metaReply, parseMetaArgs, parseMetaCallback, rankMenu } from './meta.js';

export const statement = (db, sql, ...args) => db.prepare(sql).bind(...args);
export const getMeta = async (db, key) => (await statement(db, 'SELECT value FROM meta WHERE key=?', key).first())?.value;
export const setMeta = (db, key, value) => statement(db,
  'INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, String(value)).run();
const seen = async (db, key) => Boolean(await statement(db, 'SELECT key FROM events WHERE key=?', key).first());

export async function saveEvent(db, event, message, broadcast = true) {
  // The INSERT trigger creates the per-chat outbox in the same transaction.
  // INSERT OR IGNORE fires no trigger on a duplicate canonical event ID.
  await statement(db, 'INSERT OR IGNORE INTO events(key,published,message,broadcast) VALUES(?,?,?,?)',
    event.key, event.published, message, Number(broadcast)).run();
}
async function archive(db, rows) {
  if (!rows.length) return;
  await statement(db, `INSERT OR IGNORE INTO events(key,published)
    SELECT json_extract(value,'$.key'),json_extract(value,'$.published') FROM json_each(?)`, JSON.stringify(rows)).run();
}
export async function checkPatches(env) {
  const db = env.DB;
  const data = await getJSON(DOTA + 'patchnoteslist');
  if (data.success !== true || !Array.isArray(data.patches) || !data.patches.length
      || data.patches.some(p => !/^\d+\.\d{2}[a-z]?$/.test(p.patch_number) || !Number.isInteger(p.patch_timestamp))) throw new Error('Invalid patch list');
  const patches = data.patches.sort((a, b) => a.patch_timestamp - b.patch_timestamp);
  if (!await getMeta(db, 'patches_initialized')) {
    const event = await loadPatch(patches.at(-1));
    const message = await summarize(event, env);
    await saveEvent(db, event, message, false);
    await archive(db, patches.slice(0, -1).map(p => ({ key: `patch:${p.patch_number}`, published: p.patch_timestamp })));
    await setMeta(db, 'patches_initialized', '1');
  } else {
    const keys = patches.map(p => `patch:${p.patch_number}`);
    const known = new Set((await statement(db, 'SELECT key FROM events WHERE key IN (SELECT value FROM json_each(?))', JSON.stringify(keys)).all()).results.map(row => row.key));
    // One full patch per invocation keeps work within the Free CPU/query limits.
    const pending = patches.find(p => !known.has(`patch:${p.patch_number}`));
    if (pending) {
      const event = await loadPatch(pending);
      await saveEvent(db, event, await summarize(event, env));
    }
  }
  await setMeta(db, 'patches_checked', now());
}
export async function checkNews(env) {
  const db = env.DB;
  const state = Object.fromEntries((await statement(db, "SELECT key,value FROM meta WHERE key IN ('news_cursor','news_scan_end','news_scan_started')").all()).results.map(row => [row.key, row.value]));
  const cursor = state.news_cursor;
  const since = cursor ? Number(cursor) - 86400 : null;
  const scanStarted = state.news_scan_started || String(now());
  if (cursor && !state.news_scan_started) await setMeta(db, 'news_scan_started', scanStarted);
  const url = new URL(STEAM);
  url.search = new URLSearchParams({ appid: '570', count: '20', maxlength: '0', feeds: 'steam_community_announcements',
    ...(state.news_scan_end ? { enddate: state.news_scan_end } : {}) });
  const data = await getJSON(url.toString());
  const page = data.appnews?.newsitems;
  if (!Array.isArray(page)) throw new Error('Invalid Steam news');
  const rows = page.filter(row => row.appid === 570 && row.feedname === 'steam_community_announcements'
    && (since === null || row.date >= since)).sort((a, b) => a.date - b.date);
  if (!cursor) {
    await archive(db, rows.map(row => ({ key: `news:${row.gid}`, published: row.date })));
    await setMeta(db, 'news_cursor', now());
  } else {
    const keys = rows.map(row => `news:${row.gid}`);
    const known = new Set((await statement(db, 'SELECT key FROM events WHERE key IN (SELECT value FROM json_each(?))', JSON.stringify(keys)).all()).results.map(row => row.key));
    let handled = 0;
    for (const row of rows) {
      const articleKey = `news:${row.gid}`;
      if (known.has(articleKey)) continue;
      let event = newsEvent(row);
      if (!await seen(db, event.key)) {
        if (event.version) event = await loadPatch({ patch_number: event.version, patch_timestamp: row.date });
        await saveEvent(db, event, await summarize(event, env));
      }
      await archive(db, [{ key: articleKey, published: row.date }]);
      // Resume this exact time window next run if more articles remain.
      known.add(articleKey);
      if (++handled === 2 && rows.some(item => !known.has(`news:${item.gid}`))) {
        await setMeta(db, 'news_checked', now());
        return;
      }
    }
    const oldest = page.length ? Math.min(...page.map(row => Number(row.date))) : 0;
    if (page.length === 20 && oldest >= since) {
      await setMeta(db, 'news_scan_end', oldest - 1);
    } else {
      await db.batch([
        statement(db, 'INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', 'news_cursor', scanStarted),
        statement(db, "DELETE FROM meta WHERE key IN ('news_scan_end','news_scan_started')"),
      ]);
    }
  }
  await setMeta(db, 'news_checked', now());
}

export class TelegramError extends Error {
  constructor(code, retryAfter = 0, description = '') { super(`Telegram ${code}`); this.code = code; this.retryAfter = retryAfter; this.description = description; }
}
export async function telegram(env, method, params) {
  // Never log the URL: it contains the bot token.
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params), signal: AbortSignal.timeout(15000),
  });
  let data;
  try { data = await response.json(); } catch { throw new TelegramError(response.status); }
  if (!data.ok) throw new TelegramError(data.error_code || response.status, data.parameters?.retry_after || 0, data.description || '');
  return data.result;
}
const send = (env, chatID, text, extra = {}) => telegram(env, 'sendMessage', { chat_id: chatID, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...extra });
export async function deliver(env) {
  const db = env.DB;
  await statement(db, "UPDATE deliveries SET status='uncertain' WHERE status='sending' AND started<?", now() - 300).run();
  const pending = (await statement(db, `SELECT d.event_key,d.chat_id,e.message FROM deliveries d
    JOIN events e ON e.key=d.event_key JOIN chats c ON c.id=d.chat_id
    WHERE d.status='pending' AND d.next_attempt<=? AND c.active=1 ORDER BY e.published,d.chat_id LIMIT 4`, now()).all()).results;
  const perChat = new Set();
  for (const row of pending) {
    if (perChat.has(row.chat_id)) continue;
    perChat.add(row.chat_id);
    const claim = await statement(db, "UPDATE deliveries SET status='sending',started=? WHERE event_key=? AND chat_id=? AND status='pending' RETURNING event_key", now(), row.event_key, row.chat_id).first();
    if (!claim) continue;
    let status = 'sent', retryAt = 0;
    try { await send(env, row.chat_id, row.message); }
    catch (error) {
      if (error instanceof TelegramError && error.code === 429) {
        status = 'pending'; retryAt = now() + Math.max(5, error.retryAfter);
      } else if (error instanceof TelegramError && error.code === 403) {
        status = 'blocked';
        await db.batch([
          statement(db, 'UPDATE chats SET active=0 WHERE id=?', row.chat_id),
          statement(db, "UPDATE deliveries SET status='cancelled' WHERE chat_id=? AND status='pending'", row.chat_id),
        ]);
      } else {
        status = error instanceof TelegramError && error.code < 500 ? 'failed' : 'uncertain';
        console.warn('Telegram delivery not confirmed', status);
      }
    }
    await statement(db, 'UPDATE deliveries SET status=?,next_attempt=? WHERE event_key=? AND chat_id=?', status, retryAt, row.event_key, row.chat_id).run();
    if (retryAt) return; // Respect Telegram's bot-wide flood limit.
  }
}

export async function scheduled(env, timestamp = Date.now()) {
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error('Missing TELEGRAM_BOT_TOKEN');
  const owner = crypto.randomUUID();
  const lock = await statement(env.DB, `INSERT INTO leases(key,owner,expires) VALUES('cron',?,?)
    ON CONFLICT(key) DO UPDATE SET owner=excluded.owner,expires=excluded.expires WHERE leases.expires<? RETURNING owner`, owner, now() + 240, now()).first();
  if (!lock) return;
  try {
    // Alternate sources: each is checked every 10 minutes; outbox every 5.
    const source = Math.floor(timestamp / 300000) % 2 === 0 ? checkPatches : checkNews;
    try { await source(env); }
    catch { console.warn('Source check failed; will retry on next scheduled run'); }
    await deliver(env);
    await statement(env.DB, 'DELETE FROM updates WHERE received<?', now() - 7 * 86400).run();
  } finally {
    await statement(env.DB, "DELETE FROM leases WHERE key='cron' AND owner=?", owner).run();
  }
}
async function isAdmin(env, message) {
  if (message.chat.type === 'private' || message.sender_chat?.id === message.chat.id) return true;
  if (!message.from?.id) return false;
  const member = await telegram(env, 'getChatMember', { chat_id: message.chat.id, user_id: message.from.id });
  return ['creator', 'administrator'].includes(member.status);
}
export async function handleUpdate(env, update) {
  const callback = update.callback_query;
  const selection = callback ? parseMetaCallback(callback.data) : null;
  const message = callback ? callback.message : update.message;
  if ((!callback && !message?.text?.startsWith('/')) || (callback && !selection)
      || !Number.isSafeInteger(update.update_id) || !Number.isSafeInteger(message?.chat?.id)) return;
  const commandText = callback ? 'meta' : message.text.split(/\s/)[0].slice(1);
  const [command, mention] = commandText.split('@');
  if (!['start', 'stop', 'latest', 'status', 'help', 'meta'].includes(command)) return;
  if (mention) {
    let username = await getMeta(env.DB, 'bot_username');
    if (!username) { username = (await telegram(env, 'getMe', {})).username; await setMeta(env.DB, 'bot_username', username); }
    if (mention.toLowerCase() !== username.toLowerCase()) return;
  }
  const allowed = String(env.ALLOWED_USER_IDS || '').split(',').map(id => id.trim()).filter(Boolean);
  const actor = callback ? callback.from : message.from;
  if (allowed.length && !allowed.includes(String(actor?.id))) return;
  if (callback) {
    try { await telegram(env, 'answerCallbackQuery', { callback_query_id: callback.id }); }
    catch { /* A stale callback can still have a useful cached result. */ }
  }
  const receipt = await statement(env.DB, 'INSERT OR IGNORE INTO updates(id,received) VALUES(?,?) RETURNING id', update.update_id, now()).first();
  if (!receipt) return;
  const chatID = message.chat.id;
  if (command === 'meta') {
    const params = selection || parseMetaArgs(message.text);
    const result = params.error ? { text: params.error }
      : params.ranksMenu ? rankMenu(params.rank, params.position)
        : await metaReply(env.DB, params.rank, params.position);
    if (callback) {
      try {
        await telegram(env, 'editMessageText', { chat_id: chatID, message_id: message.message_id,
          text: result.text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: result.reply_markup });
      } catch (error) {
        if (!(error instanceof TelegramError && error.code === 400 && /message is not modified/i.test(error.description))) throw error;
      }
    } else await send(env, chatID, result.text, result.reply_markup ? { reply_markup: result.reply_markup } : {});
    return;
  }
  if (['start', 'stop'].includes(command) && !await isAdmin(env, message)) {
    await send(env, chatID, 'Подписку группы включает и выключает её администратор.'); return;
  }
  let answer;
  if (command === 'start') {
    await statement(env.DB, 'INSERT INTO chats(id,active) VALUES(?,1) ON CONFLICT(id) DO UPDATE SET active=1', chatID).run();
    answer = '✅ Подписка включена. Пришлю новые важные обновления Dota 2 с разбором и ссылкой Valve.\n\nМета по пяти позициям: /meta\nПоследний разбор: /latest\nОтключить: /stop';
  } else if (command === 'stop') {
    await env.DB.batch([
      statement(env.DB, 'INSERT INTO chats(id,active) VALUES(?,0) ON CONFLICT(id) DO UPDATE SET active=0', chatID),
      statement(env.DB, "UPDATE deliveries SET status='cancelled' WHERE chat_id=? AND status='pending'", chatID),
    ]);
    answer = '🔕 Рассылка отключена. Вернуться: /start';
  } else if (command === 'latest') {
    answer = (await statement(env.DB, 'SELECT message FROM events WHERE message IS NOT NULL ORDER BY published DESC LIMIT 1').first())?.message
      || 'Готовлю первый разбор. После проверки источников он появится здесь; статус: /status';
  } else if (command === 'status') {
    const active = (await statement(env.DB, 'SELECT active FROM chats WHERE id=?', chatID).first())?.active;
    const rows = (await statement(env.DB, "SELECT key,value FROM meta WHERE key IN ('patches_checked','news_checked')").all()).results;
    const checked = Object.fromEntries(rows.map(row => [row.key, row.value]));
    const stamp = key => checked[key] ? new Date(Number(checked[key]) * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
      + (now() - Number(checked[key]) > 1200 ? ' ⚠️ давно не было успешной проверки' : '') : 'ожидание первой проверки';
    answer = `Рассылка: ${active ? 'включена ✅' : 'выключена 🔕'}\nПроверка каждого источника: каждые 10 мин.\nValve: ${stamp('patches_checked')}\nSteam: ${stamp('news_checked')}`;
  } else {
    answer = '🎮 <b>Dota Patch Watch</b>\n\n/start — подписаться\n/stop — отписаться\n/meta — актуальная мета по пяти позициям\n/latest — запросить последний разбор\n/status — подписка и состояние источников\n\n<b>Мета</b>\nВыберите позицию и ранг кнопками под /meta. Примеры: /meta 2 — мид; /meta 1 legend — керри на Легенде. Источник StatsDota, кеш 1 час. Мета приходит только по вашему запросу.\n\nПроверяю Valve и Steam каждые 10 минут. Крупные патчи, новые герои, баланс и рейтинг. Косметика, турниры и обычные багфиксы не входят в рассылку.\n\nВ общем чате администратор отправляет /start@имя_бота. /latest повторно показывает разбор только по вашему запросу. Выводы о влиянии — оценка по примечаниям, без выдуманной статистики.';
  }
  await send(env, chatID, answer);
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (request.method === 'GET' && path === '/healthz') return new Response('ok\n');
    if (request.method !== 'POST' || path !== '/telegram') return new Response('Not found', { status: 404 });
    if (!env.TELEGRAM_WEBHOOK_SECRET || request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.TELEGRAM_WEBHOOK_SECRET) return new Response('Forbidden', { status: 403 });
    const body = await request.text();
    if (body.length > 131072) return new Response('Too large', { status: 413 });
    let update;
    try { update = JSON.parse(body); } catch { return new Response('Invalid JSON', { status: 400 }); }
    try { await handleUpdate(env, update); }
    catch { console.warn('Telegram command failed'); return new Response('Temporary error', { status: 503 }); }
    return new Response('ok');
  },
  async scheduled(controller, env, ctx) { ctx.waitUntil(scheduled(env, controller.scheduledTime)); },
};
