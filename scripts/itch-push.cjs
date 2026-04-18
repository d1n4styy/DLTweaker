/**
 * Push dist/itch-upload to itch.io (requires https://itch.io/docs/butler/ and `butler login`).
 * Env:
 *   ITCH_TARGET   — user/slug (e.g. myname/deadlock-tweaker)
 *   ITCH_CHANNEL  — optional, default win64-updates (name should contain "win" for Windows)
 */
const { spawnSync } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..');
const uploadDir = path.join(root, 'dist', 'itch-upload');
const target = (process.env.ITCH_TARGET || '').trim();
const channel = (process.env.ITCH_CHANNEL || 'win64-updates').trim();

if (!target) {
  console.error('Set ITCH_TARGET=user/game (same as in butler push, e.g. finji/overland).');
  process.exit(1);
}

const fs = require('fs');
if (!fs.existsSync(uploadDir)) {
  console.error('dist/itch-upload missing. Run: npm run itch:prepare-upload');
  process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = (pkg.version || '0.0.0').trim();

const r = spawnSync(
  'butler',
  ['push', uploadDir, `${target}:${channel}`, '--userversion', version],
  { cwd: root, stdio: 'inherit', shell: true },
);

if (r.error && r.error.code === 'ENOENT') {
  console.error('butler not found. Install from https://itch.io/docs/butler/ and ensure it is on PATH.');
  process.exit(1);
}

process.exit(r.status === 0 ? 0 : r.status || 1);
