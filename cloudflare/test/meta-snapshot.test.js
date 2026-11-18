import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { D1 } from './helpers/d1.js';
import { POSITIONS, RANKS, CACHE_TTL, MAX_CACHE_AGE, SNAPSHOT_FRESH_AGE, normalizeSlice, publishedMetaSlice, isSliceStale, loadMeta, metaReply } from '../src/meta.js';
import { miniappAPI } from '../src/miniapp.js';

const fixtures = Object.fromEntries(POSITIONS.map(role => [role.key, JSON.parse(readFileSync(new URL(`fixtures/meta-${role.key}.json`, import.meta.url)))]));
const NOW = Math.floor(Date.parse(fixtures.carry.updatedAt) / 1000) + 60;
function snapshot(at = NOW) {
  return { version: 1, checkedAt: at, slices: Object.fromEntries(Object.keys(RANKS).map(rank => [rank, Object.fromEntries(POSITIONS.map(role => [role.key, { ...structuredClone(fixtures[role.key]), rank }]))])) };
}
const assetsFor = value => ({ fetch: async url => { assert.equal(url, 'https://assets.local/meta-data.json'); return Response.json(value); } });

test('all 45 rank/position slices load from published data without external HTTP', async t => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('No source requests from Worker'); });
  const DB = new D1(), data = snapshot();
  let reads = 0;
  const assets = { fetch: async url => { reads++; return assetsFor(data).fetch(url); } };
  for (const rank of Object.keys(RANKS)) {
    const slices = await loadMeta(DB, rank, 0, NOW, assets);
    assert.equal(slices.length, 5);
    for (const { role, data } of slices) {
      assert.equal(data.rank, rank); assert.equal(data.requestedRank, rank); assert.equal(data.position, role.key);
      assert.equal(data.heroes.length, 5); assert.equal(data.published, true); assert.equal(isSliceStale(data, data.patch, NOW), false);
    }
    await loadMeta(DB, rank, 1, NOW + 20, assets);
  }
  assert.equal(reads, 9);
  assert.equal(DB.db.prepare('SELECT COUNT(*) AS n FROM leases').get().n, 0);
});

test('published age is preserved and repeated loads use loadedAt for the hourly D1 cache', async t => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('No source requests'); });
  const DB = new D1(), data = snapshot(NOW - 2 * 3600); let reads = 0;
  const assets = { fetch: async () => { reads++; return Response.json(data); } };
  const first = (await loadMeta(DB, 'legend', 1, NOW, assets))[0].data;
  assert.equal(first.checkedAt, data.checkedAt); assert.equal(first.loadedAt, NOW);
  assert.equal(isSliceStale(first, first.patch, NOW), false);
  await loadMeta(DB, 'legend', 1, NOW + 20, assets); assert.equal(reads, 1);
  assert.equal(isSliceStale(first, first.patch, data.checkedAt + SNAPSHOT_FRESH_AGE), true);
  await loadMeta(DB, 'legend', 1, NOW + CACHE_TTL + 1, assets); assert.equal(reads, 2);
});

test('invalid snapshot scope, future time, expired publication and expired source are rejected', () => {
  for (const edit of [
    value => { value.version = 2; },
    value => { value.checkedAt = NOW + 61; },
    value => { value.checkedAt = NOW - MAX_CACHE_AGE; },
    value => { value.slices.legend.carry.position = 'mid'; },
    value => { value.slices.legend.carry.rank = 'immortal'; },
    value => { value.slices.legend.carry.updatedAt = '2020-01-01T00:00:00Z'; },
    value => { value.slices.legend.carry.sampleTo = '2020-01-01'; },
    value => { delete value.slices.legend.carry; },
  ]) {
    const data = snapshot(); edit(data);
    assert.throws(() => publishedMetaSlice(data, 'legend', 'carry', NOW));
  }
});

test('bad published slice does not suppress other roles or silently substitute another rank', async t => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('No source requests'); });
  const data = snapshot(); data.slices.legend.mid = data.slices.legend.carry;
  const slices = await loadMeta(new D1(), 'legend', 0, NOW, assetsFor(data));
  assert.equal(slices.filter(slice => slice.data).length, 4);
  assert.equal(slices[1].data, null);
  assert.ok(slices.filter(slice => slice.data).every(slice => slice.data.rank === 'legend'));
});

test('snapshot outages preserve usable cache with stale disclosure and backoff', async t => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('No source requests'); });
  const DB = new D1(); const old = { ...normalizeSlice(fixtures.carry, 'all', 'carry', NOW), published: true, loadedAt: NOW - CACHE_TTL - 1 };
  DB.db.prepare('INSERT INTO meta VALUES(?,?)').run('hero_meta:v2:all:carry', JSON.stringify(old));
  let reads = 0;
  const assets = { fetch: async () => { reads++; throw new Error('Asset missing'); } };
  const first = (await loadMeta(DB, 'all', 1, NOW, assets))[0].data;
  assert.equal(first.checkedAt, old.checkedAt); assert.equal(first.failedAt, NOW);
  assert.equal(isSliceStale(first, first.patch, NOW), true);
  await loadMeta(DB, 'all', 1, NOW + 20, assets); assert.equal(reads, 1);
});

test('Mini App and Telegram meta both use the published snapshot despite broken live source', async t => {
  t.mock.method(Date, 'now', () => NOW * 1000);
  t.mock.method(globalThis, 'fetch', () => { throw new Error('StatsDota HTTP 403'); });
  const DB = new D1(), assets = assetsFor(snapshot());
  const response = await miniappAPI(new Request('https://example.com/api/meta?position=1&rank=legend'), { DB, ASSETS: assets });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.rank, 'legend'); assert.equal(body.position, 'carry'); assert.equal(body.stale, false);
  assert.equal(body.heroes.length, 5); assert.ok(body.heroes.every(hero => hero.image));
  const reply = await metaReply(DB, 'legend', 0, assets);
  assert.ok(reply.text.includes('Легенда')); assert.ok(reply.text.includes('Керри')); assert.ok(reply.text.includes('Мид'));
  assert.ok(!reply.text.includes('временно недоступна')); assert.ok(reply.text.length < 4096);
});

test('committed production snapshot has usable source data for every rank and role', () => {
  const data = JSON.parse(readFileSync(new URL('../public/meta-data.json', import.meta.url)));
  for (const rank of Object.keys(RANKS)) for (const role of POSITIONS) {
    const slice = publishedMetaSlice(data, rank, role.key, data.checkedAt);
    assert.equal(slice.heroes.length, 5); assert.equal(slice.position, role.key);
  }
});
