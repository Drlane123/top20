// Aggregated generated cover art: { songNumber: base64 webp }
// Chunks are loaded dynamically so the bundle grows with the catalog —
// every cover-art-chunk-N.js file present ships its songs.
const fs = require("fs");
const path = require("path");
const merged = {};
for (let i = 1; i <= 24; i++) {
  const p = path.join(__dirname, `cover-art-chunk-${i}.js`);
  if (!fs.existsSync(p)) break;
  Object.assign(merged, require(p));
}
module.exports = merged;
