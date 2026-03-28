Here's the full contents:

```javascript
/**
 * Tonight.TO — Address Fixer (Free, no API key needed)
 * Uses Nominatim (OpenStreetMap) — searches by street address for accuracy
 * Full coordinate precision (6 decimal places = ~10cm accuracy)
 * CommonJS — works without package.json
 *
 * Run: node scripts/fix-addresses.js
 */

const fs = require('fs');
const path = require('path');

const VENUES_PATH = path.resolve(__dirname, '..', 'venues.json');
const USER_AGENT = 'TonightTO/1.0 (https://christopherrly13-web.github.io/tonight-to/)';

async function geocode(name, addr) {
  const queries = [
    new URLSearchParams({
      format: 'json', limit: '1', countrycodes: 'ca',
      viewbox: '-79.7,43.5,-79.1,43.9', bounded: '1',
      street: addr, city: 'Toronto', country: 'Canada',
    }),
    new URLSearchParams({
      format: 'json', limit: '1', countrycodes: 'ca',
      viewbox: '-79.7,43.5,-79.1,43.9', bounded: '1',
      q: `${addr}, Toronto, Ontario, Canada`,
    }),
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

  const data = JSON.parse(fs.readFileSync(VENUES_PATH, 'utf8'));
  const venues = data.venues || [];
  console.log(`Loaded ${venues.length} venues\n`);

  let fixed = 0, failed = 0, skipped = 0;

  for (let i = 0; i < venues.length; i++) {
    const v = venues[i];
    const oldLat = v.lat;
    const oldLng = v.lng;
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
        const latDiff = Math.abs((oldLat || 0) - result.lat);
        const lngDiff = Math.abs((oldLng || 0) - result.lng);
        const changed = latDiff > 0.00001 || lngDiff > 0.00001;

        v.lat = result.lat;
        v.lng = result.lng;

        if (changed) {
          console.log(`✅ (${result.lat}, ${result.lng}) [was (${oldLat}, ${oldLng})]`);
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

    await new Promise(r => setTimeout(r, 1100));
  }

  console.log(`\nDone: ${fixed} updated, ${failed} not found, ${skipped} skipped`);

  fs.writeFileSync(VENUES_PATH, JSON.stringify({
    ...data,
    updated: new Date().toISOString().split('T')[0],
    total: venues.length,
    venues,
  }, null, 2));

  console.log('venues.json saved.');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
```
