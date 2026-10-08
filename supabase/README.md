# Accounts, image allowance, and manual Sham Cash subscriptions

The backend is active for <https://mm-cnc.pages.dev/>. Hosted database protections,
GitHub sign-in, account allowance, repeated exports, and owner administration have
been verified. See [deployment status](DEPLOYMENT.md) for evidence, the completed
hosting transition, and operating limits. A real received Sham Cash payment has not been approved end to
end. Committing these files alone never creates accounts or verifies payments.

## Deploy a new environment

The migration has already been applied to the production project. Do not run it
again there. The steps below describe initial setup or a separate environment.

1. Create/select the intended Supabase project. In Authentication, configure a
   supported sign-in provider. For email/password enable **Confirm email** and
   configure custom SMTP; the default Supabase mail service cannot send confirmation
   to general customers. GitHub OAuth is an alternative that does not use SMTP.
   These RPCs require an
   authenticated account with a confirmed email; anonymous accounts cannot use
   them. Signing into the Supabase dashboard with GitHub is a separate action
   from signing into this website.
2. Set the Auth Site URL to
   `https://mm-cnc.pages.dev/` and add that exact application URL and
   `https://mm-cnc.pages.dev/#account` to allowed redirect URLs. Add local
   development URLs separately if needed. If enabling email/password sign-in,
   configure production email delivery and test confirmation/password recovery
   first; production currently uses GitHub sign-in only.
3. Run `migrations/202610080001_accounts_quota_payments.sql` once in the Supabase
   SQL Editor as the database owner, or apply it with your normal Supabase
   migration workflow. It runs in one transaction and creates new tables and
   functions. It is not intended to be pasted repeatedly into the same database.
4. Keep `mm_cnc_private` out of the Data API's exposed schemas. Only the public
   tables/RPCs need exposure. Do not grant API users access to private tables or
   helper functions.
5. Configure the frontend only after the migration succeeds. Supply the project
   URL and its publishable/anon key through the application's documented settings.
   Never place a service-role key, database password, or Sham Cash credentials in
   frontend code, public build variables, or the repository.
   In this repository those public build variables are `VITE_SUPABASE_URL` and
   `VITE_SUPABASE_ANON_KEY`. Enable tested providers using
   `VITE_ENABLE_GITHUB_AUTH=true` and/or `VITE_ENABLE_EMAIL_AUTH=true`.
   Keep other providers disabled. Cloudflare Pages reads these values from its
   build environment variables; rebuild after changing them. Use
   `VITE_BASE_PATH=/`, build command `npm run build`, and output directory `dist`.
   The GitHub Pages workflow only publishes a legacy redirect and does not build
   this application. An incomplete configuration blocks authorization rather
   than allowing unlimited downloads.
6. Create and confirm the owner's website account. Promote that exact account
   using the SQL below. No signup field, user metadata, JWT metadata, frontend
   email list, or client-supplied `is_admin` value can grant administrator access.
7. Verify with two ordinary test accounts and one owner account: the 11th unique
   image is denied, repeating an image is free, direct entitlement writes fail,
   users cannot read each other's rows, ordinary users cannot approve payments,
   and approving the same payment twice grants only one year.

## Promote an administrator by verified email

Run this only in the trusted SQL Editor as the database owner, after replacing
the placeholder with the exact owner's verified website email. `INTO STRICT`
fails if no confirmed account matches, so a typo cannot silently select another
account. An admin account is not created by this statement.

```sql
do $$
declare target_user uuid;
begin
  select u.id into strict target_user
  from auth.users u
  where pg_catalog.lower(u.email) = pg_catalog.lower('REPLACE_WITH_VERIFIED_OWNER_EMAIL')
    and u.email_confirmed_at is not null;

  insert into mm_cnc_private.admin_members(user_id, note)
  values (target_user, 'Owner verified and promoted through the trusted SQL Editor')
  on conflict (user_id) do nothing;
end;
$$;
```

To remove that role, use the SQL Editor; users cannot remove or grant it from the
Data API:

```sql
delete from mm_cnc_private.admin_members a
using auth.users u
where a.user_id = u.id
  and pg_catalog.lower(u.email) = pg_catalog.lower('REPLACE_WITH_OWNER_EMAIL');
```

## Image allowance

- Every account receives **10 distinct image files for its lifetime**. The client
  hashes the original file bytes with SHA-256 and submits the 64-character hex
  digest before admitting the image. No image bytes are stored by this schema.
- A successful first claim adds exactly one usage record and increments the
  account count in the same transaction. Duplicate claims for that account and
  digest return the previous authorization without increasing the count.
- An active subscriber can claim new distinct images without a limit until the
  server's `subscription_expires_at`. `used_count` still counts these unique
  images. After expiry, an account with ten or more distinct images cannot admit
  a new digest. Previously admitted digests remain reusable.
- `free_remaining` is always `max(0, 10 - used_count)`. The frontend should show
  unlimited access when `is_subscribed` is true instead of treating that number
  as the subscriber's allowance.
- Timestamps and expiry checks come from the database. User/device clocks are
  never accepted. The same per-user transaction lock serializes usage claims,
  profile creation, and subscription changes; locks last only for the RPC's
  database transaction.

**Enforcement boundary:** the current website processes images in the browser.
The database enforces the allowance for submitted account/digest requests, but
cannot establish that a client-provided digest matches the file a modified
browser actually processes. A modified client can also bypass local processing
controls. Strong enforcement requires a protected server-side operation that
computes/verifies the digest from actual bytes before doing the paid work. This
schema is account/quota bookkeeping, not anti-copy protection. Multiple verified
accounts are also separate users; this is not a device or person identity check.

## Manual payment review

The plan costs **30 USD for one calendar year**. The application displays the
owner-provided Sham Cash payment instructions/QR. This schema never initiates a
transfer and has no access to the wallet. The customer submits a transaction
reference and, optionally, their sender name. Do not ask for card numbers,
passwords, wallet recovery phrases, or card security codes. No receipt upload is
implemented.

The administrator independently confirms the reference, received amount, and
destination in their own Sham Cash records, then approves or rejects the claim.
Submitting a reference is not evidence that money was received and never grants
access automatically. Do not approve using only the customer's entered text.

Each account may have one pending claim. References are trimmed, compared without
whitespace, and compared case-insensitively. Repeating the same pending or
approved reference for the same account returns the original claim. A pending or
approved reference cannot be claimed by another account. After rejection a
corrected claim can be submitted, including the same reference for review.

Approval atomically:

1. Verifies current administrator membership in a private table.
2. Locks the target account, normalized reference, and claim.
3. Requires a pending claim, or returns the already completed approval unchanged.
4. Extends expiry by `interval '1 year'` from the later of the server's current
   timestamp and the existing expiry, using UTC calendar arithmetic.
5. Records the settled reference and an immutable-through-the-API audit event.

Approval and rejection are terminal. Retrying the same decision is idempotent;
trying the opposite decision fails. A later distinct payment can extend the
subscription again. Rejection does not change subscription expiry and records a
reason visible to the customer. The owner can review the audit with an admin RPC.

Private audit and settled-reference records intentionally survive deletion of
the corresponding Auth account. Otherwise a settled reference could be reused
after deletion. Define a retention policy before production; any trusted manual
cleanup must preserve the non-reuse ledger for payments that can still be
presented. Database owners retain maintenance powers; clients have no update or
delete permission for this ledger or audit.

## Frontend RPC contract

Every RPC below requires an authenticated, email-confirmed user. Use the user's
session token with Supabase `rpc`; never pass a target user ID for ordinary user
actions. `expires_at` is nullable and all timestamps are server timestamps.

| RPC | Arguments | Result |
| --- | --- | --- |
| `get_account_state` | none | `{user_id, used_count, free_remaining, expires_at, is_subscribed, is_admin, annual_price_usd: 30, server_time}` |
| `claim_image` | `{p_sha256: string}` | `{allowed, already_counted, reason, used_count, free_remaining, expires_at, is_subscribed, server_time}` |
| `submit_payment_claim` | `{p_reference: string, p_sender_name: string \| null}` | Payment object |
| `list_my_payment_claims` | none | Payment object array, newest first |
| `admin_list_pending_payments` | `{p_limit: 50, p_offset: 0}` | Payment object array, oldest first, with `user_id` and `email` |
| `admin_approve_payment` | `{p_payment_id: uuid}` | `{id, status: 'approved', user_id, expires_at, already_decided}` |
| `admin_reject_payment` | `{p_payment_id: uuid, p_reason: string}` | `{id, status: 'rejected', already_decided}` |
| `admin_list_payment_audit` | `{p_payment_id: uuid}` | Audit event array in chronological order |

Payment object:

```text
{ id, status: 'pending' | 'approved' | 'rejected', reference, sender_name,
  amount_usd: 30, currency: 'USD', created_at, decided_at, rejection_reason,
  expires_at }
```

Claim reasons: `trial`, `subscription`, `already_counted`, `quota_exhausted`.
An exhausted quota returns `allowed:false`; it is not an RPC error. Refetch
`get_account_state` after a successful admin decision. An idempotent approval's
`expires_at` is the expiry granted by that payment, not a later renewal's expiry.

Useful error messages: `AUTH_REQUIRED`, `EMAIL_NOT_VERIFIED`, `ADMIN_REQUIRED`,
`INVALID_SHA256`, `INVALID_PAYMENT_REFERENCE`, `INVALID_SENDER_NAME`,
`PAYMENT_PENDING_EXISTS`, `REFERENCE_ALREADY_USED`, `PAYMENT_NOT_FOUND`,
`PAYMENT_ALREADY_APPROVED`, `PAYMENT_ALREADY_REJECTED`,
`INVALID_REJECTION_REASON`, `INVALID_PAGINATION`.

References are 3–128 characters, sender names are optional and at most 120
characters, rejection reasons are 3–500 characters. The pending admin page accepts
1–100 rows and a nonnegative offset. Ordinary users can directly select only
their own profile, image-usage and payment rows under RLS; they cannot write any
of those tables directly. All writes go through the checked RPCs.

## Security implementation references

The migration uses fixed empty function search paths, qualified object names,
explicit function grants, and RLS, following the Supabase guidance for
[database functions](https://supabase.com/docs/guides/database/functions) and
[row-level security](https://supabase.com/docs/guides/database/postgres/row-level-security).
