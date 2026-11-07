// Public OpenDota data; cache and a shared request budget protect the free API.
export const q = (db, sql, ...args) => db.prepare(sql).bind(...args);
export const epoch = () => Math.floor(Date.now() / 1000);
import { DataError } from '../public/app/dota-core.js';
export { DataError, accountID } from '../public/app/dota-core.js';
export async function cachedData(db, key, ttl, load) {
  const timestamp = epoch();
  let saved;
  try { saved = JSON.parse((await q(db, 'SELECT value FROM meta WHERE key=?', key).first())?.value); } catch { /* First request. */ }
  if (saved && timestamp - saved.fetchedAt < ttl) return { ...saved, stale: false };
  const owner = crypto.randomUUID();
  const lock = await q(db, 'INSERT INTO leases(key,owner,expires) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET owner=excluded.owner,expires=excluded.expires WHERE leases.expires<? RETURNING owner', key, owner, timestamp + 25, timestamp).first();
  if (!lock) {
    if (saved) return { ...saved, stale: true };
    throw new DataError('Данные уже загружаются. Повторите запрос через несколько секунд.', 429);
  }
  try {
    const result = { value: await load(), fetchedAt: timestamp };
    await q(db, 'INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, JSON.stringify(result)).run();
    return { ...result, stale: false };
  } catch (error) {
    // Old match records remain useful, but never silently pass them off as fresh.
    if (saved && timestamp - saved.fetchedAt < 86400) return { ...saved, stale: true };
    throw error;
  } finally { await q(db, 'DELETE FROM leases WHERE key=? AND owner=?', key, owner).run(); }
}
export async function openDota(db, path) {
  const timestamp = epoch();
  const limited = () => Object.assign(new DataError('OpenDota ограничил запросы. Попробуйте позже.', 429), { clientFallback: true });
  const cooldown = await q(db, 'SELECT value FROM meta WHERE key=?', 'opendota_retry_at').first();
  if (Number(cooldown?.value) > timestamp) throw limited();
  // Atomic counters shared by all visitors: <=45 requests/minute, <=2800/day.
  for (const [window, limit] of [[60, 45], [86400, 2800]]) {
    const key = `opendota_budget:${window}:${Math.floor(timestamp / window)}`;
    const row = await q(db, 'INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=CAST(meta.value AS INTEGER)+1 WHERE CAST(meta.value AS INTEGER)<? RETURNING value', key, '1', limit).first();
    if (!row) throw new DataError('Лимит источника исчерпан. Попробуйте позже.', 429);
  }
  const response = await fetch(`https://api.opendota.com/api${path}`, { signal: AbortSignal.timeout(12000), headers: { Accept: 'application/json' } });
  if (response.status === 404) throw new DataError('Данные не найдены в OpenDota. Проверьте ID или попробуйте позже.', 404);
  if (response.status === 429) {
    const wait = Math.min(3600, Math.max(60, Number(response.headers.get('Retry-After')) || 60));
    await q(db, 'INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', 'opendota_retry_at', String(timestamp + wait)).run();
    throw limited();
  }
  if (!response.ok) throw new DataError('OpenDota временно недоступен. Попробуйте позже.');
  return response.json();
}
