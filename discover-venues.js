/**
 * Tonight.TO — Venue Discovery Script
 *
 * Uses Claude web search to find new Toronto venues/events not yet in venues.json.
 * Categories: happy hours, trivia, drag, bingo, live music, open mics, jazz, karaoke
 *
 * Adds discovered venues to venues.json with a `needs_review: true` flag.
 * Review them at tonightto.ca/admin or manually in venues.json before they go live.
 *
 * Run: node scripts/discover-venues.js
 */

const fs    = require('fs');
const path  = require('path');
const https = require('https');

const VENUES_PATH   = path.resolve(__dirname, '..', 'venues.json');
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const GOOGLE_KEY    = process.env.GOOGLE_PLACES_KEY || 'AIzaSyAo5sRSN0Qp7WR3mquuIkzaL51USat-cp8';

const DAYS_ALL = ['mon','tue','wed','thu','fri','sat','sun'];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function postJson(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, path: u.pathname, method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...headers
      },
      timeout: 60000,
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(payload);
    req.end();
  });
}

function fetchJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers, timeout: 12000 }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    }).on('error', reject);
  });
}

// ── Google Places: verify address + get photo ─────────────────────────────────

async function enrichFromGoogle(name, addr) {
  try {
    const q = encodeURIComponent(`${name} ${addr} Toronto`);
    const s = await fetchJson(
      `https://maps.googleapis.com/maps/api/place/findplacefromtext/json?input=${q}&inputtype=textquery&fields=place_id,geometry,formatted_address&key=${GOOGLE_KEY}`
    );
    const pid = s.candidates?.[0]?.place_id;
    if (!pid) return null;

    const d = await fetchJson(
      `https://maps.googleapis.com/maps/api/place/details/json?place_id=${pid}&fields=formatted_address,geometry,photos&key=${GOOGLE_KEY}`
    );
    const r = d.result;
    if (!r) return null;

    let photo = '';
    const photoRef = r.photos?.[0]?.photo_reference;
    if (photoRef) {
      photo = await new Promise(resolve => {
        https.get(
          `https://maps.googleapis.com/maps/api/place/photo?maxwidth=800&photoreference=${photoRef}&key=${GOOGLE_KEY}`,
          res => resolve(res.headers.location || '')
        ).on('error', () => resolve(''));
      });
    }

    return {
      addr: r.formatted_address?.split(',')[0]?.trim() || addr,
      lat: r.geometry?.location?.lat,
      lng: r.geometry?.location?.lng,
      photo: photo?.includes('googleusercontent') ? photo : '',
    };
  } catch(e) {
    return null;
  }
}

// ── Claude web search queries ─────────────────────────────────────────────────

const DISCOVERY_QUERIES = [
  // Happy hours
  {
    type: 'drinkhh',
    label: 'Drink Happy Hours',
    prompt: `Search for the best drink happy hours in Toronto right now in 2025-2026. 
Search BlogTO, NOW Toronto, OpenTable, and Toronto Reddit for "best happy hour Toronto", "Toronto happy hour deals", "new happy hour Toronto bars".
Focus on bars and restaurants NOT commonly known — find hidden gems and newer spots.`,
  },
  {
    type: 'foodhh',
    label: 'Food Happy Hours',
    prompt: `Search for Toronto restaurants with food happy hour deals right now in 2025-2026.
Search for "Toronto food happy hour", "cheap eats happy hour Toronto", "Toronto half price food specials".
Look for places offering discounted bites, apps, or meals during specific hours.`,
  },
  // Events
  {
    type: 'trivia',
    label: 'Trivia Nights',
    prompt: `Search for recurring trivia nights at Toronto bars and restaurants in 2025-2026.
Search "trivia night Toronto", "pub quiz Toronto weekly", "Toronto bar trivia".
Look on BlogTO, NOW Toronto, Eventbrite Toronto, and local bar websites.`,
  },
  {
    type: 'drag',
    label: 'Drag Events',
    prompt: `Search for recurring weekly drag shows, drag brunches, and drag performances at Toronto bars and venues in 2025-2026.
Search "drag show Toronto weekly", "drag brunch Toronto", "drag night Toronto bar", "Toronto drag queen show".
Check Church-Wellesley Village venues, Ossington, Queen West.`,
  },
  {
    type: 'bingo',
    label: 'Bingo Nights',
    prompt: `Search for drag bingo, boozy bingo, and bar bingo nights in Toronto in 2025-2026.
Search "bingo night Toronto bar", "drag bingo Toronto", "boozy bingo Toronto weekly".`,
  },
  {
    type: 'karaoke',
    label: 'Karaoke Nights',
    prompt: `Search for karaoke bars and weekly karaoke nights in Toronto in 2025-2026.
Search "karaoke Toronto weekly", "karaoke bar Toronto", "karaoke night Toronto".
Find both dedicated karaoke bars and bars with weekly karaoke events.`,
  },
  {
    type: 'openmic',
    label: 'Open Mics',
    prompt: `Search for weekly open mic nights at Toronto bars, cafes, and venues in 2025-2026.
Search "open mic Toronto weekly", "open mic night Toronto bar", "Toronto open mic comedy music".
Include comedy open mics, music open mics, and poetry open mics.`,
  },
  {
    type: 'jazz',
    label: 'Jazz Nights',
    prompt: `Search for regular jazz nights, jazz performances, and live jazz at Toronto bars and restaurants in 2025-2026.
Search "jazz night Toronto", "live jazz Toronto bar", "jazz Toronto weekly", "Toronto jazz lounge".
Include brunch jazz, evening jazz sessions, and jazz residencies.`,
  },
  {
    type: 'livemusic',
    label: 'Live Music Venues',
    prompt: `Search for Toronto bars and restaurants with regular weekly live music performances in 2025-2026 — NOT just major concert venues.
Search "live music Toronto bar weekly", "Toronto live music small venue", "bands playing Toronto this week".
Focus on neighbourhood bars, pubs, and restaurants with regular music nights.`,
  },
  {
    type: 'comedy',
    label: 'Comedy Nights',
    prompt: `Search for weekly stand-up comedy nights at Toronto bars and venues in 2025-2026.
Search "comedy night Toronto bar weekly", "stand up comedy Toronto", "Toronto comedy show bar".
Include both dedicated comedy clubs and bars with weekly comedy nights.`,
  },
];

// ── Ask Claude to find venues ─────────────────────────────────────────────────

async function discoverVenues(query, existingNames) {
  if (!ANTHROPIC_KEY) throw new Error('ANTHROPIC_API_KEY not set');

  const existingList = [...existingNames].slice(0, 100).join(', ');

  const prompt = `${query.prompt}

ALREADY IN OUR DATABASE (do not suggest these): ${existingList}

For each venue/event you find, return a JSON array. Each item must have:
- name: venue or event name (string)
- hood: Toronto neighbourhood (string) 
- type: "${query.type}" (string)
- days: array of day keys when this happens e.g. ["mon","wed","fri"] or ["mon","tue","wed","thu","fri","sat","sun"] for daily
- start: start hour as decimal (e.g. 15 = 3pm, 17.5 = 5:30pm)
- end: end hour as decimal
- detail: one sentence describing the deal or event (be specific with prices if available)
- addr: street address in Toronto (just street number and name)
- website: venue website URL if known (or empty string)

Return ONLY a valid JSON array, no markdown, no explanation, no code blocks.
If you find nothing new, return an empty array [].
Find at minimum 3 and up to 10 genuinely new venues/events not in our database.`;

  const res = await postJson('https://api.anthropic.com/v1/messages', {
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 2000,
    tools: [{ type: 'web_search_20250305', name: 'web_search' }],
    messages: [{ role: 'user', content: prompt }],
  }, {
    'x-api-key': ANTHROPIC_KEY,
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'web-search-2025-03-05',
  });

  // Extract text from response blocks
  const text = (res.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('');

  // Parse JSON array from response
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return [];

  try {
    const venues = JSON.parse(match[0]);
    return Array.isArray(venues) ? venues : [];
  } catch(e) {
    console.log(`    ⚠️  JSON parse error: ${e.message}`);
    return [];
  }
}

// ── Validate and clean a discovered venue ─────────────────────────────────────

function validateVenue(v) {
  if (!v.name || typeof v.name !== 'string') return null;
  if (!v.addr || typeof v.addr !== 'string') return null;
  if (!v.type || typeof v.type !== 'string') return null;

  // Ensure days is a valid array
  const validDays = ['mon','tue','wed','thu','fri','sat','sun'];
  const days = Array.isArray(v.days)
    ? v.days.filter(d => validDays.includes(d))
    : DAYS_ALL;
  if (!days.length) return null;

  // Ensure valid times
  const start = parseFloat(v.start);
  const end   = parseFloat(v.end);
  if (isNaN(start) || isNaN(end) || start < 0 || end > 26 || end <= start) return null;

  return {
    name:    v.name.trim(),
    hood:    (v.hood || 'Toronto').trim(),
    type:    v.type,
    days,
    start:   Math.round(start * 4) / 4,
    end:     Math.round(end   * 4) / 4,
    detail:  (v.detail || '').trim(),
    addr:    v.addr.trim().replace(/, Toronto.*/, '').replace(/, ON.*/, ''),
    website: v.website || '',
    photo:   '',
    price:   2,
    wheelchair: false,
    needs_review: true, // Flag for manual review before going live
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Tonight.TO — Venue Discovery');
  console.log('============================\n');

  if (!ANTHROPIC_KEY) {
    console.error('❌ ANTHROPIC_API_KEY not set');
    process.exit(1);
  }

  const data = JSON.parse(fs.readFileSync(VENUES_PATH, 'utf8'));
  const existingNames = new Set(
    data.venues.map(v => v.name.toLowerCase().trim())
  );
  const startCount = data.venues.length;

  console.log(`Existing venues: ${startCount}`);
  console.log(`Running ${DISCOVERY_QUERIES.length} discovery searches...\n`);

  let totalAdded = 0;

  for (const query of DISCOVERY_QUERIES) {
    console.log(`\n🔍 Searching: ${query.label}...`);

    try {
      const found = await discoverVenues(query, existingNames);
      console.log(`   Raw results: ${found.length}`);

      let addedThisRound = 0;

      for (const raw of found) {
        // Skip if already exists
        if (existingNames.has(raw.name?.toLowerCase()?.trim())) {
          console.log(`   ⏭️  Skip (exists): ${raw.name}`);
          continue;
        }

        const venue = validateVenue(raw);
        if (!venue) {
          console.log(`   ⚠️  Invalid: ${raw.name} (missing required fields)`);
          continue;
        }

        // Enrich with Google Places
        process.stdout.write(`   📍 ${venue.name}... `);
        const google = await enrichFromGoogle(venue.name, venue.addr);
        if (google) {
          if (google.addr) venue.addr = google.addr;
          if (google.lat)  venue.lat  = google.lat;
          if (google.lng)  venue.lng  = google.lng;
          if (google.photo) venue.photo = google.photo;
          console.log(`✅ (${venue.addr})`);
        } else {
          // Set rough Toronto coordinates as fallback
          venue.lat = 43.653;
          venue.lng = -79.383;
          console.log(`⚪ (no Google match, using rough coords)`);
        }

        data.venues.push(venue);
        existingNames.add(venue.name.toLowerCase().trim());
        addedThisRound++;
        totalAdded++;

        // Save after each venue
        fs.writeFileSync(VENUES_PATH, JSON.stringify(data, null, 2));
        await sleep(300);
      }

      console.log(`   Added: ${addedThisRound} new venues`);

    } catch(e) {
      console.log(`   ❌ Error: ${e.message}`);
    }

    // Pause between categories to respect rate limits
    await sleep(2000);
  }

  console.log(`\n✅ Discovery complete.`);
  console.log(`   New venues found: ${totalAdded}`);
  console.log(`   Total venues: ${data.venues.length}`);
  console.log(`\n⚠️  New venues are flagged with needs_review: true`);
  console.log(`   Review and set needs_review: false to make them live.`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
