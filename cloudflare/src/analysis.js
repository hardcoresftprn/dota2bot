import { accountID, cachedData, openDota, DataError } from './dota-data.js';
import { HERO_IMAGES } from './hero-images.js';
import names from './names.js';
import { summarizePlayer, summarizeMatch as normalizeMatch } from '../public/app/dota-core.js';
export { assessSmurf } from '../public/app/dota-core.js';
const heroes = Object.fromEntries(Object.entries(names.heroes).map(([id, name]) => [id, { id: Number(id), name, image: HERO_IMAGES[id] || null }]));
export const summarizeMatch = match => normalizeMatch(match, heroes);
export async function analyzePlayer(db, raw) {
  const id = accountID(raw);
  if (!id) throw new DataError('Укажите Dota ID, SteamID64 или ссылку steamcommunity.com/profiles/…', 400);
  const cached = await cachedData(db, `player_analysis:v1:${id}`, 900, async () => {
    const results = await Promise.allSettled([openDota(db, `/players/${id}`), openDota(db, `/players/${id}/matches?limit=100&significant=1`), openDota(db, `/players/${id}/wl`)]);
    if (results.some(r => r.status === 'rejected')) throw results.find(r => r.status === 'rejected').reason;
    return summarizePlayer(id, ...results.map(r => r.value), heroes);
  });
  return { ...cached.value, fetchedAt: cached.fetchedAt, stale: cached.stale };
}
export async function analyzeMatch(db, raw) {
  if (!/^[1-9]\d{0,11}$/.test(raw || '')) throw new DataError('Укажите числовой ID матча (до 12 цифр).', 400);
  const cached = await cachedData(db, `match_analysis:v2:${raw}`, value => value.parsed ? 1800 : 30, async () => summarizeMatch(await openDota(db, `/matches/${raw}`)));
  return { ...cached.value, fetchedAt: cached.fetchedAt, stale: cached.stale };
}
