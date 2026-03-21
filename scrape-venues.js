/**
 * Tonight.TO — Weekly Venue Scraper
 * Pulls from Claude AI web search + Eventbrite API
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const VENUES_PATH = resolve(__dirname, '..', 'venues.json');

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const EB_KEY = process.env.EVENTBRITE_API_KEY || 'LXGRIMIHHPLUZOD2SMPP';

if (!ANTHROPIC_KEY) {
  console.error('Missing ANTHROPIC_API_KEY environment variable');
  process.exit(1);
}

const DKEYS = ['sun','mon','tue','wed','thu','fri','sat'];

// ── EVENTBRITE ────────────────────────────────────────────────────────────────

async function fetchEventbriteEvents() {
  console.log('\n🎟 Fetching Eventbrite events...');
  try {
    const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    const future = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

    const url = `https://www.eventbriteapi.com/v3/events/search/` +
      `?location.latitude=43.6532&location.longitude=-79.3832` +
      `&location.within=15km` +
      `&start_date.range_start=${now}` +
      `&start_date.range_end=${future}` +
      `&expand=venue` +
      `&page_size=50` +
      `&sort_by=date`;

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${EB_KEY}` }
    });

    if (!res.ok) {
      const err = await res.text();
      console.warn(`  Eventbrite error ${res.status}:`, err.slice(0, 200));
      return [];
    }

    const data = await res.json();
    const events = data.events || [];
    console.log(`  Found ${events.length} raw Eventbrite events`);

    const DKEYS_MAP = ['sun','mon','tue','wed','thu','fri','sat'];

    return events.map(ev => {
      const venue = ev.venue || {};
      const addr = venue.address || {};
      const start = new Date(ev.start?.local);
      const end = new Date(ev.end?.local);
      const startH = start.getHours() + start.getMinutes() / 60;
      const endH = end.getHours() + end.getMinutes() / 60 || startH + 2;
      const dayKey = DKEYS_MAP[start.getDay()];

      // Guess type from event name
      const nameLower = (ev.name?.text || '').toLowerCase();
      let type = 'livemusic';
      if (nameLower.includes('trivia') || nameLower.includes('quiz')) type = 'trivia';
      else if (nameLower.includes('karaoke')) type = 'karaoke';
      else if (nameLower.includes('comedy') || nameLower.includes('stand-up') || nameLower.includes('standup')) type = 'comedy';
      else if (nameLower.includes('drag')) type = 'drag';
      else if (nameLower.includes('jazz')) type = 'jazz';
      else if (nameLower.includes('bingo')) type = 'bingo';
      else if (nameLower.includes('open mic') || nameLower.includes('open-mic')) type = 'openmic';
      else if (nameLower.includes(' dj ') || nameLower.includes('dj night') || nameLower.includes('dj set')) type = 'dj';
      else if (nameLower.includes('happy hour')) type = 'drinkhh';

      const price = ev.is_free ? 'Free entry' :
        ev.ticket_availability?.minimum_ticket_price?.display
          ? `From ${ev.ticket_availability.minimum_ticket_price.display}`
          : 'Tickets available';

      const summary = (ev.summary || ev.description?.text || '').slice(0, 100).replace(/\n/g, ' ');

      return {
        name: ev.name?.text || 'Unnamed Event',
        hood: addr.localized_area_display || 'Toronto',
        type,
        days: [dayKey],
        start: startH,
        end: endH,
        detail: `${summary}. ${price}.`.trim(),
        addr: addr.address_1 || addr.localized_address_display || 'Toronto',
        lat: parseFloat(venue.latitude) || 43.6532,
        lng: parseFloat(venue.longitude) || -79.3832,
        url: ev.url,
        source: 'eventbrite',
      };
    }).filter(v => v.name && v.days[0] && v.addr && v.addr !== 'Toronto');

  } catch (e) {
    console.warn('  Eventbrite fetch failed:', e.message);
    return [];
  }
}

// ── CLAUDE WEB SEARCH ─────────────────────────────────────────────────────────

const SEARCHES = [
  'Toronto happy hour deals drinks 2025 new',
  'Toronto food happy hour oysters deals 2025',
  'Toronto trivia nights weekly pub quiz 2025',
  'Toronto karaoke bars weekly nights 2025',
  'Toronto live music weekly jazz venues 2025',
  'Toronto comedy nights weekly shows 2025',
  'Toronto drag shows weekly Church Street 2025',
  'Toronto DJ nights weekly bars 2025',
  'Toronto open mic nights weekly 2025',
];

const SYSTEM_PROMPT = `You are a Toronto nightlife researcher. Your job is to find venues that host happy hours and regular weekly events in Toronto. 

For each venue you find, output a JSON object with these exact fields:
- name: string (venue name)
- hood: string (Toronto neighbourhood — use one of: Annex, Bloordale, Bloor West, Chinatown, Church, Corktown, Danforth, Distillery, Entertainment, Fashion District, Financial, Geary, Harbourfront, Kensington, King West, Leslieville, Liberty Village, Midtown, Ossington, Parkdale, Queen West, Riverside, Rosedale, Summerhill, Trinity Bellwoods, Yorkville)
- type: string (one of: drinkhh, foodhh, happyhour, trivia, karaoke, livemusic, jazz, comedy, drag, dj, bingo, openmic)
- days: array of strings (subset of: "mon","tue","wed","thu","fri","sat","sun")
- start: number (24hr decimal, e.g. 17 for 5pm, 17.5 for 5:30pm)
- end: number (24hr decimal, use numbers > 24 for after midnight, e.g. 25 for 1am)
- detail: string (specific deal details — prices, what's included, any special notes. Be specific.)
- addr: string (street address)
- lat: number (latitude, Toronto area ~43.65)
- lng: number (longitude, Toronto area ~-79.38)

Only include venues you are confident about.
Respond with ONLY a JSON array of venue objects, no other text, no markdown fences.`;

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
      model: 'claude-sonnet-4-5',
      max_tokens: 4000,
      system: SYSTEM_PROMPT,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{ role: 'user', content: `Search for: ${query}\n\nFind specific venues with confirmed details. Return as a JSON array.` }],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Claude API error ${response.status}: ${err}`);
  }

  const data = await response.json();
  const textBlock = data.content.find(b => b.type === 'text');
  if (!textBlock) return [];

  try {
    const cleaned = textBlock.text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return JSON.parse(cleaned);
  } catch (e) {
    console.warn(`  Could not parse response for "${query}":`, e.message);
    return [];
  }
}

function normalizeVenue(v) {
  return {
    name: String(v.name || '').trim(),
    hood: String(v.hood || '').trim(),
    type: String(v.type || 'happyhour').trim(),
    days: Array.isArray(v.days) ? v.days.map(d => String(d).toLowerCase().slice(0, 3)) : [],
    start: Number(v.start) || 17,
    end: Number(v.end) || 19,
    detail: String(v.detail || '').trim(),
    addr: String(v.addr || '').trim(),
    lat: Number(v.lat) || 43.65,
    lng: Number(v.lng) || -79.38,
    ...(v.url ? { url: v.url } : {}),
    ...(v.source ? { source: v.source } : {}),
  };
}

function isValid(v) {
  return v.name && v.hood && v.days.length > 0 && v.detail && v.addr;
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
  console.log('Tonight.TO Weekly Scraper');
  console.log('=========================');

  // Load existing venues
  let existing = [];
  try {
    if (existsSync(VENUES_PATH)) {
      const data = JSON.parse(readFileSync(VENUES_PATH, 'utf8'));
      // Strip old eventbrite entries so they get refreshed each week
      existing = (data.venues || []).filter(v => v.source !== 'eventbrite');
      console.log(`Loaded ${existing.length} existing curated venues`);
    }
  } catch(e) {
    console.log('Could not read venues.json:', e.message);
  }

  // 1. Fetch Eventbrite events (server-side, no CORS issues)
  const ebRaw = await fetchEventbriteEvents();
  const ebVenues = ebRaw.map(normalizeVenue).filter(isValid);
  console.log(`  ${ebVenues.length} valid Eventbrite events`);

  // 2. Run Claude web searches
  const claudeFound = [];
  for (const query of SEARCHES) {
    console.log(`\nSearching: "${query}"`);
    try {
      const found = await callClaude(query);
      const normalized = found.map(normalizeVenue).filter(isValid);
      console.log(`  Found ${normalized.length} valid venues`);
      claudeFound.push(...normalized);
      await new Promise(r => setTimeout(r, 1500));
    } catch (e) {
      console.error(`  Error: ${e.message}`);
    }
  }

  // 3. Deduplicate and merge
  const newCurated = deduplicate(existing, claudeFound);
  const newEb = deduplicate([...existing, ...newCurated], ebVenues);

  console.log(`\nNew curated venues: ${newCurated.length}`);
  console.log(`New Eventbrite events: ${newEb.length}`);

  newCurated.forEach(v => console.log(`  + ${v.name} (${v.hood})`));
  newEb.forEach(v => console.log(`  🎟 ${v.name} (${v.hood})`));

  const merged = [...existing, ...newCurated, ...newEb];

  if (merged.length === 0) {
    console.log('Nothing to write — aborting to protect existing data');
    process.exit(0);
  }

  writeFileSync(VENUES_PATH, JSON.stringify({
    version: 1,
    updated: new Date().toISOString().split('T')[0],
    total: merged.length,
    venues: merged,
  }, null, 2));

  console.log(`\nDone: ${merged.length} total venues written`);
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
