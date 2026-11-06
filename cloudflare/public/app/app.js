const $ = selector => document.querySelector(selector);
const roles = ['Керри', 'Мид', 'Оффлейн', 'Поддержка', 'Полная поддержка'];
const shortRoles = ['Керри', 'Мид', 'Оффлейн', 'Саппорт', 'Хард сап'];
const ranks = { all: 'Все ранги', herald: 'Рекрут', guardian: 'Страж', crusader: 'Рыцарь', archon: 'Герой', legend: 'Легенда', ancient: 'Властелин', divine: 'Божество', immortal: 'Титан' };
const tg = window.Telegram?.WebApp?.initData ? window.Telegram.WebApp : null;
const initData = tg?.initData || '';
const state = { tab: 'meta', position: 1, rank: 'all', data: null, events: null, profile: null, preferences: { position: 1, rank: 'all' } };
const number = n => new Intl.NumberFormat('ru-RU').format(Math.round(n));
const pct = n => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1, minimumFractionDigits: 1 }).format(n) + '%';
const date = value => new Date(typeof value === 'number' ? value * 1000 : value + 'T12:00:00Z').toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
function el(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; }
function link(text, url, className) { const node = el('a', className, text); node.href = url; node.target = '_blank'; node.rel = 'noopener noreferrer'; return node; }
function validPrefs(value) { return value && Number.isInteger(value.position) && value.position >= 1 && value.position <= 5 && Object.hasOwn(ranks, value.rank); }
try { const value = JSON.parse(localStorage.getItem('dota-watch-preferences')); if (validPrefs(value)) state.preferences = value; } catch { /* Embedded browsers may disable storage. */ }
state.position = state.preferences.position; state.rank = state.preferences.rank;
function remember(value) { try { localStorage.setItem('dota-watch-preferences', JSON.stringify(value)); } catch { /* Account preferences are also stored on the server. */ } }
async function api(path, options = {}) {
  const response = await fetch(path, { ...options, signal: options.signal || AbortSignal.timeout(18000), headers: { ...options.headers, ...(path === '/api/profile' ? { 'X-Telegram-Init-Data': initData } : {}) } });
  let data;
  try { data = await response.json(); } catch { throw new Error('Не удалось загрузить данные. Проверьте соединение.'); }
  if (!response.ok) throw new Error(data.error || 'Не удалось загрузить данные.');
  return data;
}
function toast(text) { $('#toast').textContent = text; $('#toast').hidden = false; clearTimeout(toast.timer); toast.timer = setTimeout(() => { $('#toast').hidden = true; }, 2600); }
function fillSelect(node, entries, value) { for (const [key, name] of entries) { const option = el('option', '', name); option.value = key; node.append(option); } node.value = value; }
fillSelect($('#rank'), Object.entries(ranks), state.rank);
fillSelect($('#favorite-rank'), Object.entries(ranks), state.preferences.rank);
fillSelect($('#favorite-position'), roles.map((name, i) => [i + 1, `${i + 1} · ${name}`]), state.preferences.position);
roles.forEach((name, index) => {
  const button = el('button', 'role-button'); button.type = 'button'; button.dataset.position = index + 1;
  button.setAttribute('aria-label', `${index + 1} · ${name}`); button.append(el('strong', '', index + 1), el('span', '', shortRoles[index]));
  button.addEventListener('click', () => { state.position = index + 1; tg?.HapticFeedback?.selectionChanged(); loadMeta(); }); $('#roles').append(button);
});
$('#rank').addEventListener('change', event => { state.rank = event.target.value; loadMeta(); });
function syncFilters() {
  for (const button of document.querySelectorAll('.role-button')) { const active = Number(button.dataset.position) === state.position; button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active)); }
  $('#rank').value = state.rank; $('#role-description').textContent = `${state.position} · ${roles[state.position - 1]}`;
}
function empty(container, text, retry) { const box = el('div', 'empty'); box.append(el('p', '', text)); if (retry) { const button = el('button', 'outline-button', 'Попробовать ещё раз ↻'); button.addEventListener('click', retry); box.append(button); } container.replaceChildren(box); }
let metaRequest;
async function loadMeta() {
  metaRequest?.abort(); const controller = new AbortController(); metaRequest = controller;
  syncFilters(); state.data = null; $('#meta-notice').hidden = true; $('#role-hint').textContent = ''; $('#meta-source').replaceChildren();
  $('#heroes').setAttribute('aria-busy', 'true'); $('#heroes').replaceChildren(...Array.from({ length: 5 }, () => el('div', 'skeleton')));
  try {
    const data = await api(`/api/meta?position=${state.position}&rank=${state.rank}`, { signal: controller.signal.aborted ? controller.signal : AbortSignal.any([controller.signal, AbortSignal.timeout(18000)]) });
    if (controller.signal.aborted) return;
    state.data = data; $('#heroes').replaceChildren(...data.heroes.map((hero, i) => heroCard(hero, i, data)));
    $('#role-hint').textContent = data.role.hint;
    $('#patch-label').textContent = `ПАТЧ ${data.knownPatch || data.patch}`;
    const warnings = [];
    if (data.olderPatch) warnings.push(`Статистика ещё для ${data.patch}. Последний патч Valve — ${data.knownPatch}.`);
    else if (data.stale) warnings.push('Актуальность не подтверждена. Показана сохранённая статистика.');
    if (data.fallback) warnings.push(`Источник расширил выборку: ${ranks[data.rank] || data.rank}. Точный срез выбранного ранга недоступен.`);
    $('#meta-notice').textContent = warnings.join(' '); $('#meta-notice').hidden = !warnings.length;
    renderSource(data);
  } catch (error) { if (!controller.signal.aborted) empty($('#heroes'), error.message, loadMeta); }
  finally { if (metaRequest === controller) $('#heroes').setAttribute('aria-busy', 'false'); }
}
function heroCard(hero, index, data) {
  const button = el('button', `hero-card${index === 0 ? ' featured' : ''}`); button.type = 'button';
  button.setAttribute('aria-label', `${hero.name}, победы ${pct(hero.winrate)}. Подробнее`);
  if (hero.image) { const image = el('img', 'hero-image'); image.src = hero.image; image.alt = ''; image.loading = index === 0 ? 'eager' : 'lazy'; image.addEventListener('error', () => { image.style.visibility = 'hidden'; }); button.append(image); }
  else button.append(el('div', 'hero-image'));
  const info = el('div', 'hero-info'); const subtitle = el('div', 'hero-subtitle'); subtitle.append(el('span', 'tier', hero.tier), el('span', '', `${hero.score}/100 · ${index === 0 ? 'Лидер подборки' : roles[data.role.id - 1]}`));
  const name = el('span', 'hero-name', hero.name); const stats = el('div', 'hero-stats');
  for (const [value, label] of [[pct(hero.winrate), 'побед'], [pct(hero.pickRate), 'пиков']]) { const stat = el('div'); stat.append(el('strong', '', value), el('small', '', label)); stats.append(stat); }
  info.append(...(index === 0 ? [subtitle, name, stats] : [name, subtitle, stats]));
  button.append(info, el('span', 'hero-rank', `0${index + 1}`)); if (index === 0) button.append(el('span', 'hero-open', '↗'));
  button.addEventListener('click', () => showHero(hero, data)); return button;
}
function renderSource(data) {
  const box = $('#meta-source'); const top = el('div', 'source-top'); top.append(el('span', '', `Патч ${data.patch} · ${ranks[data.rank]}`), el('span', '', `${date(data.sampleFrom)} — ${date(data.sampleTo)}`));
  box.append(top, el('p', '', `Выборка позиции: ≈${number(data.sampleMatches)} матчей. Пики — доля героя на выбранной позиции.`), el('p', '', `Рейтинг учитывает победы, популярность и размер выборки. Он не гарантирует победу в отдельном матче.`));
  const stamp = new Date(data.updatedAt * 1000).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });
  box.append(el('p', '', `Данные источника: ${stamp}. Проверка — раз в час.`));
  const links = el('div', 'source-links'); links.append(link('Источник: StatsDota ↗', data.sourceURL), link('Как считается рейтинг ↗', data.methodologyURL)); box.append(links);
}
function showHero(hero, data) {
  const detail = $('#hero-detail'); detail.replaceChildren();
  if (hero.image) { const image = el('img', 'detail-image'); image.src = hero.image; image.alt = hero.name; detail.append(image); }
  const body = el('div', 'detail-content'); body.append(el('div', 'eyebrow', `${data.role.id} · ${data.role.name} / ${ranks[data.rank]}`));
  const title = el('h2', '', hero.name); title.id = 'hero-dialog-title'; body.append(title);
  const stats = el('div', 'detail-stats'); for (const [value, label] of [[pct(hero.winrate), 'побед'], [pct(hero.pickRate), 'пиков'], [hero.score + '/100', 'рейтинг']]) { const stat = el('div'); stat.append(el('strong', '', value), el('span', '', label)); stats.append(stat); }
  body.append(stats, el('p', '', `${number(hero.matches)} матчей за ${date(data.sampleFrom)} — ${date(data.sampleTo)}. Тир ${hero.tier}, патч ${data.patch}. ${data.stale ? 'Данные могут быть устаревшими. ' : ''}${data.fallback ? 'Источник использовал расширенную выборку. ' : ''}`), el('p', '', data.role.hint), link('Статистика героя на StatsDota ↗', hero.url, 'outline-button'));
  detail.append(body); $('#hero-dialog').showModal(); syncBackButton(); tg?.HapticFeedback?.selectionChanged();
}
$('#hero-dialog .dialog-close').addEventListener('click', () => $('#hero-dialog').close());
$('#hero-dialog').addEventListener('click', event => { if (event.target === $('#hero-dialog')) { const rect = event.target.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) event.target.close(); } });
$('#hero-dialog').addEventListener('close', syncBackButton);
function richText(raw) {
  const parsed = new DOMParser().parseFromString(raw, 'text/html'); const fragment = document.createDocumentFragment();
  function append(parent, source) {
    for (const child of source.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) { parent.append(document.createTextNode(child.textContent)); continue; }
      if (child.nodeType !== Node.ELEMENT_NODE || ['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT'].includes(child.tagName)) continue;
      if (['B', 'I', 'EM', 'STRONG', 'U', 'BR'].includes(child.tagName)) { const node = document.createElement(child.tagName); append(node, child); parent.append(node); }
      else if (child.tagName === 'A') {
        let url; try { url = new URL(child.getAttribute('href')); } catch { /* Plain text below. */ }
        if (url?.protocol === 'https:' && ['www.dota2.com', 'dota2.com', 'store.steampowered.com', 'steamcommunity.com', 'steamstore-a.akamaihd.net'].includes(url.hostname)) { const node = link('', url.href); append(node, child); parent.append(node); }
        else append(parent, child);
      } else append(parent, child);
    }
  }
  append(fragment, parsed.body); return fragment;
}
async function loadPatches() {
  $('#refresh-patches').disabled = true; $('#patches-list').replaceChildren(el('div', 'skeleton'), el('div', 'skeleton'));
  try {
    const { events } = await api('/api/patches'); state.events = events;
    if (!events.length) { empty($('#patches-list'), 'Здесь появится первый сохранённый разбор после проверки источников.'); return; }
    $('#patches-list').replaceChildren(...events.map((event, index) => {
      const card = el('details', 'patch-card'); const summary = el('summary'); const meta = el('div', 'patch-meta'); meta.append(el('span', '', index === 0 ? 'ПОСЛЕДНИЙ РАЗБОР' : 'ОБНОВЛЕНИЕ DOTA 2'), el('span', '', date(event.published)));
      const fragment = richText(event.message); const text = fragment.textContent.trim(); const title = text.split('\n').find(line => line.trim()) || 'Обновление Dota 2';
      const preview = text.slice(text.indexOf('\n') + 1).trim().replace(/\n+/g, ' ');
      summary.append(meta, el('h2', '', title.replace(/^[^\p{L}\p{N}]+/u, '')), el('p', 'patch-preview', preview.slice(0, 170)), el('span', 'patch-read', 'Читать разбор ↗'));
      const body = el('div', 'patch-body'); body.append(fragment); card.append(summary, body);
      card.addEventListener('toggle', () => { card.querySelector('.patch-read').textContent = card.open ? 'Свернуть ↑' : 'Читать разбор ↗'; }); return card;
    }));
  } catch (error) { empty($('#patches-list'), error.message, loadPatches); }
  finally { $('#refresh-patches').disabled = false; }
}
$('#refresh-patches').addEventListener('click', loadPatches);
function syncBackButton() { if (!tg?.BackButton) return; if ($('#hero-dialog').open || state.tab !== 'meta') tg.BackButton.show(); else tg.BackButton.hide(); }
function navigate(tab) {
  if (!['meta', 'counters', 'patches', 'profile'].includes(tab)) tab = 'meta';
  state.tab = tab; for (const key of ['meta', 'counters', 'patches', 'profile']) $(`#${key}-view`).hidden = key !== tab;
  for (const node of document.querySelectorAll('[data-tab]')) { const active = node.dataset.tab === tab; node.classList.toggle('active', active); if (active) node.setAttribute('aria-current', 'page'); else node.removeAttribute('aria-current'); }
  if (tab === 'patches' && !state.events) loadPatches();
  if (tab === 'counters') openCounters();
  syncBackButton(); window.scrollTo({ top: 0, behavior: 'instant' });
}
function go(tab) { if (location.hash.slice(1) === tab) navigate(tab); else location.hash = tab; }
for (const button of document.querySelectorAll('[data-tab]')) button.addEventListener('click', () => { go(button.dataset.tab); tg?.HapticFeedback?.selectionChanged(); });
window.addEventListener('hashchange', () => navigate(location.hash.slice(1)));
$('#patch-shortcut').addEventListener('click', () => go('patches'));
async function loadProfile() {
  if (!initData) return;
  try {
    const profile = await api('/api/profile', { signal: AbortSignal.timeout(7000) }); state.profile = profile;
    state.preferences = profile.preferences; state.position = profile.preferences.position; state.rank = profile.preferences.rank; remember(profile.preferences);
    $('#profile-name').textContent = profile.name; $('#profile-greeting').textContent = `${profile.name}, настрой мету под свою игру.`;
    $('#profile-mode').textContent = 'Выбор синхронизирован с Telegram';
    $('#favorite-position').value = profile.preferences.position; $('#favorite-rank').value = profile.preferences.rank;
    $('#subscription-title').textContent = profile.subscribed ? 'Рассылка включена' : 'Рассылка выключена';
    $('#subscription-description').textContent = profile.subscribed ? 'Новые важные патчи придут в личный чат. Отключить рассылку можно командой /stop.' : 'Отправь /start в личном чате бота, чтобы получать важные обновления.';
  } catch (error) { $('#profile-mode').textContent = 'Пока доступно сохранение на устройстве'; $('#save-status').textContent = error.message; }
}
$('#preferences').addEventListener('submit', async event => {
  event.preventDefault(); const button = $('#save-preferences'); button.disabled = true; $('#save-status').textContent = 'Сохраняю…';
  const preferences = { position: Number($('#favorite-position').value), rank: $('#favorite-rank').value };
  try {
    if (initData) { const profile = await api('/api/profile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(preferences) }); state.profile = profile; }
    remember(preferences); state.preferences = preferences; state.position = preferences.position; state.rank = preferences.rank; loadMeta(); resetCounterResults(); counterPosition();
    $('#save-status').textContent = initData ? 'Сохранено для твоего аккаунта Telegram.' : 'Сохранено на этом устройстве.'; toast('Твоя мета настроена'); tg?.HapticFeedback?.notificationOccurred('success');
  } catch (error) { $('#save-status').textContent = error.message; }
  finally { button.disabled = false; }
});
if (tg && initData) {
  tg.ready(); tg.expand();
  try { tg.setHeaderColor('#101312'); tg.setBackgroundColor('#101312'); if (tg.isVersionAtLeast('7.10')) tg.setBottomBarColor('#161c17'); } catch { /* Native colors on older clients. */ }
  tg.BackButton?.onClick(() => { if ($('#hero-dialog').open) $('#hero-dialog').close(); else go('meta'); });
  const safeArea = () => { document.documentElement.style.setProperty('--bottom', `${Math.max(tg.safeAreaInset?.bottom || 0, tg.contentSafeAreaInset?.bottom || 0)}px`); };
  safeArea(); tg.onEvent('safeAreaChanged', safeArea); tg.onEvent('contentSafeAreaChanged', safeArea);
}
const counter = { catalogue: null, enemies: [], request: null, loading: false };
const counterAliases = { 1:'антимаг ам',2:'акс могул',6:'дровка тракса',11:'сф шадоу финд',12:'пл лансер фантом',14:'пудж мясник',21:'вр виндренджер',26:'лион',35:'снайпер',42:'вк леорик скелет',44:'па фантомка',46:'та ланая темпларка',74:'инвокер инвок',75:'сайленсер',93:'сларк',94:'медуза дузa',95:'тролль',99:'бристлбек брист',104:'легионка лк',114:'мк обезьяна',129:'марс' };
const pp = n => `${n > 0 ? '+' : ''}${n.toFixed(1).replace('.', ',')} п.п.`;
function resetCounterResults() { counter.request?.abort(); counter.request = null; $('#counter-results').replaceChildren(); $('#find-counters').disabled = !counter.enemies.length; }
function counterPosition() { $('#counter-position').textContent = `${state.preferences.position} · ${roles[state.preferences.position - 1]}`; }
async function openCounters() {
  counterPosition();
  if (counter.catalogue || counter.loading) return;
  counter.loading = true; empty($('#enemy-search-results'), 'Загружаю героев…');
  try { counter.catalogue = await api('/api/counters'); renderEnemyPicker(); }
  catch (error) { empty($('#enemy-search-results'), error.message, openCounters); }
  finally { counter.loading = false; }
}
function renderEnemyPicker() {
  $('#enemy-count').textContent = `${counter.enemies.length}/5`;
  const selected = counter.enemies.map(id => counter.catalogue.heroes.find(h => h.id === id));
  $('#enemy-slots').replaceChildren(...selected.map(hero => {
    const chip = el('button', 'enemy-chip'); chip.type = 'button'; chip.setAttribute('aria-label', `Убрать ${hero.name}`);
    if (hero.image) { const image = el('img'); image.src = hero.image; image.alt = ''; chip.append(image); }
    chip.append(el('span', '', hero.name), el('b', '', '×')); chip.addEventListener('click', () => toggleEnemy(hero.id)); return chip;
  }));
  if (!selected.length) $('#enemy-slots').append(el('div', 'empty-slots', 'Добавь от 1 до 5 вражеских героев'));
  const term = $('#hero-search').value.trim().toLowerCase();
  const found = counter.catalogue.heroes.filter(hero => {
    const initials = hero.name.split(/[\s-]+/).map(word => word[0]).join('').toLowerCase();
    return !term || `${hero.name} ${hero.slug} ${counterAliases[hero.id] || ''}`.toLowerCase().includes(term) || (term.length >= 2 && initials === term);
  }).slice(0, term ? 30 : 18);
  $('#enemy-search-results').replaceChildren(...found.map(hero => {
    const selected = counter.enemies.includes(hero.id); const button = el('button', 'enemy-option'); button.type = 'button'; button.setAttribute('aria-pressed', String(selected)); button.setAttribute('aria-label', `${selected ? 'Убрать' : 'Добавить'} ${hero.name}`); button.disabled = counter.enemies.length === 5 && !selected;
    if (hero.image) { const image = el('img'); image.src = hero.image; image.alt = ''; image.loading = 'lazy'; button.append(image); }
    button.append(el('span', '', hero.name)); button.addEventListener('click', () => toggleEnemy(hero.id)); return button;
  }));
  if (!found.length) empty($('#enemy-search-results'), 'Герой не найден. Попробуй английское имя.');
  $('#find-counters').disabled = !selected.length;
}
function toggleEnemy(id) {
  if (counter.enemies.includes(id)) counter.enemies = counter.enemies.filter(value => value !== id);
  else if (counter.enemies.length < 5) { counter.enemies.push(id); $('#hero-search').value = ''; }
  resetCounterResults(); renderEnemyPicker();
}
$('#hero-search').addEventListener('input', () => { if (counter.catalogue) renderEnemyPicker(); });
$('#counter-settings').addEventListener('click', () => go('profile'));
$('#clear-enemies').addEventListener('click', () => { counter.enemies = []; $('#hero-search').value = ''; resetCounterResults(); if (counter.catalogue) renderEnemyPicker(); });
$('#find-counters').addEventListener('click', findCounters);
async function findCounters() {
  if (!counter.enemies.length) return;
  resetCounterResults(); const controller = new AbortController(); counter.request = controller; $('#find-counters').disabled = true;
  $('#counter-results').replaceChildren(el('div', 'skeleton'));
  const position = state.preferences.position;
  try {
    const data = await api(`/api/counters?enemies=${counter.enemies.join(',')}&position=${position}`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(18000)]) });
    if (controller.signal.aborted) return;
    const box = $('#counter-results'); box.replaceChildren(el('h2', '', `Кого пикнуть: ${data.role.name}`), el('p', '', `Против: ${data.enemies.map(h => h.name).join(', ')}`));
    if (data.stale) box.append(el('div', 'notice', 'Показаны сохранённые данные. Актуальность источника не подтверждена.'));
    if (!data.heroes.length) { empty(box, 'Для этой позиции мало матчей против выбранного пика. Попробуй убрать одного врага или изменить позицию в «Моё».'); return; }
    if (data.heroes[0].advantage <= 0) box.append(el('div', 'notice', 'Явного преимущества не найдено. Ниже — лучшие из доступных вариантов, но матчапы остаются сложными.'));
    for (const hero of data.heroes) {
      const card = el('details', 'counter-card'); const summary = el('summary');
      if (hero.image) { const image = el('img'); image.src = hero.image; image.alt = ''; summary.append(image); }
      const info = el('div'); info.append(el('h3', '', hero.name), el('strong', hero.advantage < 0 ? 'negative' : '', pp(hero.advantage)), el('p', '', 'среднее преимущество · подробнее ↓')); summary.append(info);
      const detail = el('div', 'counter-detail');
      for (const pair of hero.pairs) {
        const enemy = data.enemies.find(h => h.id === pair.enemyId); const row = el('div', 'pair-row');
        row.append(el('span', '', `Против ${enemy.name}`), el('b', '', pp(pair.advantage))); detail.append(row, el('div', '', `${pct(pair.winrate)} побед · ${number(pair.matches)} матчей`));
      }
      detail.append(el('p', '', `${hero.positionShare.toFixed(1).replace('.', ',')}% игр этого героя приходится на позицию ${data.role.id}. Матчапы выше рассчитаны по всем позициям и рангам.`), link('Подробнее о герое на StatsDota ↗', hero.url));
      card.append(summary, detail); box.append(card);
    }
    const source = el('div', 'counter-source'); source.append(el('p', '', `Патч источника: ${data.patch}. Получено: ${new Date(data.checkedAt * 1000).toLocaleString('ru-RU')}. Кеш — 1 час.`), el('p', '', 'Преимущество — отклонение от обычного винрейта героя, по оценке StatsDota. Подбор усредняет его по выбранным врагам. В выборку входят герои с ≥15% игр на вашей позиции и ≥150 матчами против каждого врага.'), link('Источник и исходный подбор: StatsDota ↗', data.sourceURL)); box.append(source);
    box.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' });
  } catch (error) { if (!controller.signal.aborted) empty($('#counter-results'), error.message, findCounters); }
  finally { if (counter.request === controller) $('#find-counters').disabled = !counter.enemies.length; }
}

$('#heroes').replaceChildren(...Array.from({ length: 5 }, () => el('div', 'skeleton')));
await loadProfile(); syncFilters(); navigate(location.hash.slice(1)); loadMeta();
