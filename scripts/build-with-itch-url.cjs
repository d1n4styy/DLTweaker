/**
 * Windows build with electron-updater generic URL (itch.io CDN / any HTTPS folder with latest.yml).
 * Usage: ITCH_UPDATE_BASE_URL=https://your-cdn.example.com/path/ npm run dist:itch
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const raw = (process.env.ITCH_UPDATE_BASE_URL || '').trim();
if (!raw || !/^https?:\/\//i.test(raw)) {
  console.error(
    'Set ITCH_UPDATE_BASE_URL to the public HTTPS base URL (trailing slash optional),\n' +
      'e.g. the itch.io / wharf CDN folder that will contain latest.yml and the NSIS .exe.',
  );
  process.exit(1);
}
const url = raw.replace(/\/?$/, '/');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const merged = { ...(pkg.build || {}), publish: [{ provider: 'generic', url }] };
const cfgPath = path.join(root, '.electron-builder-itch.json');
fs.writeFileSync(cfgPath, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
const r = spawnSync('npx', ['electron-builder', '--win', '--publish', 'never', '--config', cfgPath], {
  cwd: root,
  stdio: 'inherit',
  shell: true,
});
try {
  fs.unlinkSync(cfgPath);
} catch {
  /* ignore */
}
process.exit(r.status === 0 ? 0 : r.status || 1);
