import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { renderRedirectPage, validateTarget } from './build-pages-redirect.mjs';

const target = 'https://new-site.example/';
const html = renderRedirectPage(target);
const script = html.match(/<script>([\s\S]*?)<\/script>/u)?.[1];

function redirectFrom(hash, search = '') {
  let redirect;
  runInNewContext(script, {
    URL,
    window: { location: { hash, search, replace: value => { redirect = value; } } },
  });
  return redirect;
}

test('requires a verified HTTPS homepage and rejects unsafe or ambiguous targets', () => {
  assert.equal(validateTarget('  https://new-site.example  '), target);
  for (const bad of [
    undefined, '', '   ', '/relative', '//new-site.example', 'http://new-site.example/',
    'javascript:alert(1)', 'https://user:password@new-site.example/',
    'https://new-site.example/path', 'https://new-site.example:8443/',
    'https://new-site.example/?', 'https://new-site.example/#',
    'https://new-site.example/?destination=other', 'https://new-site.example/#studio',
    'https://new-site.example/\npath', 'https:\\new-site.example', 'https://localhost/',
    'https://new-site.example/</script>',
  ]) assert.throws(() => validateTarget(bad), /PAGES_REDIRECT_URL/u);
});

test('preserves only the five recognized navigation fragments and discards every query', () => {
  for (const hash of ['#studio', '#account', '#formats', '#how', '#top']) {
    assert.equal(redirectFrom(hash, '?code=private-code&state=private-state&tracking=anything'), target + hash);
  }
});

test('discards OAuth and unknown fragments rather than forwarding credentials', () => {
  for (const hash of ['', '#', '#unknown', '#access_token=private-token', '#code=private-code',
    '#account?access_token=private-token', '#account&refresh_token=private-token',
    '#%61ccount', '#ACCOUNT', '#studio/other', '#how%0aaccess_token=private-token']) {
    assert.equal(redirectFrom(hash, '?code=private-code&error_description=private-detail'), target);
  }
});

test('keeps a clean bilingual fallback, disables referrers, and authorizes only the generated script', () => {
  assert.ok(html.includes(`href="${target}" rel="noreferrer"`));
  assert.ok(html.includes('افتح Mm Cnc'));
  assert.ok(html.includes('Open Mm Cnc'));
  assert.ok(html.includes('<meta name="referrer" content="no-referrer">'));
  const hash = createHash('sha256').update(script).digest('base64');
  assert.ok(html.includes(`script-src 'sha256-${hash}'`));
  assert.ok(!html.includes('script-src \'unsafe-inline\''));
  assert.ok(!html.includes('supabase'));
});
