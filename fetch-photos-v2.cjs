/**
 * Tonight.TO — Photo Fetcher v2
 */

const fs = require('fs');
const path = require('path');

const VENUES_PATH = path.resolve(__dirname, 'venues.json');
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

if (!ANTHROPIC_KEY) { console.error('Missing ANTHROPIC_API_KEY'); process.exit(1); }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function findPhotoUrl(name, addr) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'web-search-2025-03-05',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 500,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{
        role: 'user',
        content: `Search blogto.com for a photo of "${name}" at ${addr} Toronto. Find a direct image URL ending in .jpg .jpeg .png or .webp showing the interior or exterior. Reply with ONLY the raw image URL. If none found reply: NONE`
      }]
    })
  });

  if (response.status === 429) { await sleep(60000); return findPhotoUrl(name, addr); }
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`API ${response.status}: ${body.slice(0,120)}`);
  }

  const data = await response.json();
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();

  if (!text || text === 'NONE') return null;
  const match = text.match(/https?:\/\/\S+\.(jpg|jpeg|png|webp)(\?\S*)?/i);
  if (match) return match[0];
  if (text.startsWith('http') && !text.includes(' ') && text.length < 400) return text;
  return null;
}

async function main() {
  console.log('Tonight.TO Photo Fetcher v2');
  const data = JSON.parse(fs.readFileSync(VENUES_PATH, 'utf8'));
  const venues = data.venues || [];
  console.log(`Loaded ${venues.length} venues\n`);
  let found = 0, failed = 0, skipped = 0;

  for (let i = 0; i < venues.length; i++) {
    const v = venues[i];
    process.stdout.write(`[${i+1}/${venues.length}] ${v.name}... `);
    if (v.photo) { console.log('skip (has photo)'); skipped++; continue; }
    if (v.source === 'ticketmaster' || v.source === 'eventbrite') { console.log('skip (external)'); skipped++; continue; }

    try {
      const url = await findPhotoUrl(v.name, v.addr);
      if (url) { v.photo = url; found++; console.log(`✅ ${url.slice(0,80)}`); }
      else { console.log('⚠️  not found'); failed++; }
    } catch(e) { console.log(`❌ ${e.message}`); failed++; }

    fs.writeFileSync(VENUES_PATH, JSON.stringify({ ...data, updated: new Date().toISOString().split('T')[0], total: venues.length, venues }, null, 2));
    await sleep(5000);
  }
  console.log(`\nDone: ${found} found, ${failed} failed, ${skipped} skipped`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
