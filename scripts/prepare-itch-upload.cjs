/**
 * Copy NSIS artifacts into dist/itch-upload for `butler push`.
 * Run after `npm run dist` or `npm run dist:itch`.
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');
const outDir = path.join(dist, 'itch-upload');

if (!fs.existsSync(dist)) {
  console.error('dist/ not found. Run npm run dist or npm run dist:itch first.');
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });
const names = fs.readdirSync(dist);
let n = 0;
for (const f of names) {
  if (f === 'latest.yml' || f.endsWith('.blockmap') || /-Setup\.exe$/i.test(f)) {
    fs.copyFileSync(path.join(dist, f), path.join(outDir, f));
    console.log('copy', f);
    n += 1;
  }
}
if (n === 0) {
  console.error('No Setup.exe / latest.yml / blockmap found in dist/.');
  process.exit(1);
}
console.log(`Prepared ${n} file(s) in dist/itch-upload — push with: npm run itch:push`);
