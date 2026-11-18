import { writeFile, rename } from 'node:fs/promises';
import { POSITIONS, RANKS, fetchMetaSlice, publishedMetaSlice } from '../src/meta.js';

// Publish every exact rank/role together. A failed refresh leaves the last file intact.
const checkedAt = Math.floor(Date.now() / 1000);
const snapshot = { version: 1, checkedAt, slices: {} };
for (const rank of Object.keys(RANKS)) {
  snapshot.slices[rank] = {};
  // Bound concurrency so scheduled refreshes don't flood the public source.
  for (let offset = 0; offset < POSITIONS.length; offset += 2) {
    await Promise.all(POSITIONS.slice(offset, offset + 2).map(async role => {
      const slice = await fetchMetaSlice(rank, role.key, checkedAt);
      snapshot.slices[rank][role.key] = slice;
      publishedMetaSlice(snapshot, rank, role.key, checkedAt);
    }));
  }
  console.log(`Validated meta: ${rank}, all five positions`);
}
const output = new URL('../public/meta-data.json', import.meta.url);
const temporary = new URL('../public/meta-data.json.tmp', import.meta.url);
await writeFile(temporary, JSON.stringify(snapshot) + '\n');
await rename(temporary, output);
console.log(`Published meta: ${Object.keys(RANKS).length * POSITIONS.length} slices`);
