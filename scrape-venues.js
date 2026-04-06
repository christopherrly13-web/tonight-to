/**
 * Tonight.TO — Weekly Venue Scraper (GitHub Actions)
 *
 * Priority for each venue:
 *   1. Venue's own website (venue.website field)
 *   2. Google Places API (address/coords verification)
 *   3. Yelp API (fallback deals + address)
 *   4. Claude web search (last resort, BlogTO / NOW Toronto / general web)
 *
 * Also runs:
 *   - Google Places photo fetch for venues missing photos
 *   - TM host venue photo fetch for hidden entries
 *
 * Secrets required in GitHub repo:
 *   ANTHROPIC_API_KEY
 *   GOOGLE_PLACES_KEY   (optional — falls back to hardcoded key)
 *   YELP_API_KEY        (optional — falls back to hardcoded key)
 */

const fs   = require('fs');
const path = require('path');
const https = require('https');
const http  = require('http');

// ── Config ────────────────────────────────────────────────────────────────────

const VENUES_PATH  = path.resolve(__dirname, '..', 'venues.json');
const GOOGLE_KEY   = process.env.GOOGLE_PLACES_KEY || 'AIzaSyAo5sRSN0Qp7WR3mquuIkzaL51USat-cp8';
const YELP_KEY     = process.env.YELP_API_KEY      || 'uaaP4ryCl6wt-EyjgrlbQ9B5i1Pat3qct22sSg-J9RLWUfNq6uAHs5tEP-EEsAMpbJbxzOma8VeFxwlu_POyqWsskpQC_Pg2Ncbx8OyUnGpNZ5fD0bRa37oF0-LRaXYx';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

const DAYS_ALL = ['mon','tue','wed','thu','fri','sat','sun'];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function fetchText(url, headers = {}, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('Too many redirects'));
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TonightTO-Scraper/1.0)', ...headers },
      timeout: 12000,
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).href;
        return fetchText(next, headers, redirects + 1).then(resolve).catch(reject);
      }
      if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}`));
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function fetchJson(url, headers = {}) {
  return fetchText(url, headers).then(JSON.parse);
}

function postJson(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...headers },
      timeout: 30000,
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

// ── Text parsing ──────────────────────────────────────────────────────────────

function parseTime(str) {
  if (!str) return null;
  str = str.toLowerCase().trim();
  const m = str.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
  if (!m) return null;
  let h = parseInt(m[1]), min = parseInt(m[2] || '0');
  const period = m[3];
  if (period === 'pm' && h !== 12) h += 12;
  if (period === 'am' && h === 12) h = 0;
  return h + min / 60;
}

function parseDays(text) {
  const t = text.toLowerCase();
  if (/daily|every day|7 days|all week|sun.+sat|mon.+sun/.test(t)) return DAYS_ALL;
  if (/weekday|mon.+fri/.test(t)) return ['mon','tue','wed','thu','fri'];
  if (/weekend/.test(t)) return ['sat','sun'];
  const order = ['sun','mon','tue','wed','thu','fri','sat'];
  const nameMap = {sunday:'sun',monday:'mon',tuesday:'tue',wednesday:'wed',thursday:'thu',friday:'fri',saturday:'sat',sun:'sun',mon:'mon',tue:'tue',wed:'wed',thu:'thu',fri:'fri',sat:'sat'};
  // Ranges: Tue-Fri, Mon–Thu
  const days = [];
  const rangeRe = /(\w+)\s*[-–]\s*(\w+)/g;
  let rm;
  while ((rm = rangeRe.exec(t)) !== null) {
    const a = order.indexOf(nameMap[rm[1]]), b = order.indexOf(nameMap[rm[2]]);
    if (a !== -1 && b !== -1) for (let i = a; i <= b; i++) days.push(order[i]);
  }
  if (days.length) return [...new Set(days)];
  for (const [w, k] of Object.entries(nameMap)) if (t.includes(w)) days.push(k);
  return [...new Set(days)];
}

function extractHappyHour(html) {
  const text = html.replace(/<script[\s\S]*?<\/script>/gi, '')
                   .replace(/<style[\s\S]*?<\/style>/gi, '')
                   .replace(/<[^>]+>/g, ' ')
                   .replace(/&amp;/g,'&').replace(/&nbsp;/g,' ')
                   .replace(/\s+/g, ' ');

  const patterns = [
    /(?:happy hour|honolulu hour|hh|specials?)[^.!?]*?(\d{1,2}(?::\d{2})?\s*(?:am|pm))\s*[-–to]+\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm))[^.!?]*/gi,
    /(\d{1,2}(?::\d{2})?\s*(?:am|pm))\s*[-–to]+\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm))\s*[^.!?]*?(?:daily|every day|happy hour|specials?)/gi,
  ];
  for (const pat of patterns) {
    let m;
    while ((m = pat.exec(text)) !== null) {
      const start = parseTime(m[1]), end = parseTime(m[2]);
      if (start !== null && end !== null && end > start && end - start <= 6) {
        const idx = text.indexOf(m[0]);
        const context = text.slice(Math.max(0, idx - 50), idx + 200).trim();
        return { start, end, context: m[0].trim(), fullContext: context };
      }
    }
  }
  return null;
}

// ── Source 1: Venue website ───────────────────────────────────────────────────

async function scrapeWebsite(venue) {
  if (!venue.website) return null;
  const base = venue.website.replace(/\/$/, '');
  const paths = ['', '/happy-hour', '/specials', '/drinks', '/menu', '/promotions', '/events', '/offers'];
  for (const p of paths) {
    try {
      const html = await fetchText(base + p);
      const hh = extractHappyHour(html);
      if (hh) {
        console.log(`    ✅ Website (${p||'/'}): ${hh.start}–${hh.end} | ${hh.context.slice(0,70)}`);
        const days = parseDays(hh.fullContext);
        return { start: hh.start, end: hh.end, days: days.length ? days : null, context: hh.context, source: 'website' };
      }
    } catch(e) { /* try next path */ }
    await sleep(300);
  }
  console.log(`    ⚪ Website: no happy hour found`);
  return null;
}

// ── Source 2: Google Places ───────────────────────────────────────────────────

async function scrapeGoogle(venue) {
  try {
    const q = encodeURIComponent(`${venue.name} ${venue.addr} Toronto`);
    const s = await fetchJson(`https://maps.googleapis.com/maps/api/place/findplacefromtext/json?input=${q}&inputtype=textquery&fields=place_id,geometry,formatted_address&key=${GOOGLE_KEY}`);
    const pid = s.candidates?.[0]?.place_id;
    if (!pid) return null;
    const d = await fetchJson(`https://maps.googleapis.com/maps/api/place/details/json?place_id=${pid}&fields=formatted_address,geometry,photos&key=${GOOGLE_KEY}`);
    const r = d.result;
    if (!r) return null;
    const addr = r.formatted_address?.split(',')[0]?.trim();
    console.log(`    ✅ Google Places: ${addr}`);
    return {
      addr,
      lat: r.geometry?.location?.lat,
      lng: r.geometry?.location?.lng,
      photoRef: r.photos?.[0]?.photo_reference,
    };
  } catch(e) {
    console.log(`    ⚪ Google Places: ${e.message}`);
    return null;
  }
}

// ── Source 3: Yelp ────────────────────────────────────────────────────────────

async function scrapeYelp(venue) {
  try {
    const q = encodeURIComponent(venue.name);
    const r = await fetchJson(
      `https://api.yelp.com/v3/businesses/search?term=${q}&location=Toronto,ON&limit=5`,
      { Authorization: `Bearer ${YELP_KEY}` }
    );
    const match = r.businesses?.find(b =>
      b.name.toLowerCase().includes(venue.name.toLowerCase().split(' ')[0]) &&
      (b.location?.address1 || '').toLowerCase().includes((venue.addr || '').split(' ')[0].toLowerCase())
    );
    if (!match) return null;
    console.log(`    ✅ Yelp: ${match.name} @ ${match.location?.address1}`);
    return {
      addr: match.location?.address1,
      lat: match.coordinates?.latitude,
      lng: match.coordinates?.longitude,
    };
  } catch(e) {
    console.log(`    ⚪ Yelp: ${e.message}`);
    return null;
  }
}

// ── Source 4: Claude web search ───────────────────────────────────────────────

async function scrapeViaClaude(venue) {
  if (!ANTHROPIC_KEY) { console.log(`    ⚪ Claude: no API key`); return null; }
  try {
    const prompt = `Search the web for the happy hour details at "${venue.name}" in Toronto, Canada. 
Look at their official website (${venue.website || 'unknown'}), BlogTO, NOW Toronto, and OpenTable.
Return ONLY a JSON object with these fields (no markdown, no explanation):
{
  "detail": "one sentence describing the happy hour deals (prices, what's discounted)",
  "start": <hour as decimal e.g. 15 for 3pm, 14.5 for 2:30pm>,
  "end": <hour as decimal>,
  "days": ["mon","tue","wed","thu","fri","sat","sun"] (only days HH runs),
  "addr": "street address only",
  "found": true or false
}
If you cannot find happy hour info, return {"found": false}.`;

    const res = await postJson('https://api.anthropic.com/v1/messages', {
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{ role: 'user', content: prompt }],
    }, {
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'web-search-2025-03-05',
    });

    const text = res.content?.filter(b => b.type === 'text').map(b => b.text).join('');
    const json = text?.match(/\{[\s\S]*\}/)?.[0];
    if (!json) return null;
    const data = JSON.parse(json);
    if (!data.found) return null;
    console.log(`    ✅ Claude web search: ${data.detail?.slice(0,70)}`);
    return data;
  } catch(e) {
    console.log(`    ⚪ Claude: ${e.message}`);
    return null;
  }
}

// ── Photo fetcher ─────────────────────────────────────────────────────────────

async function fetchPhoto(photoRef) {
  return new Promise(resolve => {
    const url = `https://maps.googleapis.com/maps/api/place/photo?maxwidth=800&photoreference=${photoRef}&key=${GOOGLE_KEY}`;
    https.get(url, res => {
      resolve(res.headers.location || '');
    }).on('error', () => resolve(''));
  });
}

async function getPhotoRef(name, addr) {
  try {
    const q = encodeURIComponent(`${name} ${addr} Toronto`);
    const s = await fetchJson(`https://maps.googleapis.com/maps/api/place/findplacefromtext/json?input=${q}&inputtype=textquery&fields=place_id&key=${GOOGLE_KEY}`);
    const pid = s.candidates?.[0]?.place_id;
    if (!pid) return null;
    const d = await fetchJson(`https://maps.googleapis.com/maps/api/place/details/json?place_id=${pid}&fields=photos&key=${GOOGLE_KEY}`);
    return d.result?.photos?.[0]?.photo_reference || null;
  } catch(e) { return null; }
}

// ── Process one venue ─────────────────────────────────────────────────────────

async function processVenue(venue) {
  console.log(`\n📍 ${venue.name}`);
  const updates = {};

  // 1. Own website — best source for deals
  const web = await scrapeWebsite(venue);
  if (web) {
    if (web.start !== undefined) updates.start = Math.round(web.start * 4) / 4;
    if (web.end !== undefined)   updates.end   = Math.round(web.end   * 4) / 4;
    if (web.days?.length)        updates.days  = web.days;
  }
  await sleep(300);

  // 2. Google Places — address + coords + photo ref
  const google = await scrapeGoogle(venue);
  if (google) {
    if (google.addr && !venue.addr)  updates.addr = google.addr;
    if (google.lat  && !venue.lat)   updates.lat  = google.lat;
    if (google.lng  && !venue.lng)   updates.lng  = google.lng;
    // Fetch photo if missing
    if (!venue.photo && google.photoRef) {
      const photoUrl = await fetchPhoto(google.photoRef);
      if (photoUrl?.includes('googleusercontent')) {
        updates.photo = photoUrl;
        console.log(`    📸 Photo fetched`);
      }
    }
  }
  await sleep(300);

  // 3 & 4 — only if website didn't give us deal info
  if (!web) {
    const yelp = await scrapeYelp(venue);
    if (yelp) {
      if (yelp.addr && !updates.addr) updates.addr = yelp.addr;
      if (yelp.lat  && !updates.lat)  updates.lat  = yelp.lat;
      if (yelp.lng  && !updates.lng)  updates.lng  = yelp.lng;
    }
    await sleep(300);

    const claude = await scrapeViaClaude(venue);
    if (claude) {
      if (claude.start !== undefined) updates.start  = claude.start;
      if (claude.end   !== undefined) updates.end    = claude.end;
      if (claude.days?.length)        updates.days   = claude.days;
      if (claude.detail)              updates.detail = claude.detail;
      if (claude.addr && !updates.addr) updates.addr = claude.addr;
    }
    await sleep(500);
  }

  return updates;
}

// ── Photo pass: fill missing photos for all venues ────────────────────────────

async function runPhotoPass(venues) {
  console.log('\n\n📸 Photo pass — filling missing photos...');
  let filled = 0;
  for (const v of venues) {
    if (v.photo) continue;
    process.stdout.write(`  ${v.name}... `);
    try {
      const ref = await getPhotoRef(v.name, v.addr);
      if (ref) {
        const url = await fetchPhoto(ref);
        if (url?.includes('googleusercontent')) {
          v.photo = url;
          filled++;
          console.log('✅');
        } else { console.log('⚪'); }
      } else { console.log('⚪'); }
    } catch(e) { console.log(`❌ ${e.message}`); }
    await sleep(250);
  }
  console.log(`Photo pass done: ${filled} new photos`);
  return filled;
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main() {
  console.log('Tonight.TO — Weekly Venue Scraper');
  console.log('==================================');
  console.log(`Priority: website → Google Places → Yelp → Claude web search\n`);

  const data   = JSON.parse(fs.readFileSync(VENUES_PATH, 'utf8'));
  const venues = data.venues;

  // Only process non-hidden, non-TM venues that have a website
  const targets = venues.filter(v =>
    !v.hidden &&
    v.source !== 'ticketmaster' &&
    v.source !== 'eventbrite' &&
    v.website
  );

  console.log(`Processing ${targets.length} venues with websites\n`);

  let updated = 0;

  for (const venue of targets) {
    const updates = await processVenue(venue);

    if (Object.keys(updates).length > 0) {
      Object.assign(venue, updates);
      updated++;
      fs.writeFileSync(VENUES_PATH, JSON.stringify(data, null, 2));
    }
  }

  console.log(`\nDeal scrape done: ${updated} venues updated`);

  // Photo pass — fill any missing photos across ALL venues
  const photosFilled = await runPhotoPass(venues.filter(v => v.source !== 'ticketmaster'));
  if (photosFilled > 0) {
    fs.writeFileSync(VENUES_PATH, JSON.stringify(data, null, 2));
  }

  // Final summary
  const withPhotos = venues.filter(v => v.photo).length;
  console.log(`\n✅ All done.`);
  console.log(`   Deals updated: ${updated}`);
  console.log(`   Photos filled: ${photosFilled}`);
  console.log(`   Total with photos: ${withPhotos}/${venues.filter(v => !v.hidden).length}`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
