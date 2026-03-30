/**
 * Tonight.TO — Google Maps Photo Fetcher v3
 * Fetches the featured photo URL for each venue using Google Places API.
 * Follows the redirect server-side to get the permanent lh3.googleusercontent.com URL.
 * Saves directly to venues.json as `photo` field.
 *
 * Run via GitHub Actions with GOOGLE_PLACES_KEY secret.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const VENUES_PATH = path.resolve(__dirname, 'venues.json');
const API_KEY = process.env.GOOGLE_PLACES_KEY || 'AIzaSyAo5sRSN0Qp7WR3mquuIkzaL51USat-cp8';

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Fetch a URL and follow redirects, returning the final URL
function getFinalUrl(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.request(url, { method: 'HEAD' }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // Follow the redirect
        getFinalUrl(res.headers.location).then(resolve).catch(reject);
      } else if (res.statusCode === 200) {
        resolve(url);
      } else {
        reject(new Error(`Status ${res.statusCode}`));
      }
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

async function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('JSON parse error')); }
      });
    }).on('error', reject);
  });
}

async function findPlaceId(name, addr) {
  const query = encodeURIComponent(`${name}, ${addr}, Toronto, Ontario, Canada`);
  const url = `https://maps.googleapis.com/maps/api/place/findplacefromtext/json?input=${query}&inputtype=textquery&fields=place_id&key=${API_KEY}`;
  const data = await fetchJson(url);
  return data.candidates?.[0]?.place_id || null;
}

async function getPhotoReference(placeId) {
  const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${placeId}&fields=photos&key=${API_KEY}`;
  const data = await fetchJson(url);
  const photos = data.result?.photos;
  if (!photos?.length) return null;

  // Pick best photo by aspect ratio closest to 16:9 or 4:3
  const IDEAL = 4 / 3;
  const scored = photos.slice(0, 5).map(p => ({
    ref: p.photo_reference,
    score: p.width && p.height ? Math.abs((p.width / p.height) - IDEAL) : 999,
  }));
  scored.sort((a, b) => a.score - b.score);
  return scored[0].ref;
}

async function getPhotoUrl(photoRef) {
  const redirectUrl = `https://maps.googleapis.com/maps/api/place/photo?maxwidth=1200&photo_reference=${photoRef}&key=${API_KEY}`;
  // Follow the redirect to get the permanent lh3.googleusercontent.com URL
  const finalUrl = await getFinalUrl(redirectUrl);
  return finalUrl;
}

async function main() {
  console.log('Tonight.TO — Google Maps Photo Fetcher v3');
  console.log('==========================================');

  const data = JSON.parse(fs.readFileSync(VENUES_PATH, 'utf8'));
  const venues = data.venues || [];

  const needPhotos = venues.filter(v => !v.photo && v.source !== 'ticketmaster' && v.source !== 'eventbrite');
  console.log(`${venues.length} total venues, ${needPhotos.length} need photos\n`);

  let found = 0, failed = 0;

  for (let i = 0; i < venues.length; i++) {
    const v = venues[i];
    if (v.photo || v.source === 'ticketmaster' || v.source === 'eventbrite') continue;

    process.stdout.write(`[${found + failed + 1}/${needPhotos.length}] ${v.name}... `);

    try {
      const placeId = await findPlaceId(v.name, v.addr);
      if (!placeId) {
        console.log('⚠️  place not found');
        failed++;
        await sleep(200);
        continue;
      }

      const photoRef = await getPhotoReference(placeId);
      if (!photoRef) {
        console.log('⚠️  no photos');
        failed++;
        await sleep(200);
        continue;
      }

      const photoUrl = await getPhotoUrl(photoRef);

      // Only save lh3.googleusercontent.com URLs — they're permanent
      if (photoUrl.includes('googleusercontent.com') || photoUrl.includes('googleapis.com')) {
        v.photo = photoUrl;
        found++;
        console.log(`✅ ${photoUrl.slice(0, 70)}...`);
      } else {
        console.log(`⚠️  unexpected URL: ${photoUrl.slice(0, 60)}`);
        failed++;
      }
    } catch (e) {
      console.log(`❌ ${e.message}`);
      failed++;
    }

    // Save after every venue so progress isn't lost if interrupted
    fs.writeFileSync(VENUES_PATH, JSON.stringify({
      ...data,
      updated: new Date().toISOString().split('T')[0],
      total: venues.length,
      venues,
    }, null, 2));

    await sleep(200); // respect rate limits
  }

  console.log(`\nDone: ${found} photos found, ${failed} failed`);
  console.log(`Total with photos: ${venues.filter(v => v.photo).length}/${venues.length}`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
