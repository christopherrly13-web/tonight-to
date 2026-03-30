/**
 * Tonight.TO — Photo Fetcher
 * Uses Google Places API to find one good photo URL per venue
 * and saves it as a `photo` field directly in venues.json.
 *
 * Run: node fetch-photos.cjs
 *
 * Requires: GOOGLE_PLACES_KEY env var (or edit the key below)
 * Output: venues.json updated with `photo` field on each venue
 */

const fs = require('fs');
const path = require('path');

const VENUES_PATH = path.resolve(__dirname, 'venues.json');
const API_KEY = process.env.GOOGLE_PLACES_KEY || 'AIzaSyAo5sRSN0Qp7WR3mquuIkzaL51USat-cp8';

// How many photos to fetch and compare per venue
const PHOTO_CANDIDATES = 5;
// Max width for photo URLs (larger = better quality)
const PHOTO_MAX_WIDTH = 1200;

async function findPlaceId(name, addr) {
  const query = encodeURIComponent(`${name}, ${addr}, Toronto, Ontario`);
  const url = `https://maps.googleapis.com/maps/api/place/findplacefromtext/json?input=${query}&inputtype=textquery&fields=place_id&key=${API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  return data.candidates?.[0]?.place_id || null;
}

async function getPlacePhotos(placeId) {
  const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${placeId}&fields=photos&key=${API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const data = await res.json();
  return data.result?.photos || [];
}

function buildPhotoUrl(photoRef) {
  return `https://maps.googleapis.com/maps/api/place/photo?maxwidth=${PHOTO_MAX_WIDTH}&photo_reference=${photoRef}&key=${API_KEY}`;
}

// Pick best photo: score by how close aspect ratio is to 16:9
// Avoids portraits and ultra-wide banners
function pickBestPhoto(photos) {
  const IDEAL = 16 / 9;
  const candidates = photos.slice(0, PHOTO_CANDIDATES);
  const scored = candidates.map(p => {
    const ratio = p.width && p.height ? p.width / p.height : 0;
    if (ratio < 0.9 || ratio > 2.8) return { p, score: 999 };
    return { p, score: Math.abs(ratio - IDEAL) };
  });
  scored.sort((a, b) => a.score - b.score);
  return scored[0].score === 999 ? candidates[0] : scored[0].p;
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  console.log('Tonight.TO — Photo Fetcher (Google Places Static URLs)');
  console.log('=========================================================');

  const data = JSON.parse(fs.readFileSync(VENUES_PATH, 'utf8'));
  const venues = data.venues || [];
  console.log(`Loaded ${venues.length} venues\n`);

  let found = 0, skipped = 0, failed = 0;

  for (let i = 0; i < venues.length; i++) {
    const v = venues[i];
    process.stdout.write(`[${i + 1}/${venues.length}] ${v.name}... `);

    // Skip if already has a good photo
    if (v.photo && v.photo.includes('googleapis.com')) {
      console.log('already has photo, skipping');
      skipped++;
      continue;
    }

    // Skip external sources
    if (v.source === 'ticketmaster' || v.source === 'eventbrite') {
      console.log('skipped (external source)');
      skipped++;
      continue;
    }

    try {
      const placeId = await findPlaceId(v.name, v.addr);
      if (!placeId) {
        console.log('❌ place not found');
        failed++;
        await sleep(200);
        continue;
      }

      const photos = await getPlacePhotos(placeId);
      if (!photos.length) {
        console.log('⚠️  no photos');
        failed++;
        await sleep(200);
        continue;
      }

      const best = pickBestPhoto(photos);
      const photoUrl = buildPhotoUrl(best.photo_reference);
      v.photo = photoUrl;
      found++;
      console.log(`✅ (${best.width}x${best.height}, ratio ${(best.width/best.height).toFixed(2)})`);
    } catch (e) {
      console.log(`❌ ${e.message}`);
      failed++;
    }

    // Respect Google's rate limits
    await sleep(150);
  }

  console.log(`\nDone: ${found} photos found, ${failed} failed, ${skipped} skipped`);

  fs.writeFileSync(VENUES_PATH, JSON.stringify({
    ...data,
    updated: new Date().toISOString().split('T')[0],
    total: venues.length,
    venues,
  }, null, 2));

  console.log('venues.json saved with photo URLs.');
  console.log('\nNOTE: These are static Google Places photo URLs that include your API key.');
  console.log('They work immediately — no JS SDK needed, just set as background-image.');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
