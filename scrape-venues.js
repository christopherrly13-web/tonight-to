/**
 * Tonight.TO — Weekly Venue Scraper
 * Uses Claude AI with web search to find Toronto happy hours and events.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const VENUES_PATH = resolve(__dirname, '..', 'venues.json');

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_KEY) {
  console.error('Missing ANTHROPIC_API_KEY environment variable');
  process.exit(1);
}

// ── SEARCHES ─────────────────────────────────────────────────────────────────

const SEARCHES = [
  'site:blogto.com Toronto happy hour bars 2025',
  'site:blogto.com Toronto food happy hour deals 2025',
  'site:blogto.com Toronto trivia nights weekly 2025',
  'site:blogto.com Toronto karaoke bars 2025',
  'site:blogto.com Toronto live music venues weekly 2025',
  'site:blogto.com Toronto comedy nights 2025',
  'site:blogto.com Toronto drag shows 2025',
  'site:blogto.com Toronto DJ nights bars 2025',
  'site:blogto.com Toronto open mic nights 2025',
  'site:blogto.com Toronto bingo nights 2025',
  'site:nowtoronto.com Toronto happy hour bars 2025',
  'site:nowtoronto.com Toronto weekly events bars 2025',
  'site:nowtoronto.com Toronto trivia comedy drag shows 2025',
  'site:nowtoronto.com Toronto live music jazz venues 2025',
  'site:nowtoronto.com Toronto karaoke open mic nights 2025',
];

const SYSTEM_PROMPT = `You are a Toronto nightlife researcher. Find venues that host happy hours and regular weekly events in Toronto.

When searching Eventbrite, Meetup, BlogTO, NOW Toronto, or other event listing sites, extract the specific venue name, address, and event details from the listings you find. For Eventbrite events include the event URL. For recurring Meetup events extract the host venue location.

For each venue output a JSON object with EXACTLY these fields:
- name: string (the venue/bar/club name — not the event title)
- hood: string (one of: Annex, Bloordale, Bloor West, Chinatown, Church, Corktown, Danforth, Distillery, Entertainment, Fashion District, Financial, Geary, Harbourfront, Kensington, King West, Leslieville, Liberty Village, Midtown, Ossington, Parkdale, Queen West, Riverside, Rosedale, Summerhill, Trinity Bellwoods, Yorkville)
- type: string (one of: drinkhh, foodhh, happyhour, trivia, karaoke, livemusic, jazz, comedy, drag, dj, bingo, openmic)
- days: array of strings from: "mon","tue","wed","thu","fri","sat","sun"
- start: number (24hr decimal — 17 = 5pm, 17.5 = 5:30pm)
- end: number (24hr decimal — use >24 for after midnight e.g. 25 = 1am)
- detail: string (specific prices, what's included, ticket cost if from Eventbrite — be concrete)
- addr: string (street address in Toronto)
- lat: number (~43.65 for downtown Toronto)
- lng: number (~-79.38 for downtown Toronto)
- url: string (optional — include Eventbrite or Meetup URL if available)
- source: string (optional — "eventbrite", "meetup", or omit if general)

Only include Toronto, Ontario events. Only include venues you are confident about.
Respond with ONLY a valid JSON array. No markdown, no explanation.`;

// ── API CALL ──────────────────────────────────────────────────────────────────

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
      messages: [{ role: 'user', content: `Search for and list Toronto venues: ${query}\n\nReturn ONLY a JSON array.` }],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Claude API ${response.status}: ${err.slice(0, 200)}`);
  }

  const data = await response.json();
  const textBlock = data.content.find(b => b.type === 'text');
  if (!textBlock) return [];

  try {
    const cleaned = textBlock.text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(cleaned);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.warn(`  Could not parse response: ${e.message}`);
    console.warn(`  Raw snippet: ${textBlock.text.slice(0, 150)}`);
    return [];
  }
}

// ── HELPERS ───────────────────────────────────────────────────────────────────

function normalize(v) {
  const out = {
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
  if (v.url) out.url = String(v.url).trim();
  if (v.source) out.source = String(v.source).trim();
  return out;
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
      existing = data.venues || [];
      console.log(`Loaded ${existing.length} existing venues`);
    }
  } catch(e) {
    console.log('Could not read venues.json:', e.message);
  }

  // Run all Claude searches
  const allFound = [];
  for (const query of SEARCHES) {
    console.log(`\nSearching: "${query}"`);
    try {
      const found = await callClaude(query);
      const normalized = found.map(normalize).filter(isValid);
      console.log(`  Found ${normalized.length} valid venues`);
      allFound.push(...normalized);
      await new Promise(r => setTimeout(r, 1500));
    } catch (e) {
      console.error(`  Error: ${e.message}`);
    }
  }

  console.log(`\nTotal found: ${allFound.length}`);

  const newVenues = deduplicate(existing, allFound);
  console.log(`New (not already listed): ${newVenues.length}`);
  newVenues.forEach(v => console.log(`  + ${v.name} (${v.hood}) — ${v.type}`));

  const merged = [...existing, ...newVenues];

  if (merged.length === 0) {
    console.log('Nothing to write — keeping existing data');
    process.exit(0);
  }

  writeFileSync(VENUES_PATH, JSON.stringify({
    version: 1,
    updated: new Date().toISOString().split('T')[0],
    total: merged.length,
    venues: merged,
  }, null, 2));

  console.log(`\nDone: ${merged.length} total venues`);
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});

