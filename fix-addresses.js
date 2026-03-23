/**
 * Tonight.TO — Address Fixer (Free, no API key needed)
 * Uses Nominatim (OpenStreetMap) geocoding — completely free
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
  const queries = [
    { q: `${name}, Toronto, Ontario, Canada` },
    { q: `${name} ${addr}, Toronto, Ontario, Canada` },
    { street: addr, city: 'Toronto', country: 'Canada' },
  ];

  for (const params of queries) {
    const qs = new URLSearchParams({
      format: 'json',
      limit: '1',
      countrycodes: 'ca',
      viewbox: '-79.7,43.5,-79.1,43.9',
      bounded: '1',
      ...params,
    });

    const url = `https://nominatim.openstreetmap.org/search?${qs}`;
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok) continue;

    const results = await res.json();
    if (results.length > 0) {
      const r = results[0];
      const lat = Math.round(parseFloat(r.lat) * 10000) / 10000;
      const lng = Math.round(parseFloat(r.lon) * 10000) / 10000;

      if (lat > 43.5 && lat < 43.9 && lng > -79.7 && lng < -79.1) {
        const parts = r.display_name.split(', ');
        let street = '';
        for (let i = 0; i < Math.min(parts.length, 4); i++) {
          if (/^\d+/.test(parts[i]) && parts[i + 1]) {
            street = `${parts[i]} ${parts[i + 1]}`;
            break;
          }
        }
        if (!street) street = addr;
        return { addr: street, lat, lng };
      }
    }
  }
  return null;
}

async function main() {
  console.log('Tonight.TO — Address Fixer (Nominatim/OSM)');
  console.log('===========================================');

  const data = JSON.parse(readFileSync(VENUES_PATH, 'utf8'));
  const venues = data.venues || [];
  console.log(`Loaded ${venues.length} venues\n`);

  let fixed = 0, failed = 0, skipped = 0;

  for (let i = 0; i < venues.length; i++) {
    const v = venues[i];
    process.stdout.write(`[${i + 1}/${venues.length}] ${v.name}... `);

    if (v.source === 'eventbrite' || v.source === 'meetup') {
      console.log('skipped (external)');
      skipped++;
      await new Promise(r => setTimeout(r, 1100));
      continue;
    }

    try {
      const result = await geocode(v.name, v.addr);
      if (result) {
        const latChanged = Math.abs((v.lat || 0) - result.lat) > 0.0005;
        const lngChanged = Math.abs((v.lng || 0) - result.lng) > 0.0005;
        const addrChanged = result.addr && result.addr !== v.addr;

        if (latChanged || lngChanged || addrChanged) {
          console.log(`✅ "${v.addr}" → "${result.addr}" (${result.lat}, ${result.lng})`);
          if (result.addr) v.addr = result.addr;
          v.lat = result.lat;
          v.lng = result.lng;
          fixed++;
        } else {
          console.log('✓ already correct');
        }
      } else {
        console.log('⚠️  not found — keeping existing');
        failed++;
      }
    } catch (e) {
      console.log(`❌ ${e.message}`);
      failed++;
    }

    // Nominatim requires max 1 request per second
    await new Promise(r => setTimeout(r, 1100));
  }

  console.log(`\nResults: ${fixed} updated, ${failed} not found, ${skipped} skipped`);

  writeFileSync(VENUES_PATH, JSON.stringify({
    ...data,
    updated: new Date().toISOString().split('T')[0],
    total: venues.length,
    venues,
  }, null, 2));

  console.log('venues.json saved.');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
