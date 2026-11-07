// Shared pure transformations for the Worker and the browser. No credentials or network access.
export class DataError extends Error {
  constructor(message, status = 503) { super(message); this.status = status; }
}
export function accountID(raw) {
  const value = String(raw || '').trim();
  const match = /^https:\/\/steamcommunity\.com\/profiles\/(\d{17})\/?$/.exec(value);
  const id = match?.[1] || value;
  if (!/^\d{1,17}$/.test(id)) return null;
  const number = BigInt(id);
  const account = id.length === 17 ? number - 76561197960265728n : number;
  return account > 0n && account < 4294967295n ? Number(account) : null;
}
const finite = value => Number.isFinite(value) && value >= 0 ? value : null;
const won = match => typeof match.radiant_win === 'boolean' && Number.isInteger(match.player_slot) ? (match.player_slot < 128) === match.radiant_win : null;
const mean = values => values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length * 10) / 10 : null;
function hero(id, heroes) { return heroes[id] || { id, name: `Герой ${id}`, image: null }; }
export function matchSummary(match, heroes = {}) {
  return { id: match.match_id, hero: hero(match.hero_id, heroes), startTime: finite(match.start_time), duration: finite(match.duration), won: won(match),
    kills: finite(match.kills), deaths: finite(match.deaths), assists: finite(match.assists), gpm: finite(match.gold_per_min), xpm: finite(match.xp_per_min),
    gameMode: match.game_mode ?? null, lobbyType: match.lobby_type ?? null };
}
export function assessSmurf(matches, lifetimeGames) {
  // Select comparable ranked, human All Pick games; do not mix Turbo or bots.
  const sample = matches.filter(match => match.lobby_type === 7 && [1, 22].includes(match.game_mode) && match.duration >= 900 && won(match) !== null).slice(0, 30);
  const victories = sample.filter(won).length;
  const winrate = sample.length ? Math.round(victories / sample.length * 1000) / 10 : null;
  const kdaRows = sample.filter(m => [m.kills, m.deaths, m.assists].every(n => finite(n) !== null));
  const kda = mean(kdaRows.map(m => (m.kills + m.assists) / Math.max(m.deaths, 1)));
  const signals = [];
  if (sample.length >= 20 && winrate >= 75) signals.push({ key: 'wins', title: 'Высокая доля побед', detail: `${victories} побед в ${sample.length} последних доступных рейтинговых матчах (${winrate}%).` });
  if (kdaRows.length >= 20 && kda >= 5) signals.push({ key: 'kda', title: 'Высокий KDA', detail: `Среднее (убийства + помощи) / max(смерти, 1): ${kda}. Это зависит от роли и героев.` });
  const lowHistory = Number.isInteger(lifetimeGames) && lifetimeGames >= 0 && lifetimeGames < 300;
  if (lowHistory && signals.length) signals.push({ key: 'history', title: 'Небольшая публичная история', detail: `${lifetimeGames} матчей известно OpenDota. Это не возраст Steam-аккаунта и не полная история Dota 2.` });
  const level = sample.length < 20 ? 'insufficient' : signals.length >= 2 ? 'elevated' : signals.length ? 'notice' : 'ordinary';
  return { level, sampleSize: sample.length, wins: victories, winrate, kda, signals,
    title: { insufficient: 'Недостаточно данных', elevated: 'Есть сочетание необычных признаков', notice: 'Есть отдельный необычный признак', ordinary: 'Выраженных признаков в выборке нет' }[level],
    explanation: 'Эвристика по последним доступным рейтинговым All Pick матчам, не вероятность смурфа и не доказательство. Она не определяет владельца аккаунта, бустинг или нарушение правил. Отсутствие признаков не исключает смурфинг.' };
}
export function summarizePlayer(id, profile, matches, wl, heroes = {}) {
    if (!profile || typeof profile !== 'object' || !Array.isArray(matches) || !wl || typeof wl !== 'object') throw new DataError('Источник вернул неожиданный формат профиля.');
    const lifetimeGames = Number.isInteger(wl.win) && Number.isInteger(wl.lose) ? wl.win + wl.lose : null;
    const known = matches.filter(m => won(m) !== null);
    return { accountId: id, name: typeof profile.profile?.personaname === 'string' ? profile.profile.personaname.slice(0, 80) : `Игрок ${id}`,
      steamId: profile.profile?.steamid || null, rankTier: profile.rank_tier ?? null, leaderboardRank: profile.leaderboard_rank ?? null,
      publicHistory: matches.length > 0, lifetimeGames, sampleSize: known.length, wins: known.filter(won).length,
      matches: matches.slice(0, 20).map(match => matchSummary(match, heroes)), smurf: assessSmurf(matches, lifetimeGames),
      sourceURL: `https://www.opendota.com/players/${id}`, historyNotice: 'Показаны последние доступные OpenDota матчи. Закрытая или неполная история ограничивает анализ. Для своего профиля включите «Общедоступная история матчей» в Dota 2.' };
}
export function summarizeMatch(match, heroes = {}) {
  if (!Number.isSafeInteger(match?.match_id) || !Array.isArray(match.players) || !match.players.length) throw new DataError('Матч ещё не появился в OpenDota или недоступен.', 404);
  const players = match.players.map(player => ({ ...matchSummary({ ...player, match_id: match.match_id, start_time: match.start_time, duration: match.duration, radiant_win: match.radiant_win }, heroes),
    accountId: accountID(player.account_id), name: typeof player.personaname === 'string' ? player.personaname.slice(0, 80) : null,
    side: player.player_slot < 128 ? 'Radiant' : 'Dire', lastHits: finite(player.last_hits), denies: finite(player.denies),
    heroDamage: finite(player.hero_damage), towerDamage: finite(player.tower_damage), healing: finite(player.hero_healing),
    items: [0, 1, 2, 3, 4, 5].map(i => player[`item_${i}`]).filter(id => Number.isInteger(id) && id > 0) }));
  const insights = [];
  const top = (field, title) => {
    const rows = players.filter(p => p[field] !== null).sort((a, b) => b[field] - a[field]);
    if (rows[0]?.[field] > 0) insights.push({ title, hero: rows[0].hero.name, value: rows[0][field] });
  };
  top('gpm', 'Больше всего золота в минуту'); top('heroDamage', 'Больше всего урона героям'); top('towerDamage', 'Больше всего урона строениям');
  const parsed = players.some(p => p.xpm !== null) && Number.isFinite(match.version);
  return { id: match.match_id, startTime: finite(match.start_time), duration: finite(match.duration),
    winner: typeof match.radiant_win === 'boolean' ? match.radiant_win ? 'Radiant' : 'Dire' : null,
    radiantScore: finite(match.radiant_score), direScore: finite(match.dire_score), parsed,
    players, insights, sourceURL: `https://www.opendota.com/matches/${match.match_id}`,
    notice: parsed ? 'Анализ доступных показателей матча. KDA и урон зависят от роли; они не определяют виновника поражения.' : 'Реплей не разобран или расширенные поля недоступны. Показана только имеющаяся статистика; отсутствующие значения не заменены нулями.' };
}
export function buildStages(popularity, items) {
  if (!popularity || !['start_game_items', 'early_game_items', 'mid_game_items', 'late_game_items'].every(key => popularity[key] && typeof popularity[key] === 'object' && !Array.isArray(popularity[key]))) throw new DataError('Источник не вернул сборку героя.');
  return [['start_game_items', 'Старт'], ['early_game_items', 'Ранняя игра'], ['mid_game_items', 'Средняя игра'], ['late_game_items', 'Поздняя игра']].map(([key, title], index) => ({
    key, title, items: Object.entries(popularity[key]).filter(([, count]) => Number.isInteger(count) && count > 0)
      .map(([id, purchases]) => ({ ...items.find(item => item.id === Number(id)), purchases })).filter(item => item.id && !item.recipe && (index < 2 || (item.cost >= 1000 && !item.component)))
      .sort((a, b) => b.purchases - a.purchases).slice(0, 6),
  }));
}
