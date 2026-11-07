import { accountID, summarizePlayer, summarizeMatch, buildStages, DataError } from './dota-core.js';

// Use OpenDota's supported public CORS API if the Worker's shared egress IP is limited.
// No Telegram credentials, server secrets, arbitrary hosts, or response uploads.
const cache = new Map();
const source = 'https://api.opendota.com/api';
async function readJSON(path, signal) {
  const response = await fetch(path, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000), credentials: 'omit' });
  if (response.status === 429) throw new DataError('OpenDota ограничил запросы. Попробуйте позже.', 429);
  if (response.status === 404) throw new DataError('Данные не найдены в OpenDota. Проверьте ID.', 404);
  if (!response.ok) throw new DataError('Не удалось получить данные OpenDota. Попробуйте позже.');
  return response.json();
}
export async function clientPublicData(path, { signal } = {}) {
  const url = new URL(path, 'https://app.invalid');
  const timestamp = Math.floor(Date.now() / 1000);
  const saved = cache.get(url.pathname + url.search);
  if (saved?.expiresAt > timestamp) return saved.value;
  let value, ttl = 900;
  if (url.pathname === '/api/analysis/player' || url.pathname === '/api/analysis/match') {
    const isPlayer = url.pathname.endsWith('/player');
    const id = isPlayer ? accountID(url.searchParams.get('id')) : url.searchParams.get('id');
    if (!id || (!isPlayer && !/^[1-9]\d{0,11}$/.test(id))) throw new DataError('Проверьте ID игрока или матча.', 400);
    const catalogue = await readJSON('/api/heroes', signal);
    const heroes = Object.fromEntries(catalogue.heroes.map(hero => [hero.id, hero]));
    if (isPlayer) {
      const results = await Promise.allSettled([readJSON(`${source}/players/${id}`, signal), readJSON(`${source}/players/${id}/matches?limit=100&significant=1`, signal), readJSON(`${source}/players/${id}/wl`, signal)]);
      if (results.some(result => result.status === 'rejected')) throw results.find(result => result.status === 'rejected').reason;
      value = summarizePlayer(id, ...results.map(result => result.value), heroes);
    } else {
      value = summarizeMatch(await readJSON(`${source}/matches/${id}`, signal), heroes); ttl = 1800;
    }
  } else if (url.pathname === '/api/build') {
    // The Worker validates all draft parameters and supplies only public catalogue data.
    const context = await readJSON('/api/build-context' + url.search, signal);
    const popularity = await readJSON(`${source}/heroes/${context.hero.id}/itemPopularity`, signal);
    const { items, ...metadata } = context;
    value = { ...metadata, stages: buildStages(popularity, items) }; ttl = 21600;
  } else throw new DataError('Неподдерживаемый источник данных.', 400);
  value = { ...value, fetchedAt: timestamp, stale: false };
  if (cache.size >= 20) cache.delete(cache.keys().next().value);
  cache.set(url.pathname + url.search, { value, expiresAt: timestamp + ttl });
  return value;
}
