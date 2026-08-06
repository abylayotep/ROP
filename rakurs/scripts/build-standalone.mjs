/**
 * Сборка приложения в один самодостаточный HTML-файл.
 *
 *   npm run build:standalone   →  standalone/rakurs.html
 *
 * Внутрь запекаются стили, скрипт и шрифты (base64). Файл открывается двойным
 * кликом без сервера и интернета — удобно показать заказчику или отправить
 * в мессенджере. Маршрутизация в этой сборке идёт через хэш, потому что по
 * file:// обычные пути не работают.
 *
 * Для рабочего деплоя это не нужно — там обычный `npm run build` и раздача dist.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIST = join(ROOT, 'dist');

const OUT_DIR = join(ROOT, 'standalone');
const OUT = join(OUT_DIR, 'rakurs.html');

console.log('Сборка…');
execFileSync('npx', ['vite', 'build', '--base', './'], {
  cwd: ROOT,
  stdio: 'inherit',
  env: { ...process.env, VITE_HASH_ROUTER: '1' },
});

const assets = readdirSync(join(DIST, 'assets'));
const cssName = assets.find((f) => f.endsWith('.css'));
const jsName = assets.find((f) => f.endsWith('.js'));
if (!cssName || !jsName) throw new Error('В dist/assets не найдены css или js');

// Шрифты внутрь стилей — иначе по file:// они не подтянутся.
let css = readFileSync(join(DIST, 'assets', cssName), 'utf8');
for (const font of readdirSync(join(DIST, 'fonts'))) {
  const b64 = readFileSync(join(DIST, 'fonts', font)).toString('base64');
  css = css.replaceAll(
    new RegExp(`url\\((["']?)[^)"']*${font}\\1\\)`, 'g'),
    `url(data:font/woff2;base64,${b64})`
  );
}

const js = readFileSync(join(DIST, 'assets', jsName), 'utf8');

let html = readFileSync(join(DIST, 'index.html'), 'utf8');
html = html
  // Любые ссылки на внешние файлы убираем: всё уже внутри. Оставленный preload
  // шрифта по file:// упирается в CORS и сыплет ошибками в консоль.
  .replace(/\s*<link\b[^>]*\b(?:href|rel="(?:preload|modulepreload|stylesheet)")[^>]*>/g, '')
  .replace(/\s*<script\b[^>]*\bsrc="[^"]*"[^>]*><\/script>/g, '')
  .replace('</head>', `<style>${css}</style>\n</head>`)
  // </script> внутри строки закрыл бы тег раньше времени
  .replace('</body>', `<script type="module">${js.replaceAll('</script>', '<\\/script>')}</script>\n</body>`);

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT, html);

const mb = (Buffer.byteLength(html) / 1024 / 1024).toFixed(2);
console.log(`\nГотово: standalone/rakurs.html · ${mb} МБ`);
