const https = require('https');

const API_KEY = 'AIzaSyAo5sRSN0Qp7WR3mquuIkzaL51USat-cp8';

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('JSON parse: ' + data.slice(0,200))); }
      });
    }).on('error', reject);
  });
}

async function main() {
  const query = encodeURIComponent('Bellwoods Brewery, 124 Ossington Ave, Toronto, Ontario, Canada');
  const url = `https://maps.googleapis.com/maps/api/place/findplacefromtext/json?input=${query}&inputtype=textquery&fields=place_id,name&key=${API_KEY}`;
  
  console.log('Testing Places API with Bellwoods Brewery...');
  console.log('URL:', url.replace(API_KEY, 'KEY_HIDDEN'));
  
  const data = await fetchJson(url);
  console.log('Full response:', JSON.stringify(data, null, 2));
}

main().catch(e => console.error('Error:', e.message));
