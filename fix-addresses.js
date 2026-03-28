/**
 * Tonight.TO — Address Fixer (Free, no API key needed)
 * Uses Nominatim (OpenStreetMap) — searches by street address for accuracy
 * Full coordinate precision preserved (6 decimal places = ~10cm accuracy)
 * 
 * Run: node scripts/fix-addresses.js
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const VENUES_PATH = resolve(__dirname, '..', 'venues.json');
const USER_AGENT = 'TonightTO/1.0 (https://christopherrly13-web.github.io/tonight-to/)';

async function geocode(name, addr) {
  // Try address-first (most accurate), then name fallback
  const queries = [
    // Street address lookup — most precise
    new URLSearchParams({
      format: 'json', limit: '1', countrycodes: 'ca',
      viewbox: '-79.7,43.5,-79.1,43.9', bounded: '1',
      street: addr, city: 'Toronto', country: 'Canada',
    }),
    // Full address string
    new URLSearchParams({
      format: 'json', limit: '1', countrycodes: 'ca',
      viewbox: '-79.7,43.5,-79.1,43.9', bounded: '1',
      q: `${addr}, Toronto, Ontario, Canada`,
    }),
    // Venue name + address as fallback
    new URLSearchParams({
      format: 'json', limit: '1', countrycodes: 'ca',
      viewbox: '-79.7,43.5,-79.1,43.9', bounded: '1',
      q: `${name}, ${addr}, Toronto, Ontario, Canada`,
    }),
  ];

  for (const qs of queries) {
    const url = `https://nominatim.openstreetmap.org/search?${qs}`;
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok) continue;
    const results = await res.json();
    if (results.length > 0) {
      const r = results[0];
      // Full precision — 6 decimal places (~11cm)
      const lat = Math.round(parseFloat(r.lat) * 1000000) / 1000000;
      const lng = Math.round(parseFloat(r.lon) * 1000000) / 1000000;
      if (lat > 43.5 && lat < 43.9 && lng > -79.7 && lng < -79.1) {
        return { lat, lng };
      }
    }
  }
  return null;
}

async function main() {
  console.log('Tonight.TO — Address Fixer (Nominatim/OSM, full precision)');
  console.log('============================================================');

  const data = JSON.parse(readFileSync(VENUES_PATH, 'utf8'));
  const venues = data.venues || [];
  console.log(`Loaded ${venues.length} venues\n`);

  let fixed = 0, failed = 0, skipped = 0;

  for (let i = 0; i < venues.length; i++) {
    const v = venues[i];
    process.stdout.write(`[${i + 1}/${venues.length}] ${v.name} (${v.addr})... `);

    if (v.source === 'eventbrite' || v.source === 'meetup') {
      console.log('skipped (external)');
      skipped++;
      await new Promise(r => setTimeout(r, 1100));
      continue;
    }

    try {
      const result = await geocode(v.name, v.addr);
      if (result) {
        const latDiff = Math.abs((v.lat || 0) - result.lat);
        const lngDiff = Math.abs((v.lng || 0) - result.lng);
        const changed = latDiff > 0.00001 || lngDiff > 0.00001;

        v.lat = result.lat;
        v.lng = result.lng;

        if (changed) {
          console.log(`✅ (${result.lat}, ${result.lng}) [was (${v.lat?.toFixed(4)}, ${v.lng?.toFixed(4)})]`);
          fixed++;
        } else {
          console.log(`✓ unchanged (${result.lat}, ${result.lng})`);
        }
      } else {
        console.log('⚠️  not found — keeping existing');
        failed++;
      }
    } catch (e) {
      console.log(`❌ ${e.message}`);
      failed++;
    }

    // Nominatim policy: max 1 req/sec
    await new Promise(r => setTimeout(r, 1100));
  }

  console.log(`\nDone: ${fixed} updated, ${failed} not found, ${skipped} skipped`);

  writeFileSync(VENUES_PATH, JSON.stringify({
    ...data,
    updated: new Date().toISOString().split('T')[0],
    total: venues.length,
    venues,
  }, null, 2));

  console.log('venues.json saved.');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
