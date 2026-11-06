import { writeFile } from 'node:fs/promises';
import { fetchCounterData } from '../src/counters.js';
const data = await fetchCounterData();
await writeFile(new URL('../public/counter-data.json', import.meta.url), JSON.stringify(data) + '\n');
console.log(`Updated counter data: ${data.heroes.length} heroes, patch ${data.patch}`);
