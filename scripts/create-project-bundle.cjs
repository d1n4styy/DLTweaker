#!/usr/bin/env node
/**
 * Собирает в одну папку всё, что нужно для проекта (исходники как в electron-builder + dev-скрипты),
 * чтобы можно было держать отдельную копию и не бояться случайно удалить нужное в основной копии.
 *
 * Запуск: npm run bundle:sources
 * Результат: ./DLTweaker-full-snapshot/ (не коммитится в git)
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT_DIR_NAME = 'DLTweaker-full-snapshot';
const OUT = path.join(ROOT, OUT_DIR_NAME);

function walkFiles(dir, baseRel = '') {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = path.join(baseRel, ent.name).replace(/\\/g, '/');
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walkFiles(abs, rel));
    else out.push(rel);
  }
  return out;
}

/** Разворачивает паттерны из package.json build.files (рекурсивные glob и одиночные файлы). */
function expandPattern(root, pattern) {
  const norm = String(pattern).replace(/\\/g, '/');
  if (!norm.includes('*')) {
    const abs = path.join(root, norm);
    return fs.existsSync(abs) && fs.statSync(abs).isFile() ? [norm] : [];
  }
  if (norm.endsWith('/**/*')) {
    const dirRel = norm.slice(0, -'/**/*'.length);
    const abs = path.join(root, dirRel);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) return [];
    return walkFiles(abs, dirRel);
  }
  console.warn('[bundle] unsupported pattern, skip:', pattern);
  return [];
}

function copyFile(srcRoot, rel, dstRoot) {
  const from = path.join(srcRoot, rel);
  const to = path.join(dstRoot, rel);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

function main() {
  const pkgPath = path.join(ROOT, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const patterns = pkg.build?.files || [];
  const set = new Set();

  for (const p of patterns) {
    for (const f of expandPattern(ROOT, p)) set.add(f);
  }

  const extraFiles = [
    'package.json',
    'package-lock.json',
    'dev-app-update.example.yml',
    'scripts/create-project-bundle.cjs',
  ];
  for (const e of extraFiles) {
    if (fs.existsSync(path.join(ROOT, e))) set.add(e.replace(/\\/g, '/'));
  }

  const extraDirs = ['scripts', 'quick-patch', '.github'];
  for (const d of extraDirs) {
    const abs = path.join(ROOT, d);
    if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
      for (const f of walkFiles(abs, d)) set.add(f);
    }
  }

  if (fs.existsSync(OUT)) {
    fs.rmSync(OUT, { recursive: true, force: true });
  }
  fs.mkdirSync(OUT, { recursive: true });

  for (const rel of [...set].sort()) {
    const relNorm = rel.replace(/\\/g, '/');
    const from = path.join(ROOT, relNorm);
    if (!fs.existsSync(from) || !fs.statSync(from).isFile()) continue;
    copyFile(ROOT, relNorm, OUT);
  }

  const readme = `Deadlock Tweaker — снимок исходников (${new Date().toISOString().slice(0, 10)})
================================================================

Эта папка создана скриптом scripts/create-project-bundle.cjs (npm run bundle:sources).

Содержимое:
- все файлы из package.json → build.files (как в установщике Electron);
- package.json, package-lock.json;
- папки scripts/, quick-patch/, .github/ (для сборки, превью сплэша, CI);
- dev-app-update.example.yml (пример для проверки обновлений в dev).

НЕ скопировано (восстановите сами):
- node_modules/  →  в этой папке выполните: npm install
- dist/          →  npm run dist

Дальше можно работать из этой копии как из обычного проекта или хранить её как резерв.

Папку "${OUT_DIR_NAME}" в корне репозитория добавили в .gitignore — она не попадёт в git по умолчанию.
`;
  fs.writeFileSync(path.join(OUT, 'README-BUNDLE.txt'), readme, 'utf8');

  console.log(`[bundle] Готово: ${OUT}`);
  console.log(`[bundle] Файлов скопировано: ${set.size}`);
}

main();
