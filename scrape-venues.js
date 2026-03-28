/**
 * Tonight.TO — Weekly Venue Scraper (v2)
 * Uses Claude AI + web search to find Toronto happy hours and events.
 * Broader search coverage, 2026 queries, geocodes new venues via Nominatim.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const VENUES_PATH = resolve(__dirname, '..', 'venues.json');
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const USER_AGENT = 'TonightTO/1.0 (https://tonightto.ca/)';

if (!ANTHROPIC_KEY) { console.error('Missing ANTHROPIC_API_KEY'); process.exit(1); }

// ── SEARCHES ──────────────────────────────────────────────────────────────────
const SEARCHES = [
  // BlogTO
  'site:blogto.com Toronto happy hour bars 2026',
  'site:blogto.com Toronto food happy hour deals 2026',
  'site:blogto.com Toronto trivia nights weekly 2026',
  'site:blogto.com Toronto karaoke bars 2026',
  'site:blogto.com Toronto live music venues weekly 2026',
  'site:blogto.com Toronto comedy nights bars 2026',
  'site:blogto.com Toronto drag shows bars 2026',
  'site:blogto.com Toronto DJ nights bars 2026',
  'site:blogto.com Toronto open mic nights 2026',
  'site:blogto.com Toronto jazz bars weekly 2026',
  'site:blogto.com Toronto bingo nights bars 2026',
  // NOW Toronto
  'site:nowtoronto.com Toronto happy hour specials bars 2026',
  'site:nowtoronto.com Toronto trivia comedy karaoke weekly 2026',
  'site:nowtoronto.com Toronto live music jazz bars weekly 2026',
  'site:nowtoronto.com Toronto drag shows bingo nights 2026',
  // Toronto Life
  'site:torontolife.com best happy hour bars Toronto 2026',
  'site:torontolife.com best trivia nights Toronto bars 2026',
  'site:torontolife.com best karaoke bars Toronto 2026',
  'site:torontolife.com best comedy nights Toronto 2026',
  'site:torontolife.com best jazz bars Toronto 2026',
  // Streets of Toronto
  'site:streetsoftoronto.com Toronto happy hour bars 2026',
  'site:streetsoftoronto.com Toronto weekly events bars 2026',
  // Yelp
  'site:yelp.ca happy hour bars Toronto Ontario 2026',
  'site:yelp.ca trivia night bars Toronto Ontario 2026',
  'site:yelp.ca karaoke bars Toronto Ontario 2026',
  // Neighbourhood specific
  'Toronto Kensington Market bar happy hour weekly 2026',
  'Toronto Leslieville bar happy hour trivia weekly 2026',
  'Toronto Liberty Village bar happy hour weekly 2026',
  'Toronto Danforth bar happy hour trivia weekly 2026',
  'Toronto Ossington bar happy hour weekly 2026',
  'Toronto King West bar happy hour weekly 2026',
  'Toronto Queen West bar happy hour weekly 2026',
  'Toronto Annex bar trivia karaoke weekly 2026',
  'Toronto Parkdale bar happy hour weekly 2026',
  'Toronto Yorkville bar happy hour weekly 2026',
  // Event type specific
  'Toronto pub trivia night weekly bar 2026',
  'Toronto karaoke night weekly bar 2026',
  'Toronto drag show weekly bar 2026',
  'Toronto jazz night weekly bar 2026',
  'Toronto open mic night weekly bar 2026',
  'Toronto bingo night bar weekly 2026',
  'Toronto comedy night bar weekly 2026',
  'Toronto DJ night bar weekly 2026',
  'Toronto live music bar weekly 2026',
  // Happy hour specific
  'Toronto best drink happy hour specials bars 2026',
  'Toronto best food happy hour specials bars 2026',
  'Toronto all day happy hour bars 2026',
  'Toronto late night happy hour bars 2026',
  'Toronto rooftop bar happy hour 2026',
  'Toronto patio bar happy hour 2026',
];

const SYSTEM_PROMPT = `You are a Toronto nightlife researcher. Extract venue info from web search results.

Output a JSON array of objects with these fields:
- name: venue/bar name (not event title)
- hood: Toronto neighbourhood
- type: one of: drinkhh, foodhh, trivia, karaoke, livemusic, jazz, comedy, drag, dj, bingo, openmic
- days: array of: "mon","tue","wed","thu","fri","sat","sun"
- start: 24hr decimal (17=5pm, 17.5=5:30pm, 21=9pm)
- end: 24hr decimal (use >24 for after midnight: 25=1am)
- detail: specific prices and what's included
- addr: full street address with number

Rules: Toronto only. Recurring weekly events only. Address must have a street number. Return ONLY valid JSON array, no markdown.`;

// ── GEOCODE via Nominatim ─────────────────────────────────────────────────────
async function geocode(name, addr) {
  const attempts = [
    new URLSearchParams({ format: 'json', limit: '1', countrycodes: 'ca', viewbox: '-79.7,43.5,-79.1,43.9', bounded: '1', street: addr, city: 'Toronto', country: 'Canada' }),
    new URLSearchParams({ format: 'json', limit: '1', countrycodes: 'ca', viewbox: '-79.7,43.5,-79.1,43.9', bounded: '1', q: addr + ', Toronto, Ontario, Canada' }),
    new URLSearchParams({ format: 'json', limit: '1', countrycodes: 'ca', viewbox: '-79.7,43.5,-79.1,43.9', bounded: '1', q: name + ', Toronto, Ontario, Canada' }),
  ];
  for (const qs of attempts) {
    try {
      const res = await fetch('https://nominatim.openstreetmap.org/search?' + qs, { headers: { 'User-Agent': USER_AGENT } });
      if (!res.ok) continue;
      const results = await res.json();
      if (results.length > 0) {
        const lat = Math.round(parseFloat(results[0].lat) * 1000000) / 1000000;
        const lng = Math.round(parseFloat(results[0].lon) * 1000000) / 1000000;
        if (lat > 43.5 && lat < 43.9 && lng > -79.7 && lng < -79.1) return { lat, lng };
      }
    } catch(e) { continue; }
    await new Promise(r => setTimeout(r, 1100));
  }
  return null;
}

// ── CLAUDE API CALL ───────────────────────────────────────────────────────────
async function callClaude(query) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'web-search-2025-03-05',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2000,
      system: SYSTEM_PROMPT,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{ role: 'user', content: 'Search for and list Toronto venues: ' + query + '\n\nReturn ONLY a JSON array of venue objects.' }],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error('Claude API ' + response.status + ': ' + err.slice(0, 200));
  }

  const data = await response.json();
  const textBlock = data.content.find(b => b.type === 'text');
  if (!textBlock) return [];

  try {
    const cleaned = textBlock.text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    // Extract JSON array even if there's surrounding text
    const match = cleaned.match(/\[[\s\S]*\]/);
    if (!match) return [];
    const parsed = JSON.parse(match[0]);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.warn('  Could not parse response: ' + e.message);
    return [];
  }
}

// ── HELPERS ───────────────────────────────────────────────────────────────────
const VALID_TYPES = new Set(['drinkhh','foodhh','happyhour','trivia','karaoke','livemusic','jazz','comedy','drag','dj','bingo','openmic']);
const VALID_DAYS = new Set(['mon','tue','wed','thu','fri','sat','sun']);

function normalize(v) {
  return {
    name: String(v.name || '').trim(),
    hood: String(v.hood || 'Toronto').trim(),
    type: VALID_TYPES.has(v.type) ? v.type : 'happyhour',
    days: Array.isArray(v.days) ? v.days.map(d => String(d).toLowerCase().slice(0,3)).filter(d => VALID_DAYS.has(d)) : [],
    start: Number(v.start) || 17,
    end: Number(v.end) || 19,
    detail: String(v.detail || '').trim(),
    addr: String(v.addr || '').trim(),
    lat: Number(v.lat) || 0,
    lng: Number(v.lng) || 0,
  };
}

function isValid(v) {
  return v.name.length > 1 &&
    v.days.length > 0 &&
    v.detail.length > 5 &&
    v.addr.length > 3 &&
    v.addr.match(/\d/); // address must contain a number
}

function deduplicate(existing, incoming) {
  const seen = new Set(existing.map(v => v.name.toLowerCase().replace(/[^a-z0-9]/g, '')));
  return incoming.filter(v => {
    const key = v.name.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('Tonight.TO Weekly Scraper v2');
  console.log('============================');

  let existing = [];
  try {
    if (existsSync(VENUES_PATH)) {
      const data = JSON.parse(readFileSync(VENUES_PATH, 'utf8'));
      existing = data.venues || [];
      console.log('Loaded ' + existing.length + ' existing venues');
    }
  } catch(e) { console.log('Could not read venues.json:', e.message); }

  const allFound = [];
  for (let i = 0; i < SEARCHES.length; i++) {
    const query = SEARCHES[i];
    console.log('\n[' + (i+1) + '/' + SEARCHES.length + '] ' + query);
    try {
      const found = await callClaude(query);
      const normalized = found.map(normalize).filter(isValid);
      console.log('  Found ' + normalized.length + ' valid venues');
      normalized.forEach(v => console.log('    - ' + v.name + ' (' + v.addr + ')'));
      allFound.push(...normalized);
      await new Promise(r => setTimeout(r, 8000)); // 8s between calls to stay under rate limit
    } catch (e) {
      console.error('  Error: ' + e.message);
      await new Promise(r => setTimeout(r, 15000));
    }
  }

  console.log('\nTotal found across all searches: ' + allFound.length);
  const newVenues = deduplicate(existing, allFound);
  console.log('New venues (not already listed): ' + newVenues.length);

  // Geocode all new venues
  console.log('\nGeocoding new venues...');
  for (let i = 0; i < newVenues.length; i++) {
    const v = newVenues[i];
    process.stdout.write('[' + (i+1) + '/' + newVenues.length + '] ' + v.name + '... ');
    // Skip if already has valid Toronto coords
    if (v.lat > 43.5 && v.lat < 43.9 && v.lng > -79.7 && v.lng < -79.1) {
      console.log('coords ok');
      continue;
    }
    const coords = await geocode(v.name, v.addr);
    if (coords) {
      v.lat = coords.lat;
      v.lng = coords.lng;
      console.log('OK (' + coords.lat + ', ' + coords.lng + ')');
    } else {
      // Use approximate Toronto centre as fallback
      v.lat = 43.6532;
      v.lng = -79.3832;
      console.log('not found - using Toronto centre');
    }
    await new Promise(r => setTimeout(r, 1100));
  }

  newVenues.forEach(v => console.log('  + ' + v.name + ' (' + v.hood + ') — ' + v.type));

  const merged = [...existing, ...newVenues];
  writeFileSync(VENUES_PATH, JSON.stringify({
    version: 1,
    updated: new Date().toISOString().split('T')[0],
    total: merged.length,
    venues: merged,
  }, null, 2));

  console.log('\nDone: ' + existing.length + ' existing + ' + newVenues.length + ' new = ' + merged.length + ' total venues');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
