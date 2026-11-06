import { POSITIONS } from './meta.js';
import { HERO_IMAGES } from './hero-images.js';
import { now } from './content.js';
const q = (db, sql, ...args) => db.prepare(sql).bind(...args);
const KEY = 'counters:v1';
const TTL = 3600, MAX_AGE = 2 * 86400;
export const SOURCE = 'https://statsdota.com/en/counters/team';

export function parseCounterPage(html) {
  // Read public Next.js serialized props as JSON; never execute source scripts.
  const stream = [...html.matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g)].map(match => JSON.parse(match[1])).join('');
  let data;
  for (const line of stream.split('\n')) {
    try { const value = JSON.parse(line.slice(line.indexOf(':') + 1)); if (value?.[3]?.data?.heroes) data = value[3].data; } catch { /* Other Flight records aren't JSON props. */ }
  }
  const patch = /<title>[^<]*?\b(\d+\.\d{2}[a-z]?)\b/.exec(html)?.[1];
  if (!data || !Array.isArray(data.heroes) || data.heroes.length < 100 || !patch || !Number.isFinite(Date.parse(data.fetchedAt))) throw new Error('Counter catalogue unavailable');
  const heroes = data.heroes.filter(h => Number.isSafeInteger(h.id) && h.id > 0 && typeof h.name === 'string' && h.name.length < 80
    && /^[a-z0-9-]+$/.test(h.slug) && Array.isArray(h.pos) && h.pos.length === 5 && h.pos.every(n => Number.isFinite(n) && n >= 0 && n <= 100))
    .map(({ id, name, slug, pos }) => ({ id, name, slug, pos, image: HERO_IMAGES[id] || null }));
  if (heroes.length < 100) throw new Error('Invalid counter catalogue');
  return { heroes, patch, catalogueUpdatedAt: Math.floor(Date.parse(data.fetchedAt) / 1000) };
}
export function normalizeCells(cells, heroes) {
  if (!cells || typeof cells !== 'object' || Array.isArray(cells)) throw new Error('Invalid counter cells');
  const result = {};
  for (const enemy of heroes) {
    const row = {};
    for (const hero of heroes) {
      const cell = cells[enemy.id]?.[hero.id];
      if (hero.id !== enemy.id && Array.isArray(cell) && cell.length === 3 && cell.every(Number.isFinite)
        && Math.abs(cell[0]) <= 100 && cell[1] >= 0 && cell[1] <= 100 && Number.isSafeInteger(cell[2]) && cell[2] >= 150) row[hero.id] = cell;
    }
    result[enemy.id] = row;
  }
  if (Object.values(result).filter(row => Object.keys(row).length > 20).length < 80) throw new Error('Counter sample too small');
  return result;
}
export async function loadCounters(db, timestamp = now()) {
  let cached;
  try { cached = JSON.parse((await q(db, 'SELECT value FROM meta WHERE key=?', KEY).first())?.value); } catch { /* Empty cache. */ }
  const usable = cached?.heroes?.length && cached?.cells && timestamp - cached.checkedAt < MAX_AGE;
  if (usable && timestamp - cached.checkedAt < TTL) return { ...cached, stale: false };
  if (cached?.retryAt > timestamp) { if (usable) return { ...cached, stale: true }; throw new Error('Counter source backoff'); }
  const owner = crypto.randomUUID();
  const lock = await q(db, `INSERT INTO leases(key,owner,expires) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET owner=excluded.owner,expires=excluded.expires WHERE leases.expires<? RETURNING owner`, KEY, owner, timestamp + 35, timestamp).first();
  if (!lock) { if (usable) return { ...cached, stale: true }; throw new Error('Counter cache is warming'); }
  try {
    try {
      const [page, response] = await Promise.all([fetch(SOURCE, { signal: AbortSignal.timeout(12000) }), fetch('https://statsdota.com/api/counter-cells', { signal: AbortSignal.timeout(12000) })]);
      if (!page.ok || !response.ok) throw new Error('Counter source unavailable');
      const catalogue = parseCounterPage(await page.text());
      const cells = normalizeCells((await response.json()).cells, catalogue.heroes);
      const value = { ...catalogue, cells, checkedAt: timestamp };
      await q(db, 'INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', KEY, JSON.stringify(value)).run();
      return { ...value, stale: false };
    } catch {
      await q(db, 'INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', KEY, JSON.stringify({ ...(cached || {}), retryAt: timestamp + 300 })).run();
      if (usable) return { ...cached, stale: true };
      throw new Error('Counter source unavailable');
    }
  } finally { await q(db, 'DELETE FROM leases WHERE key=? AND owner=?', KEY, owner).run(); }
}
export function rankCounters(data, enemies, position) {
  if (!Array.isArray(enemies) || enemies.length < 1 || enemies.length > 5 || new Set(enemies).size !== enemies.length
    || enemies.some(id => !Number.isSafeInteger(id) || !data.heroes.some(hero => hero.id === id)) || !Number.isInteger(position) || position < 1 || position > 5) throw new Error('Invalid draft');
  // Position frequency filters candidates. Matchup cells themselves cover all roles/ranks.
  const ranked = data.heroes.filter(hero => !enemies.includes(hero.id) && hero.pos[position - 1] >= 15).map(hero => {
    const pairs = enemies.map(enemyId => {
      const cell = data.cells[enemyId]?.[hero.id];
      return cell ? { enemyId, advantage: cell[0], winrate: cell[1], matches: cell[2] } : null;
    });
    if (pairs.some(pair => !pair)) return null; // Never hide a missing enemy matchup.
    return { ...hero, positionShare: hero.pos[position - 1], pairs, advantage: Math.round(pairs.reduce((n, p) => n + p.advantage, 0) / pairs.length * 10) / 10,
      minMatches: Math.min(...pairs.map(p => p.matches)), url: `https://statsdota.com/en/heroes/${hero.slug}` };
  }).filter(Boolean).sort((a, b) => b.advantage - a.advantage || b.minMatches - a.minMatches).slice(0, 5);
  return { heroes: ranked, enemies: enemies.map(id => data.heroes.find(h => h.id === id)), role: POSITIONS[position - 1], patch: data.patch,
    checkedAt: data.checkedAt, catalogueUpdatedAt: data.catalogueUpdatedAt, stale: data.stale, sourceURL: SOURCE };
}
