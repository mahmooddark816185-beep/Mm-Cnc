import { createHash } from 'node:crypto';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function validateTarget(raw) {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new Error('PAGES_REDIRECT_URL must contain the verified production HTTPS homepage.');
  }
  const value = raw.trim();
  if (value.length > 2048 || /[\u0000-\u0020\u007f\\]/u.test(value) || /[?#]/u.test(value)) {
    throw new Error('PAGES_REDIRECT_URL must not contain whitespace, backslashes, a query, or a fragment.');
  }
  let url;
  try { url = new URL(value); } catch {
    throw new Error('PAGES_REDIRECT_URL is not a valid absolute URL.');
  }
  if (!/^https:\/\//iu.test(value) || url.protocol !== 'https:' || !url.hostname.includes('.')
    || url.username || url.password || url.port || url.pathname !== '/') {
    throw new Error('PAGES_REDIRECT_URL must be an HTTPS homepage without credentials, a custom port, or a path.');
  }
  return url.href;
}

function escapeHtml(value) {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export function renderRedirectPage(rawTarget) {
  const target = validateTarget(rawTarget);
  const targetLiteral = JSON.stringify(target).replaceAll('<', '\\u003c');
  const script = `const destination = new URL(${targetLiteral});
const allowedFragments = new Set(['#studio', '#account', '#formats', '#how', '#top']);
if (allowedFragments.has(window.location.hash)) destination.hash = window.location.hash;
window.location.replace(destination.href);`;
  const scriptHash = createHash('sha256').update(script).digest('base64');
  const escapedTarget = escapeHtml(target);
  return `<!doctype html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <meta name="robots" content="noindex, follow">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'sha256-${scriptHash}'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
  <title>Mm Cnc — انتقل الموقع</title>
  <link rel="canonical" href="${escapedTarget}">
  <style>
    :root { color-scheme: dark; font-family: system-ui, sans-serif; background: #101820; color: #edf4f6; }
    body { min-height: 100vh; margin: 0; display: grid; place-items: center; }
    main { max-width: 34rem; padding: 2rem; text-align: center; line-height: 1.8; }
    h1 { margin-bottom: .5rem; font-size: 2rem; }
    p { color: #c5d5db; }
    a { display: inline-block; padding: .75rem 1.2rem; border-radius: .65rem; background: #a5efce; color: #10251d; font-weight: 700; text-decoration: none; }
    a:focus-visible { outline: 3px solid white; outline-offset: 4px; }
  </style>
</head>
<body>
  <main>
    <h1 dir="ltr">Mm Cnc</h1>
    <p>انتقل الموقع إلى عنوان جديد. جارٍ تحويلك إليه.</p>
    <p lang="en" dir="ltr">Our website has moved. You are being redirected.</p>
    <a href="${escapedTarget}" rel="noreferrer">افتح Mm Cnc <span lang="en" dir="ltr">— Open Mm Cnc</span></a>
  </main>
  <script>${script}</script>
</body>
</html>
`;
}

export async function buildRedirect(rawTarget) {
  const html = renderRedirectPage(rawTarget);
  const output = fileURLToPath(new URL('../dist-pages-redirect/', import.meta.url));
  await mkdir(output, { recursive: true });
  const expected = new Set(['index.html', '404.html', '.nojekyll']);
  const existing = await readdir(output, { withFileTypes: true });
  if (existing.some(entry => !entry.isFile() || !expected.has(entry.name))) {
    throw new Error('dist-pages-redirect contains unexpected content; refusing to publish it.');
  }
  await Promise.all([
    writeFile(resolve(output, 'index.html'), html, 'utf8'),
    writeFile(resolve(output, '404.html'), html, 'utf8'),
    writeFile(resolve(output, '.nojekyll'), '', 'utf8'),
  ]);
  return output;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await buildRedirect(process.env.PAGES_REDIRECT_URL);
    console.log('Prepared redirect-only artifact in dist-pages-redirect.');
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Redirect generation failed.');
    process.exitCode = 1;
  }
}
