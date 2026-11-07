import { writeFile } from 'node:fs/promises';
const source = 'https://raw.githubusercontent.com/odota/dotaconstants/master/build/items.json';
const response = await fetch(source, { signal: AbortSignal.timeout(20000) });
if (!response.ok) throw new Error(`Item catalogue HTTP ${response.status}`);
const raw = await response.json();
const components = new Set(Object.values(raw).flatMap(item => item.components || []));
const items = Object.entries(raw).filter(([key, item]) => /^[a-z0-9_]+$/.test(key) && Number.isInteger(item.id) && typeof item.dname === 'string')
  .map(([key, item]) => ({ key, id: item.id, name: item.dname, cost: item.cost || 0, recipe: key.startsWith('recipe_'), component: components.has(key) && !item.components?.length && !['blink', 'ghost', 'gem'].includes(key), image: `https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/${key}.png` }));
if (items.length < 200) throw new Error('Incomplete item catalogue');
await writeFile(new URL('../public/item-data.json', import.meta.url), JSON.stringify({ fetchedAt: Math.floor(Date.now() / 1000), sourceURL: 'https://github.com/odota/dotaconstants', items }) + '\n');
console.log(`Saved ${items.length} items`);
