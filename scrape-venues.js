/**
 * Tonight.TO — Weekly Venue Scraper
 * 
 * Uses the Claude API (with web search) to find new Toronto happy hours
 * and events, then merges them with the existing venues.json.
 * 
 * Run: ANTHROPIC_API_KEY=sk-... node scripts/scrape-venues.js
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// venues.json lives in the repo root, one level up from scripts/
const VENUES_PATH = resolve(__dirname, '..', 'venues.json');

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  console.error('Missing ANTHROPIC_API_KEY environment variable');
  process.exit(1);
}

// ── CONFIG ────────────────────────────────────────────────────────────────────

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

Only include venues you are confident about. Include the lat/lng if you know the address (estimate from the address if needed — Toronto's downtown is roughly 43.65, -79.38).

Respond with ONLY a JSON array of venue objects, no other text, no markdown fences.`;

// ── HELPERS ──────────────────────────────────────────────────────────────────

async function callClaude(query) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
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
  
  // Extract the text response (Claude may use web search tool first)
  const textBlock = data.content.find(b => b.type === 'text');
  if (!textBlock) return [];

  try {
    // Clean up any accidental markdown fences
    const cleaned = textBlock.text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(cleaned);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.warn(`  ⚠️  Could not parse response for "${query}":`, e.message);
    console.warn('  Raw:', textBlock.text.slice(0, 200));
    return [];
  }
}

function normalizeVenue(v) {
  // Ensure all required fields, coerce types
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
  };
}

function isValid(v) {
  return v.name && v.hood && v.days.length > 0 && v.detail && v.addr;
}

function deduplicateVenues(existing, incoming) {
  const existingNames = new Set(
    existing.map(v => v.name.toLowerCase().replace(/[^a-z0-9]/g, ''))
  );
  
  const newVenues = incoming.filter(v => {
    const key = v.name.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (existingNames.has(key)) return false;
    existingNames.add(key); // prevent dupes within incoming batch too
    return true;
  });

  return newVenues;
}

// ── MAIN ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🍺 Tonight.TO Weekly Venue Scraper');
  console.log('===================================');

  // Load existing venues
  let existing = [];
  try {
    if (existsSync(VENUES_PATH)) {
      const data = JSON.parse(readFileSync(VENUES_PATH, 'utf8'));
      existing = data.venues || [];
      console.log(`Loaded ${existing.length} existing venues from ${VENUES_PATH}`);
    } else {
      console.log('No existing venues.json found — starting fresh');
    }
  } catch(e) {
    console.log('Could not read venues.json:', e.message);
  }

  // Run all searches
  const allFound = [];
  for (const query of SEARCHES) {
    console.log(`\n🔍 Searching: "${query}"`);
    try {
      const found = await callClaude(query);
      const normalized = found.map(normalizeVenue).filter(isValid);
      console.log(`  ✅ Found ${normalized.length} valid venues`);
      allFound.push(...normalized);
      // Brief pause between API calls to be polite
      await new Promise(r => setTimeout(r, 1500));
    } catch (e) {
      console.error(`  ❌ Error: ${e.message}`);
    }
  }

  console.log(`\n📊 Total found across all searches: ${allFound.length}`);

  // Deduplicate against existing
  const newVenues = deduplicateVenues(existing, allFound);
  console.log(`✨ New venues not already in list: ${newVenues.length}`);

  if (newVenues.length > 0) {
    console.log('\nNew venues added:');
    newVenues.forEach(v => console.log(`  + ${v.name} (${v.hood}) — ${v.type}`));
  }

  // Merge and write
  const merged = [...existing, ...newVenues];
  const output = {
    version: 1,
    updated: new Date().toISOString().split('T')[0],
    total: merged.length,
    venues: merged,
  };

  writeFileSync(VENUES_PATH, JSON.stringify(output, null, 2));
  console.log(`venues.json updated: ${merged.length} total venues (${newVenues.length} new) at ${VENUES_PATH}`);
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
