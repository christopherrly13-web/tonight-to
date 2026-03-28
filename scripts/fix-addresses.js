const fs = require('fs');
const path = require('path');

const VENUES_PATH = path.resolve(__dirname, '..', 'venues.json');
const USER_AGENT = 'TonightTO/1.0 (https://christopherrly13-web.github.io/tonight-to/)';

async function geocode(name, addr) {
  const attempts = [
    new URLSearchParams({ format: 'json', limit: '1', countrycodes: 'ca', viewbox: '-79.7,43.5,-79.1,43.9', bounded: '1', street: addr, city: 'Toronto', country: 'Canada' }),
    new URLSearchParams({ format: 'json', limit: '1', countrycodes: 'ca', viewbox: '-79.7,43.5,-79.1,43.9', bounded: '1', q: addr + ', Toronto, Ontario, Canada' }),
    new URLSearchParams({ format: 'json', limit: '1', countrycodes: 'ca', viewbox: '-79.7,43.5,-79.1,43.9', bounded: '1', q: name + ', ' + addr + ', Toronto, Ontario, Canada' }),
  ];
  for (const qs of attempts) {
    const res = await fetch('https://nominatim.openstreetmap.org/search?' + qs, { headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok) continue;
    const results = await res.json();
    if (results.length > 0) {
      const lat = Math.round(parseFloat(results[0].lat) * 1000000) / 1000000;
      const lng = Math.round(parseFloat(results[0].lon) * 1000000) / 1000000;
      if (lat > 43.5 && lat < 43.9 && lng > -79.7 && lng < -79.1) return { lat, lng };
    }
  }
  return null;
}

async function main() {
  console.log('Tonight.TO Address Fixer');
  const data = JSON.parse(fs.readFileSync(VENUES_PATH, 'utf8'));
  const venues = data.venues || [];
  console.log('Loaded ' + venues.length + ' venues');

  let fixed = 0, failed = 0;

  for (let i = 0; i < venues.length; i++) {
    const v = venues[i];
    process.stdout.write('[' + (i + 1) + '/' + venues.length + '] ' + v.name + '... ');
    if (v.source === 'eventbrite' || v.source === 'meetup') { console.log('skipped'); await new Promise(r => setTimeout(r, 1100)); continue; }
    try {
      const result = await geocode(v.name, v.addr);
      if (result) {
        console.log('OK (' + result.lat + ', ' + result.lng + ')');
        v.lat = result.lat;
        v.lng = result.lng;
        fixed++;
      } else {
        console.log('not found');
        failed++;
      }
    } catch (e) {
      console.log('error: ' + e.message);
      failed++;
    }
    await new Promise(r => setTimeout(r, 1100));
  }

  console.log('Done: ' + fixed + ' updated, ' + failed + ' not found');
  fs.writeFileSync(VENUES_PATH, JSON.stringify(Object.assign({}, data, { updated: new Date().toISOString().split('T')[0], total: venues.length, venues: venues }), null, 2));
  console.log('Saved.');
}

main().catch(function(e) { console.error(e); process.exit(1); });
