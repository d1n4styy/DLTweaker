const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const root = path.join(__dirname, '..');
const distDir = path.join(root, 'dist');

function desktopDir() {
  try {
    return execSync(
      "powershell -NoProfile -Command \"[Environment]::GetFolderPath('Desktop')\"",
      { encoding: 'utf8' }
    ).trim();
  } catch {
    return path.join(process.env.USERPROFILE || '', 'Desktop');
  }
}

function findSetupExe() {
  if (!fs.existsSync(distDir)) {
    throw new Error(`Missing folder: ${distDir}`);
  }
  const names = fs.readdirSync(distDir);
  const hit = names.find((n) => /Setup\.exe$/i.test(n));
  if (!hit) {
    throw new Error('No *Setup.exe in dist/. Run npm run dist first.');
  }
  return path.join(distDir, hit);
}

const src = findSetupExe();
const destDir = desktopDir();
if (!fs.existsSync(destDir)) {
  throw new Error(`Desktop not found: ${destDir}`);
}
const dest = path.join(destDir, path.basename(src));
fs.copyFileSync(src, dest);
console.log('Installer copied to Desktop:', dest);
