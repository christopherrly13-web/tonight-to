/**
 * Tonight.TO — Weekly Venue Scraper (v3)
 * Uses Claude's knowledge (no web search) to find new Toronto venues.
 * No rate limit issues. Geocodes new venues via Nominatim.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const VENUES_PATH = resolve(__dirname, '..', 'venues.json');
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const USER_AGENT = 'TonightTO/1.0 (https://tonightto.ca/)';

if (!ANTHROPIC_KEY) { console.error('Missing ANTHROPIC_API_KEY'); process.exit(1); }

// One prompt per category — Claude knows Toronto venues well
const PROMPTS = [
  'List 15 Toronto bars and restaurants with drink happy hours (drinkhh) not already in this list. Focus on well-known spots with real addresses.',
  'List 15 Toronto bars and restaurants with food happy hour deals (foodhh) not already in this list. Include spots known for cheap food deals.',
  'List 15 Toronto bars that host weekly pub trivia nights not already in this list.',
  'List 15 Toronto bars with weekly karaoke nights not already in this list.',
  'List 15 Toronto bars and venues with weekly live music (livemusic) not already in this list.',
  'List 15 Toronto bars with weekly jazz performances (jazz) not already in this list.',
  'List 15 Toronto venues with weekly comedy nights (comedy) not already in this list.',
  'List 15 Toronto bars with weekly drag shows (drag) not already in this list.',
  'List 15 Toronto bars with weekly DJ nights (dj) not already in this list.',
  'List 15 Toronto bars with weekly bingo nights (bingo) not already in this list.',
  'List 15 Toronto venues with weekly open mic nights (openmic) not already in this list.',
];

const SYSTEM_PROMPT = `You are a Toronto nightlife expert with deep knowledge of bars, restaurants and event venues in Toronto, Ontario, Canada.

Given a list of venues already in a database, suggest NEW venues not yet included.

For each venue output a JSON object:
- name: string (venue name)
- hood: string (Toronto neighbourhood e.g. King West, Queen West, Ossington, Kensington, Annex, Yorkville, Danforth, Leslieville, Parkdale, Liberty Village, Financial, Distillery, Church, Midtown, Bloordale, Geary, Trinity Bellwoods, Riverside, Corktown, Harbourfront)
- type: string (one of: drinkhh, foodhh, trivia, karaoke, livemusic, jazz, comedy, drag, dj, bingo, openmic)
- days: array (subset of: "mon","tue","wed","thu","fri","sat","sun")
- start: number (24hr decimal: 16=4pm, 17=5pm, 17.5=5:30pm, 20=8pm, 21=9pm, 22=10pm)
- end: number (24hr decimal: use >24 for after midnight: 25=1am, 26=2am)
- detail: string (specific details, prices if known, what makes it notable)
- addr: string (real street address with number, e.g. "123 King St W")

Only include real, currently operating Toronto venues you are confident about.
Only include venues with real street addresses you know.
Return ONLY a valid JSON array, no markdown, no explanation.`;

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

async function callClaude(prompt, existingNames) {
  const existingList = existingNames.slice(0, 100).join(', ');
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 3000,
      system: SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: prompt + '\n\nAlready in database (do NOT include these): ' + existingList + '\n\nReturn ONLY a JSON array.'
      }],
    }),
  });

  if (response.status === 429) {
    console.log('  Rate limited - waiting 30s...');
    await new Promise(r => setTimeout(r, 30000));
    return callClaude(prompt, existingNames);
  }

  if (!response.ok) {
    const err = await response.text();
    throw new Error('Claude API ' + response.status + ': ' + err.slice(0, 200));
  }

  const data = await response.json();
  const textBlock = data.content.find(b => b.type === 'text');
  if (!textBlock) return [];

  try {
    const cleaned = textBlock.text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const match = cleaned.match(/\[[\s\S]*\]/);
    if (!match) return [];
    const parsed = JSON.parse(match[0]);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.warn('  Could not parse: ' + e.message);
    return [];
  }
}

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
    v.addr.match(/\d/);
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

async function main() {
  console.log('Tonight.TO Weekly Scraper v3 (knowledge-based)');
  console.log('================================================');

  let existing = [];
  try {
    if (existsSync(VENUES_PATH)) {
      const data = JSON.parse(readFileSync(VENUES_PATH, 'utf8'));
      existing = data.venues || [];
      console.log('Loaded ' + existing.length + ' existing venues');
    }
  } catch(e) { console.log('Could not read venues.json:', e.message); }

  const existingNames = existing.map(v => v.name);
  const allFound = [];

  for (let i = 0; i < PROMPTS.length; i++) {
    const prompt = PROMPTS[i];
    console.log('\n[' + (i+1) + '/' + PROMPTS.length + '] ' + prompt.slice(0, 60) + '...');
    try {
      const found = await callClaude(prompt, existingNames);
      const normalized = found.map(normalize).filter(isValid);
      console.log('  Found ' + normalized.length + ' valid venues');
      normalized.forEach(v => console.log('    - ' + v.name + ' (' + v.addr + ')'));
      allFound.push(...normalized);
      await new Promise(r => setTimeout(r, 3000));
    } catch (e) {
      console.error('  Error: ' + e.message);
    }
  }

  console.log('\nTotal found: ' + allFound.length);
  const newVenues = deduplicate(existing, allFound);
  console.log('New venues: ' + newVenues.length);

  console.log('\nGeocoding new venues...');
  for (let i = 0; i < newVenues.length; i++) {
    const v = newVenues[i];
    process.stdout.write('[' + (i+1) + '/' + newVenues.length + '] ' + v.name + '... ');
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
      v.lat = 43.6532;
      v.lng = -79.3832;
      console.log('not found - using Toronto centre');
    }
    await new Promise(r => setTimeout(r, 1100));
  }

  newVenues.forEach(v => console.log('  + ' + v.name + ' (' + v.hood + ') - ' + v.type));

  const merged = [...existing, ...newVenues];
  writeFileSync(VENUES_PATH, JSON.stringify({
    version: 1,
    updated: new Date().toISOString().split('T')[0],
    total: merged.length,
    venues: merged,
  }, null, 2));

  console.log('\nDone: ' + existing.length + ' existing + ' + newVenues.length + ' new = ' + merged.length + ' total');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
