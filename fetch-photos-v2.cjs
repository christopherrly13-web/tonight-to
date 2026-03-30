/**
 * Tonight.TO — Photo Fetcher v2
 * Uses Claude AI + web search to find a real, publicly accessible
 * photo URL for each venue from their website, Instagram, or press coverage.
 * Stores URLs directly in venues.json as `photo` field.
 *
 * Run: ANTHROPIC_API_KEY=your_key node fetch-photos-v2.cjs
 */

const fs = require('fs');
const path = require('path');

const VENUES_PATH = path.resolve(__dirname, 'venues.json');
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

if (!ANTHROPIC_KEY) {
  console.error('Missing ANTHROPIC_API_KEY');
  process.exit(1);
}

async function findPhotoUrl(name, addr, type) {
  const typeHints = {
    drinkhh: 'cocktail bar interior',
    foodhh: 'restaurant interior',
    happyhour: 'bar interior',
    trivia: 'pub interior',
    karaoke: 'karaoke bar',
    livemusic: 'live music venue interior',
    jazz: 'jazz bar interior',
    comedy: 'comedy club',
    drag: 'nightclub bar',
    dj: 'nightclub',
    bingo: 'bar interior',
    openmic: 'bar stage',
  };

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
      max_tokens: 200,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      system: `You find direct image URLs for Toronto bars and restaurants. 
Search for the venue and find a direct .jpg or .png image URL that shows the interior or exterior of the venue.
Look on their official website, blogto.com, or toronto.com.
Reply with ONLY the raw image URL — nothing else. No markdown, no explanation.
The URL must end in .jpg, .jpeg, .png, or .webp and be publicly accessible.
If you cannot find one, reply with: NONE`,
      messages: [{
        role: 'user',
        content: `Find a direct photo URL (ending in .jpg/.png/.webp) for: "${name}" at ${addr}, Toronto. It's a ${typeHints[type] || 'bar'}. Search their website or blogto.com for a real interior/exterior photo.`
      }]
    })
  });

  if (response.status === 429) {
    await sleep(60000);
    return findPhotoUrl(name, addr, type);
  }

  if (!response.ok) throw new Error(`API ${response.status}`);

  const data = await response.json();
  const text = data.content?.find(b => b.type === 'text')?.text?.trim() || '';

  // Validate it looks like an image URL
  if (text === 'NONE' || !text) return null;
  if (!text.match(/\.(jpg|jpeg|png|webp)(\?.*)?$/i)) return null;
  if (!text.startsWith('http')) return null;

  return text;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  console.log('Tonight.TO — Photo Fetcher v2 (Claude AI + web search)');
  console.log('==========================================================');

  const data = JSON.parse(fs.readFileSync(VENUES_PATH, 'utf8'));
  const venues = data.venues || [];
  console.log(`Loaded ${venues.length} venues\n`);

  let found = 0, failed = 0, skipped = 0;

  for (let i = 0; i < venues.length; i++) {
    const v = venues[i];
    process.stdout.write(`[${i + 1}/${venues.length}] ${v.name}... `);

    // Skip if already has a photo
    if (v.photo) {
      console.log('already has photo');
      skipped++;
      continue;
    }

    // Skip duplicates / external
    if (v.source === 'ticketmaster' || v.source === 'eventbrite') {
      console.log('skipped (external)');
      skipped++;
      continue;
    }

    try {
      const url = await findPhotoUrl(v.name, v.addr, v.type);
      if (url) {
        v.photo = url;
        found++;
        console.log(`✅ ${url.slice(0, 80)}...`);
      } else {
        console.log('⚠️  not found');
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

    await sleep(8000); // 8s between calls to avoid rate limits
  }

  console.log(`\nDone: ${found} photos found, ${failed} not found, ${skipped} skipped`);
  console.log('venues.json saved.');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
