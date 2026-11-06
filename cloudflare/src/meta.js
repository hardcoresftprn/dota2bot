import { escape, now } from './content.js';

export const META_ORIGIN = 'https://statsdota.com';
export const CACHE_TTL = 3600;
export const MAX_CACHE_AGE = 7 * 86400;
export const POSITIONS = [
  { id: 1, key: 'carry', name: 'Керри', hint: 'Сохраняйте темп фарма и выходите на драки с ключевыми предметами.' },
  { id: 2, key: 'mid', name: 'Мид', hint: 'Используйте уровни, контроль рун и первые предметы для давления на карту.' },
  { id: 3, key: 'offlane', name: 'Оффлейн', hint: 'Создавайте пространство для керри: инициируйте драки и давите на объекты.' },
  { id: 4, key: 'soft-support', name: 'Поддержка', hint: 'Помогайте активным линиям и готовьте драки обзором и перемещениями.' },
  { id: 5, key: 'hard-support', name: 'Полная поддержка', hint: 'Помогайте керри на линии, обеспечивайте обзор и сохраняйте ресурсы для команды.' },
];
export const RANKS = { all: 'Все ранги', herald: 'Рекрут', guardian: 'Страж', crusader: 'Рыцарь', archon: 'Герой', legend: 'Легенда', ancient: 'Властелин', divine: 'Божество', immortal: 'Титан' };
const roleAliases = { carry: 1, керри: 1, mid: 2, мид: 2, offlane: 3, оффлейн: 3, support: 4, поддержка: 4, hard: 5 };
const rankAliases = Object.fromEntries(Object.entries(RANKS).map(([key, name]) => [name.toLowerCase(), key]));
const query = (db, sql, ...args) => db.prepare(sql).bind(...args);
const cacheKey = (rank, position) => `hero_meta:v1:${rank}:${position}`;
export const metaURL = (rank, position) => `${META_ORIGIN}/en/meta/${rank}/${position}`;
const usage = 'Примеры: /meta — все пять позиций; /meta 2 — мид; /meta 1 legend — керри на Легенде.\nРанги: herald, guardian, crusader, archon, legend, ancient, divine, immortal. Можно выбрать кнопками.';

export function parseMetaArgs(text) {
  const args = text.trim().split(/\s+/).slice(1);
  let position = 0, rank = 'all', roleSet = false, rankSet = false;
  for (const raw of args) {
    const arg = raw.toLowerCase();
    const role = /^[1-5]$/.test(arg) ? Number(arg) : roleAliases[arg];
    const bracket = Object.hasOwn(RANKS, arg) ? arg : rankAliases[arg];
    if (role && !roleSet) { position = role; roleSet = true; }
    else if (bracket && !rankSet) { rank = bracket; rankSet = true; }
    else return { error: usage };
  }
  return { position, rank };
}
export function parseMetaCallback(data = '') {
  const match = /^(meta|meta-ranks):([a-z]+):([0-5])$/.exec(data);
  if (!match || !Object.hasOwn(RANKS, match[2])) return null;
  return { ranksMenu: match[1] === 'meta-ranks', rank: match[2], position: Number(match[3]) };
}
export function metaKeyboard(rank, position) {
  const button = role => ({ text: `${role.id} · ${role.name}`, callback_data: `meta:${rank}:${role.id}` });
  return { inline_keyboard: [POSITIONS.slice(0, 3).map(button), POSITIONS.slice(3).map(button),
    [{ text: 'Все позиции', callback_data: `meta:${rank}:0` }, { text: `Ранг: ${RANKS[rank]}`, callback_data: `meta-ranks:${rank}:${position}` }]] };
}
export function rankMenu(rank, position) {
  const buttons = Object.entries(RANKS).map(([key, name]) => ({ text: `${key === rank ? '✓ ' : ''}${name}`, callback_data: `meta:${key}:${position}` }));
  return { text: '🎯 <b>Выберите ранг для меты</b>\nСтатистика будет отфильтрована по выбранному рангу и позиции.',
    reply_markup: { inline_keyboard: [buttons.slice(0, 3), buttons.slice(3, 6), buttons.slice(6)] } };
}

export function normalizeSlice(data, rank, position, checkedAt = now()) {
  if (!data || data.position !== position || ![rank, 'all'].includes(data.rank)
      || !/^\d+\.\d{2}[a-z]?$/.test(data.patch || '') || data.unavailable || !Array.isArray(data.rows)) throw new Error('Meta scope unavailable');
  const updated = Date.parse(data.updatedAt || data.fetchedAt);
  const sampleEnd = Date.parse(data.sampleTo);
  if (!Number.isFinite(updated) || !Number.isFinite(sampleEnd) || !/^\d{4}-\d{2}-\d{2}$/.test(data.sampleFrom || '')
      || updated > (checkedAt + 86400) * 1000 || !Number.isFinite(data.sampleMatches) || data.sampleMatches <= 0) throw new Error('Invalid meta timestamps');
  const valid = data.rows.filter(row => Number.isSafeInteger(row.heroId) && typeof row.name === 'string' && row.name.length > 0 && row.name.length <= 70
    && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(row.slug || '') && ['S', 'A', 'B', 'C', 'D'].includes(row.tier)
    && Number.isFinite(row.score) && row.score >= 0 && row.score <= 100
    && Number.isFinite(row.winrate) && row.winrate >= 0 && row.winrate <= 100
    && Number.isFinite(row.pickRate) && row.pickRate >= 0 && row.pickRate <= 100
    && Number.isFinite(row.matches) && row.matches >= Math.max(150, Number(data.minGames) || 0));
  // The source already excludes low samples and niche/rare picks from rows.
  const unique = new Map();
  for (const row of valid) if (!unique.has(row.heroId)) unique.set(row.heroId, row);
  const heroes = [...unique.values()].sort((a, b) => b.score - a.score).slice(0, 5)
    .map(({ heroId, name, slug, tier, score, winrate, pickRate, matches }) => ({ heroId, name, slug, tier, score, winrate, pickRate, matches }));
  if (!heroes.length) throw new Error('No sufficiently sampled heroes');
  return { rank: data.rank, requestedRank: rank, position, patch: data.patch, updatedAt: Math.floor(updated / 1000),
    sampleFrom: data.sampleFrom, sampleTo: data.sampleTo, sampleMatches: data.sampleMatches,
    fallback: Boolean(data.fallback) || data.rank !== rank, heroes, checkedAt };
}
async function fetchSlice(rank, position, checkedAt) {
  const url = new URL('/api/meta-board', META_ORIGIN);
  url.search = new URLSearchParams({ rank, position, lang: 'en', v: 'board' });
  const response = await fetch(url.toString(), { signal: AbortSignal.timeout(12000), headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error('Meta source unavailable');
  return normalizeSlice(await response.json(), rank, position, checkedAt);
}
async function refreshSlice(db, rank, position, cached, checkedAt) {
  const key = cacheKey(rank, position);
  const owner = crypto.randomUUID();
  const lock = await query(db, `INSERT INTO leases(key,owner,expires) VALUES(?,?,?)
    ON CONFLICT(key) DO UPDATE SET owner=excluded.owner,expires=excluded.expires WHERE leases.expires<? RETURNING owner`, key, owner, checkedAt + 30, checkedAt).first();
  if (!lock) return cached || null;
  try {
    let value;
    try { value = await fetchSlice(rank, position, checkedAt); }
    catch { value = { ...(cached || {}), failedAt: checkedAt, retryAt: checkedAt + 300 }; }
    await query(db, 'INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, JSON.stringify(value)).run();
    return value;
  } finally { await query(db, 'DELETE FROM leases WHERE key=? AND owner=?', key, owner).run(); }
}
export async function loadMeta(db, rank, selected, checkedAt = now()) {
  if (!Object.hasOwn(RANKS, rank) || !Number.isInteger(selected) || selected < 0 || selected > 5) throw new Error('Invalid meta selection');
  const positions = selected ? POSITIONS.filter(role => role.id === selected) : POSITIONS;
  const keys = positions.map(role => cacheKey(rank, role.key));
  const stored = (await query(db, 'SELECT key,value FROM meta WHERE key IN (SELECT value FROM json_each(?))', JSON.stringify(keys)).all()).results;
  const cache = new Map();
  for (const row of stored) { try { cache.set(row.key, JSON.parse(row.value)); } catch { /* Re-fetch corrupt cache. */ } }
  const results = await Promise.allSettled(positions.map(async role => {
    const cached = cache.get(cacheKey(rank, role.key));
    if (cached && ((cached.retryAt || 0) > checkedAt || (!cached.failedAt && checkedAt - cached.checkedAt < CACHE_TTL))) return cached;
    return refreshSlice(db, rank, role.key, cached, checkedAt);
  }));
  return positions.map((role, index) => {
    const value = results[index].status === 'fulfilled' ? results[index].value : cache.get(cacheKey(rank, role.key));
    return { role, data: value?.heroes?.length && checkedAt - value.checkedAt < MAX_CACHE_AGE ? value : null };
  });
}
export function olderPatch(source, known) {
  const parts = version => /^(\d+)\.(\d{2})([a-z]?)$/.exec(version || '');
  const a = parts(source), b = parts(known);
  if (!a || !b) return false;
  for (let i = 1; i <= 2; i++) if (Number(a[i]) !== Number(b[i])) return Number(a[i]) < Number(b[i]);
  return a[3] < b[3];
}
export function isSliceStale(data, knownPatch, checkedAt = now()) {
  return Boolean(data.failedAt) || checkedAt - data.checkedAt >= CACHE_TTL || checkedAt - data.updatedAt > 2 * 86400
    || checkedAt - Date.parse(data.sampleTo) / 1000 > 4 * 86400 || olderPatch(data.patch, knownPatch);
}
const number = value => Math.round(value).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const percent = value => value.toFixed(1).replace('.', ',') + '%';
const date = value => value.split('-').reverse().join('.');
const timestamp = value => new Date(value * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
export function renderMeta(slices, rank, selected, knownPatch, checkedAt = now()) {
  const available = slices.filter(slice => slice.data);
  const patches = [...new Set(available.map(slice => slice.data.patch))];
  const periods = [...new Set(available.map(slice => `${slice.data.sampleFrom} — ${slice.data.sampleTo}`))];
  const lines = [`🎯 <b>${selected ? `Мета: ${POSITIONS[selected - 1].name}, позиция ${selected}` : 'Мета по пяти позициям'}</b>`, `Ранг: ${RANKS[rank]}`];
  if (patches.length === 1) lines.push(`Патч источника: ${escape(patches[0])}`);
  if (periods.length === 1) lines.push(`Период: ${date(available[0].data.sampleFrom)}–${date(available[0].data.sampleTo)}`);
  lines.push('');
  let anyStale = false;
  for (const { role, data } of slices) {
    if (!data) { lines.push(`<b>${role.id} · ${role.name}</b>`, 'Статистика временно недоступна.', ''); continue; }
    const stale = isSliceStale(data, knownPatch, checkedAt);
    anyStale ||= stale;
    if (!selected) lines.push(`<b>${role.id} · ${role.name}${stale ? ' ⚠️' : ''}</b>`);
    if (stale && selected) lines.push('⚠️ Данные устарели или обновление источника не подтверждено.');
    if (olderPatch(data.patch, knownPatch)) lines.push(`Источник ещё на ${escape(data.patch)}, у Valve уже ${escape(knownPatch)}.`);
    if (patches.length > 1) lines.push(`Патч: ${escape(data.patch)}`);
    if (data.fallback) lines.push(data.rank === 'all' && rank !== 'all'
      ? 'Источник расширил выборку до всех рангов: точный срез выбранного ранга недоступен.'
      : 'Источник расширил выборку: точный срез выбранного ранга недоступен.');
    if (periods.length > 1) lines.push(`Период: ${date(data.sampleFrom)}–${date(data.sampleTo)}`);
    data.heroes.slice(0, selected ? 5 : 3).forEach((hero, index) => {
      if (selected) lines.push(`${index + 1}. <a href="${META_ORIGIN}/en/heroes/${hero.slug}">${escape(hero.name)}</a> · ${hero.tier} · ${hero.score}/100`,
        `Победы ${percent(hero.winrate)} · пики ${percent(hero.pickRate)} · ${number(hero.matches)} игр`);
      else lines.push(`• ${escape(hero.name)} — ${percent(hero.winrate)} · ${hero.tier}`);
    });
    if (selected) lines.push('', `Выборка позиции: ≈${number(data.sampleMatches)} матчей.`, `Данные источника: ${timestamp(data.updatedAt)}`, '', role.hint);
    lines.push('');
  }
  if (!selected && available.length) lines.push(`Данные источника: ${timestamp(Math.min(...available.map(slice => slice.data.updatedAt)))}`);
  if (anyStale && !selected) lines.push('⚠️ Отмеченные позиции показаны из сохранённой статистики; актуальность не подтверждена.');
  lines.push('Порядок — рейтинг StatsDota: винрейт с поправкой на выборку и популярность. Кеш — 1 час.',
    `<a href="${selected ? metaURL(rank, POSITIONS[selected - 1].key) : `${META_ORIGIN}/en/meta/${rank}/carry`}">Источник: StatsDota ↗</a>`,
    '<a href="https://statsdota.com/en/meta/methodology">Методика расчёта ↗</a>');
  return { text: lines.join('\n'), reply_markup: metaKeyboard(rank, selected) };
}
export async function metaReply(db, rank, selected) {
  const slices = await loadMeta(db, rank, selected);
  const latest = await query(db, "SELECT key FROM events WHERE key LIKE 'patch:%' ORDER BY published DESC LIMIT 1").first();
  return renderMeta(slices, rank, selected, latest?.key.slice(6));
}
