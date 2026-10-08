# Mm Cnc deployment status

Last verified: **2026-10-08**.

## Services and transition status

- Cloudflare Pages production URL: <https://mm-cnc.pages.dev/>. **Automatic production deployment succeeded for commit `68737336cd948f5ec0a407cf05de76604142c96f`**, deployment ID `9f4f5faf-8f7a-4bc1-863d-f438eb51e84e`. Sign-in, administration, and exports were verified on this origin. The Free account uses GitHub integration with repository access restricted to `Mm-Cnc`.
- Legacy address: <https://mahmooddark816185-beep.github.io/Mm-Cnc/>. **Replaced by a redirect-only site and verified in the browser.**
- Supabase project: `iwltalwntnstwydptygh`
- Public API URL: <https://iwltalwntnstwydptygh.supabase.co>
- GitHub Pages redirect deployment: [run 37742216807](https://github.com/mahmooddark816185-beep/Mm-Cnc/actions/runs/37742216807), succeeded for commit `6873733`. Earlier application checks used [run 37735994129](https://github.com/mahmooddark816185-beep/Mm-Cnc/actions/runs/37735994129), commit `6daf53f`.
- GitHub sign-in is the website's enabled provider; email/password controls remain disabled pending configured and tested email delivery.

## Cloudflare build configuration

The production branch is `main`, the build command is `npm run build`, and the output directory is `dist`. The Vite application is served at the domain root. Configure these public build variables in Cloudflare:

| Variable | Value |
| --- | --- |
| `VITE_BASE_PATH` | `/` |
| `VITE_SUPABASE_URL` | `https://iwltalwntnstwydptygh.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | The project's public publishable/anon key |
| `VITE_ENABLE_GITHUB_AUTH` | `true` |
| `VITE_ENABLE_EMAIL_AUTH` | `false` |

Use Node.js 22 for parity with the verified build. Never provide a service-role key, database password, or OAuth client secret to the frontend build.

The prepared local root-path build passed and contains 36 files. Its largest asset is the 11,210,254-byte WASM file, below the Cloudflare Pages 25 MiB per-file limit. The approximately 176 MB model remains a direct download from its external host; it is not a Pages asset. Local artifact: `test-results/cloudflare-dist`; report: `test-results/cloudflare-build-report.json`. The subsequent Cloudflare deployment and browser checks also succeeded.

## Verified

- Migration `202610080001_accounts_quota_payments.sql` was applied **once** through the trusted Supabase SQL Editor. Do not apply it again to this project.
- All **10 hosted database checks passed**: six tables and their RLS/grants, twelve functions and their execution/security settings, three own-row read policies, private-schema access restrictions, and usage-counter/trial-limit invariants.
- Anonymous API checks passed. Signed-out account/quota RPCs and reads of all three public tables returned `401 / 42501`. A request targeting `mm_cnc_private` returned `406 / PGRST106`, confirming that the private schema is not exposed.
- GitHub OAuth on the previously verified GitHub Pages origin completed successfully and loaded the verified website account with **10 free images**.
- The first sample PNG export completed successfully and changed that account to **1 used / 9 remaining**.
- Exporting the same source as DXF also completed and left the account at **1 used / 9 remaining**, confirming that the second format was not charged again.
- Owner administrator promotion was explicitly authorized and applied through the trusted SQL Editor. The database confirmed both a verified email and administrator membership for the exact owner account. On the earlier GitHub Pages origin, administration rendered, showed zero pending reviews, and persisted after reload; usage remained **1 used / 9 remaining** during that earlier check.
- On Cloudflare, GitHub login succeeded and the owner administration UI was present. The observed initial allowance was **2 used / 8 remaining**. Actual PNG and DXF files were downloaded to the local Downloads folder at 10:10 and 10:11, respectively; usage remained **2 used / 8 remaining** across those repeated exports. These observations do not establish why the initial count differed from the earlier check.
- The Cloudflare account and administration UI persisted after reload, with no console errors. Downloaded PNG and DXF hashes matched their corresponding earlier exports.
- Supabase Site URL was saved as `https://mm-cnc.pages.dev/`, and the final saved allowlist was verified to contain exactly two entries: `https://mm-cnc.pages.dev/` and `https://mm-cnc.pages.dev/#account`. Both obsolete GitHub Pages entries were removed. The GitHub OAuth application's homepage was updated successfully; its provider callback remains `https://iwltalwntnstwydptygh.supabase.co/auth/v1/callback`.
- GitHub repository variable `PAGES_REDIRECT_URL` is configured as `https://mm-cnc.pages.dev/`.
- Browser checks confirmed that the legacy `/#studio` address redirected to `https://mm-cnc.pages.dev/#studio`, and `/?redirect-check=1#account` redirected to `https://mm-cnc.pages.dev/#account` with the query string removed.

Local, ignored evidence is under `test-results/`: `hosted-database-checks.txt`, `hosted-database-checks.png`, `hosted-anonymous-checks.json`, and `deployment-cache-diagnosis.json`.

## Transition complete

Cloudflare hosts the application, the legacy GitHub Pages site redirects to it, and only the two Cloudflare URLs remain in the Supabase redirect allowlist. Deployment and authentication configuration have been verified. Real-payment testing remains outside these completed checks, as described below.

## Legacy GitHub Pages redirect

GitHub repository variable `PAGES_REDIRECT_URL` is set to `https://mm-cnc.pages.dev/`, and the redirect workflow has been published successfully. `.github/workflows/deploy.yml` generates only `index.html`, `404.html`, and `.nojekyll` in ignored `dist-pages-redirect`. It does not install application dependencies or build the paid application. Missing or invalid destination configuration fails deployment; the workflow never falls back to publishing the application. The source repository remains on GitHub. This transition removes the paid service from GitHub Pages, whose [usage limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits) prohibit that hosting use.

Recognized `#studio`, `#account`, `#formats`, `#how`, and `#top` anchors are retained. All query strings and other fragments are discarded, including OAuth codes and tokens; referrers are disabled. A visible Arabic/English link provides a fallback. Old-origin sessions and PKCE storage do not transfer: users sign in again on Cloudflare, retaining the same server-side account and allowance.

Focused safety tests: `node --test scripts/build-pages-redirect.test.mjs`.

## Manual payment administration

After signing in with the promoted owner account, open `https://mm-cnc.pages.dev/#account` to review pending payment references. The administration UI on this origin has been verified. Independently confirm the destination, transaction reference, and actual received **30 USD** in Sham Cash. Then mark the received-payment confirmation and approve the matching claim. Approval grants one calendar year from the later of the server time or the existing subscription expiry. Submitting a reference does not activate access. The database prevents an already approved payment from extending access twice.

A real received payment has **not** been approved end to end. Approval logic has automated database coverage, but this is not evidence of an actual Sham Cash transfer or production payment approval.

## Operating limits

- The plan is **10 distinct images per account**, then **30 USD for one calendar year** after manual verification and approval of the received Sham Cash transfer. Submitting a reference alone does not activate a subscription.
- Processing runs in the browser. The server protects account counters and subscription records, but a modified browser can bypass client-side processing/export restrictions. Strict paid-work enforcement would require protected server-side processing that verifies actual image bytes.
- Hosting uses free plans with service quotas and availability limits; uninterrupted or permanently free hosting is not guaranteed. Review [Supabase pricing](https://supabase.com/pricing), [Cloudflare Pages limits](https://developers.cloudflare.com/pages/platform/limits/), and [Cloudflare Pages pricing](https://developers.cloudflare.com/pages/functions/pricing/) as usage grows.
