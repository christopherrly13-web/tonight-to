/**
 * Tonight.TO — Weekly Venue Scraper (v4)
 * Hybrid: web search (Reddit, Instagram, Google Maps, BlogTO) + Claude knowledge
 * Reads public social media pages the same way a human would browsing the web.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const VENUES_PATH = resolve(__dirname, '..', 'venues.json');
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const USER_AGENT = 'TonightTO/1.0 (https://tonightto.ca/)';

if (!ANTHROPIC_KEY) { console.error('Missing ANTHROPIC_API_KEY'); process.exit(1); }

// ── SEARCH QUERIES ────────────────────────────────────────────────────────────
// These target public posts, threads and pages — no API auth required
const WEB_SEARCHES = [
  // Reddit — public posts, highly relevant local knowledge
  'site:reddit.com/r/toronto happy hour bar deals 2026',
  'site:reddit.com/r/toronto trivia night bar weekly 2026',
  'site:reddit.com/r/toronto karaoke drag comedy open mic bar 2026',
  'site:reddit.com/r/toronto live music jazz bar weekly 2026',
  'site:reddit.com/r/toronto bingo dj night bar weekly 2026',
  'site:reddit.com/r/askTO best happy hour Toronto 2026',
  'site:reddit.com/r/askTO trivia karaoke bar Toronto 2026',
  // BlogTO and NOW — editorial content about venues
  'site:blogto.com Toronto happy hour bars 2026',
  'site:blogto.com Toronto trivia karaoke comedy drag weekly 2026',
  'site:blogto.com Toronto jazz live music bingo weekly 2026',
  'site:nowtoronto.com Toronto happy hour weekly events bars 2026',
  // Google Maps public reviews and listings
  'Toronto bar "happy hour" "every" site:google.com/maps 2026',
  'Toronto "trivia night" "every week" bar site:google.com/maps',
  // Yelp public listings
  'site:yelp.ca Toronto happy hour cocktails bar 2026',
  'site:yelp.ca Toronto trivia night karaoke bar 2026',
  // Instagram public posts (Claude reads visible public content)
  '"toronto" "happy hour" "every" bar instagram.com 2026',
  '"toronto" "trivia night" "weekly" bar instagram.com 2026',
  '"toronto" "drag show" "every" bar instagram.com 2026',
  '"toronto" "karaoke" "weekly" bar instagram.com 2026',
  '"toronto" "open mic" "every" bar instagram.com 2026',
  // Toronto Life
  'site:torontolife.com best happy hour bars Toronto 2026',
  'site:torontolife.com best trivia comedy jazz bars Toronto 2026',
  // Neighbourhood specific
  'Toronto Kensington Market "happy hour" OR "trivia" bar 2026',
  'Toronto Leslieville Riverside "happy hour" OR "trivia" bar 2026',
  'Toronto Parkdale "happy hour" OR "drag" OR "karaoke" bar 2026',
  'Toronto Danforth "happy hour" OR "trivia" bar 2026',
  'Toronto Ossington "happy hour" OR "jazz" bar 2026',
];

// Knowledge-based prompts as fallback (no web search, no rate limit)
const KNOWLEDGE_PROMPTS = [
  'List 10 Toronto bars with drink happy hours (drinkhh) with real street addresses.',
  'List 10 Toronto bars with food happy hour deals (foodhh) with real street addresses.',
  'List 10 Toronto bars that host weekly pub trivia nights with real street addresses.',
  'List 10 Toronto bars with weekly karaoke nights with real street addresses.',
  'List 10 Toronto bars with weekly live music (livemusic) with real street addresses.',
  'List 10 Toronto bars with weekly jazz (jazz) with real street addresses.',
  'List 10 Toronto venues with weekly comedy nights with real street addresses.',
  'List 10 Toronto bars with weekly drag shows with real street addresses.',
  'List 10 Toronto bars with weekly DJ nights with real street addresses.',
  'List 10 Toronto bars with weekly bingo nights with real street addresses.',
  'List 10 Toronto venues with weekly open mic nights with real street addresses.',
];

const SYSTEM_PROMPT = `You are a Toronto nightlife researcher. Extract venue information from web search results and social media posts about Toronto bars, restaurants and event venues.

When reading Reddit threads, Instagram posts, Yelp reviews, or editorial articles — extract the specific venue names, addresses, and event details mentioned.

For each venue output a JSON object:
- name: string (venue/bar name — NOT the event title or account name)
- hood: string (Toronto neighbourhood e.g. King West, Queen West, Ossington, Kensington, Annex, Yorkville, Danforth, Leslieville, Parkdale, Liberty Village, Financial, Distillery, Church, Midtown, Bloordale, Geary, Trinity Bellwoods, Riverside, Corktown, Harbourfront)
- type: string (one of: drinkhh, foodhh, trivia, karaoke, livemusic, jazz, comedy, drag, dj, bingo, openmic)
- days: array (subset of: "mon","tue","wed","thu","fri","sat","sun")
- start: number (24hr decimal: 16=4pm, 17=5pm, 17.5=5:30pm, 20=8pm, 21=9pm, 22=10pm)
- end: number (24hr decimal: use >24 for after midnight: 25=1am, 26=2am)
- detail: string (specific details, prices, what people are saying about it — use quotes from posts if helpful)
- addr: string (full street address with number e.g. "123 King St W")

Rules:
- ONLY include Toronto, Ontario venues
- ONLY include recurring weekly events or permanent happy hours
- Address must contain a street number — skip if unsure
- Return ONLY a valid JSON array, no markdown, no explanation`;

const KNOWLEDGE_SYSTEM = `You are a Toronto nightlife expert. Suggest NEW Toronto venues not in the existing list.

For each venue output a JSON object:
- name, hood, type, days, start, end, detail, addr (same format as above)

Only include real venues with addresses you are confident about.
Return ONLY a valid JSON array, no markdown.`;

// ── GEOCODE ───────────────────────────────────────────────────────────────────
async function geocode(name, addr) {
  const attempts = [
    new URLSearchParams({ format:'json', limit:'1', countrycodes:'ca', viewbox:'-79.7,43.5,-79.1,43.9', bounded:'1', street:addr, city:'Toronto', country:'Canada' }),
    new URLSearchParams({ format:'json', limit:'1', countrycodes:'ca', viewbox:'-79.7,43.5,-79.1,43.9', bounded:'1', q:addr+', Toronto, Ontario, Canada' }),
    new URLSearchParams({ format:'json', limit:'1', countrycodes:'ca', viewbox:'-79.7,43.5,-79.1,43.9', bounded:'1', q:name+', Toronto, Ontario, Canada' }),
  ];
  for (const qs of attempts) {
    try {
      const res = await fetch('https://nominatim.openstreetmap.org/search?'+qs, { headers:{ 'User-Agent': USER_AGENT } });
      if (!res.ok) continue;
      const results = await res.json();
      if (results.length > 0) {
        const lat = Math.round(parseFloat(results[0].lat)*1000000)/1000000;
        const lng = Math.round(parseFloat(results[0].lon)*1000000)/1000000;
        if (lat>43.5&&lat<43.9&&lng>-79.7&&lng<-79.1) return { lat, lng };
      }
    } catch(e) { continue; }
    await sleep(1100);
  }
  return null;
}

// ── API CALL WITH WEB SEARCH ──────────────────────────────────────────────────
async function callClaudeWithSearch(query, existingNames) {
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
      messages: [{
        role: 'user',
        content: `Search for and extract Toronto venue info from public posts and pages: "${query}"\n\nAlready in database (skip these): ${existingNames.slice(0,80).join(', ')}\n\nReturn ONLY a JSON array.`
      }],
    }),
  });

  if (response.status === 429) {
    console.log('  Rate limited — waiting 60s...');
    await sleep(60000);
    return callClaudeWithSearch(query, existingNames);
  }
  if (!response.ok) throw new Error('API '+response.status+': '+(await response.text()).slice(0,150));

  const data = await response.json();
  const text = data.content.find(b=>b.type==='text')?.text || '[]';
  return parseJSON(text);
}

// ── API CALL KNOWLEDGE ONLY ───────────────────────────────────────────────────
async function callClaudeKnowledge(prompt, existingNames) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2000,
      system: KNOWLEDGE_SYSTEM,
      messages: [{
        role: 'user',
        content: prompt+'\n\nAlready in database (skip these): '+existingNames.slice(0,100).join(', ')+'\n\nReturn ONLY a JSON array.'
      }],
    }),
  });

  if (response.status === 429) {
    console.log('  Rate limited — waiting 30s...');
    await sleep(30000);
    return callClaudeKnowledge(prompt, existingNames);
  }
  if (!response.ok) throw new Error('API '+response.status);

  const data = await response.json();
  const text = data.content.find(b=>b.type==='text')?.text || '[]';
  return parseJSON(text);
}

// ── HELPERS ───────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

function parseJSON(text) {
  try {
    const clean = text.replace(/```json\n?/g,'').replace(/```\n?/g,'').trim();
    const match = clean.match(/\[[\s\S]*\]/);
    if (!match) return [];
    return JSON.parse(match[0]);
  } catch(e) { return []; }
}

const VALID_TYPES = new Set(['drinkhh','foodhh','happyhour','trivia','karaoke','livemusic','jazz','comedy','drag','dj','bingo','openmic']);
const VALID_DAYS = new Set(['mon','tue','wed','thu','fri','sat','sun']);

function normalize(v) {
  return {
    name: String(v.name||'').trim(),
    hood: String(v.hood||'Toronto').trim(),
    type: VALID_TYPES.has(v.type) ? v.type : 'happyhour',
    days: Array.isArray(v.days) ? v.days.map(d=>String(d).toLowerCase().slice(0,3)).filter(d=>VALID_DAYS.has(d)) : [],
    start: Number(v.start)||17,
    end: Number(v.end)||19,
    detail: String(v.detail||'').trim(),
    addr: String(v.addr||'').trim(),
    lat: Number(v.lat)||0,
    lng: Number(v.lng)||0,
  };
}

function isValid(v) {
  return v.name.length > 1 && v.days.length > 0 && v.detail.length > 5 && v.addr.length > 3 && /\d/.test(v.addr);
}

function deduplicate(existing, incoming) {
  const seen = new Set(existing.map(v=>v.name.toLowerCase().replace(/[^a-z0-9]/g,'')));
  return incoming.filter(v => {
    const key = v.name.toLowerCase().replace(/[^a-z0-9]/g,'');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('Tonight.TO Weekly Scraper v4 (Hybrid: Web + Knowledge)');
  console.log('========================================================');

  let existing = [];
  try {
    if (existsSync(VENUES_PATH)) {
      const data = JSON.parse(readFileSync(VENUES_PATH, 'utf8'));
      existing = data.venues || [];
      console.log('Loaded '+existing.length+' existing venues');
    }
  } catch(e) { console.log('Could not read venues.json:', e.message); }

  const existingNames = existing.map(v=>v.name);
  const allFound = [];

  // ── PHASE 1: Web search (social media + editorial) ──
  console.log('\n── Phase 1: Web Search (public posts + articles) ──');
  for (let i=0; i<WEB_SEARCHES.length; i++) {
    const query = WEB_SEARCHES[i];
    console.log('\n['+( i+1)+'/'+WEB_SEARCHES.length+'] '+query.slice(0,70)+'...');
    try {
      const found = await callClaudeWithSearch(query, existingNames);
      const normalized = found.map(normalize).filter(isValid);
      console.log('  Found '+normalized.length+' valid venues');
      normalized.forEach(v=>console.log('    - '+v.name+' ('+v.addr+')'));
      allFound.push(...normalized);
      await sleep(20000); // 20s between web search calls (they use more tokens)
    } catch(e) {
      console.error('  Error: '+e.message);
      await sleep(20000);
    }
  }

  // ── PHASE 2: Knowledge fallback ──
  console.log('\n── Phase 2: Knowledge Base Fallback ──');
  for (let i=0; i<KNOWLEDGE_PROMPTS.length; i++) {
    const prompt = KNOWLEDGE_PROMPTS[i];
    console.log('\n['+( i+1)+'/'+KNOWLEDGE_PROMPTS.length+'] '+prompt.slice(0,60)+'...');
    try {
      const found = await callClaudeKnowledge(prompt, existingNames);
      const normalized = found.map(normalize).filter(isValid);
      console.log('  Found '+normalized.length+' valid venues');
      normalized.forEach(v=>console.log('    - '+v.name+' ('+v.addr+')'));
      allFound.push(...normalized);
      await sleep(4000);
    } catch(e) {
      console.error('  Error: '+e.message);
    }
  }

  // ── DEDUPLICATE ──
  console.log('\nTotal found across all searches: '+allFound.length);
  const newVenues = deduplicate(existing, allFound);
  console.log('New venues not already listed: '+newVenues.length);

  // ── GEOCODE ──
  if (newVenues.length > 0) {
    console.log('\nGeocoding new venues...');
    for (let i=0; i<newVenues.length; i++) {
      const v = newVenues[i];
      process.stdout.write('['+( i+1)+'/'+newVenues.length+'] '+v.name+'... ');
      if (v.lat>43.5&&v.lat<43.9&&v.lng>-79.7&&v.lng<-79.1) { console.log('coords ok'); continue; }
      const coords = await geocode(v.name, v.addr);
      if (coords) {
        v.lat = coords.lat; v.lng = coords.lng;
        console.log('OK ('+coords.lat+', '+coords.lng+')');
      } else {
        v.lat = 43.6532; v.lng = -79.3832;
        console.log('not found - using Toronto centre');
      }
      await sleep(1100);
    }
  }

  newVenues.forEach(v=>console.log('  + '+v.name+' ('+v.hood+') - '+v.type));

  const merged = [...existing, ...newVenues];
  writeFileSync(VENUES_PATH, JSON.stringify({
    version: 1,
    updated: new Date().toISOString().split('T')[0],
    total: merged.length,
    venues: merged,
  }, null, 2));

  console.log('\nDone: '+existing.length+' existing + '+newVenues.length+' new = '+merged.length+' total venues');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
