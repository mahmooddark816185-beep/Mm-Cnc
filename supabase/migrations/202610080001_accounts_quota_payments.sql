-- Apply with the Supabase SQL editor/database owner. This file alone does not
-- connect the public site or activate billing. No payment is auto-approved.
begin;

create schema mm_cnc_private;
revoke all on schema mm_cnc_private from public, anon, authenticated;

create table public.account_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  used_count bigint not null default 0 check (used_count >= 0),
  subscription_expires_at timestamptz,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  updated_at timestamptz not null default pg_catalog.clock_timestamp()
);

create table public.image_usage (
  user_id uuid not null references public.account_profiles(user_id) on delete cascade,
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  authorization_kind text not null check (authorization_kind in ('trial', 'subscription')),
  authorized_at timestamptz not null default pg_catalog.clock_timestamp(),
  primary key (user_id, sha256)
);

create table public.payment_claims (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  user_id uuid not null references public.account_profiles(user_id) on delete cascade,
  reference text not null check (pg_catalog.char_length(reference) between 3 and 128),
  normalized_reference text not null check (pg_catalog.char_length(normalized_reference) between 3 and 128),
  sender_name text check (pg_catalog.char_length(sender_name) between 1 and 120),
  amount_usd integer not null default 30 check (amount_usd = 30),
  currency text not null default 'USD' check (currency = 'USD'),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  decided_at timestamptz,
  decided_by uuid,
  rejection_reason text check (pg_catalog.char_length(rejection_reason) between 3 and 500),
  granted_expires_at timestamptz,
  check (
    (status = 'pending' and decided_at is null and decided_by is null and rejection_reason is null and granted_expires_at is null)
    or (status = 'approved' and decided_at is not null and decided_by is not null and rejection_reason is null and granted_expires_at is not null)
    or (status = 'rejected' and decided_at is not null and decided_by is not null and rejection_reason is not null and granted_expires_at is null)
  )
);
create unique index payment_claims_live_reference on public.payment_claims(normalized_reference)
  where status in ('pending', 'approved');
create unique index payment_claims_one_pending_user on public.payment_claims(user_id) where status = 'pending';
create index payment_claims_user_created on public.payment_claims(user_id, created_at desc, id);
create index payment_claims_pending_created on public.payment_claims(created_at, id) where status = 'pending';

create table mm_cnc_private.admin_members (
  user_id uuid primary key references auth.users(id) on delete cascade,
  promoted_at timestamptz not null default pg_catalog.clock_timestamp(),
  note text
);

-- No cascading FK: deleting an account must not make a settled reference reusable.
create table mm_cnc_private.approved_payment_references (
  normalized_reference text primary key,
  payment_id uuid not null unique,
  user_id uuid not null,
  approved_at timestamptz not null,
  granted_expires_at timestamptz not null
);
create table mm_cnc_private.payment_audit (
  id bigint generated always as identity primary key,
  payment_id uuid not null,
  user_id uuid not null,
  actor_user_id uuid not null,
  event text not null check (event in ('submitted', 'approved', 'rejected')),
  happened_at timestamptz not null default pg_catalog.clock_timestamp(),
  details jsonb not null default '{}'::jsonb
);
create index payment_audit_payment_time on mm_cnc_private.payment_audit(payment_id, happened_at, id);

alter table public.account_profiles enable row level security;
alter table public.image_usage enable row level security;
alter table public.payment_claims enable row level security;
alter table mm_cnc_private.admin_members enable row level security;
alter table mm_cnc_private.approved_payment_references enable row level security;
alter table mm_cnc_private.payment_audit enable row level security;

revoke all on public.account_profiles, public.image_usage, public.payment_claims from public, anon, authenticated;
grant select on public.account_profiles, public.image_usage, public.payment_claims to authenticated;
revoke all on all tables in schema mm_cnc_private from public, anon, authenticated;
revoke all on all sequences in schema mm_cnc_private from public, anon, authenticated;

create policy account_profiles_own_read on public.account_profiles for select to authenticated
  using ((select auth.uid()) = user_id);
create policy image_usage_own_read on public.image_usage for select to authenticated
  using ((select auth.uid()) = user_id);
create policy payment_claims_own_read on public.payment_claims for select to authenticated
  using ((select auth.uid()) = user_id);

create function mm_cnc_private.require_user() returns uuid
language plpgsql security definer set search_path = '' set timezone = 'UTC' as $$
declare v_user uuid := auth.uid();
begin
  if v_user is null then raise exception 'AUTH_REQUIRED' using errcode = '28000'; end if;
  if not exists (select 1 from auth.users u where u.id = v_user and u.email is not null and u.email_confirmed_at is not null) then
    raise exception 'EMAIL_NOT_VERIFIED' using errcode = '28000';
  end if;
  return v_user;
end;
$$;

create function mm_cnc_private.require_admin() returns uuid
language plpgsql security definer set search_path = '' set timezone = 'UTC' as $$
declare v_user uuid := mm_cnc_private.require_user();
begin
  if not exists (select 1 from mm_cnc_private.admin_members a where a.user_id = v_user) then
    raise exception 'ADMIN_REQUIRED' using errcode = '42501';
  end if;
  return v_user;
end;
$$;

-- Every mutating RPC acquires this same per-account transaction lock first.
-- Payment operations then lock reference, payment row, and update the locked profile.
create function mm_cnc_private.lock_account(p_user_id uuid) returns void
language plpgsql security definer set search_path = '' set timezone = 'UTC' as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('mm-cnc:user:' || p_user_id::text, 0));
  insert into public.account_profiles(user_id) values (p_user_id) on conflict (user_id) do nothing;
  perform 1 from public.account_profiles p where p.user_id = p_user_id for update;
end;
$$;

create function mm_cnc_private.payment_json(p public.payment_claims) returns jsonb
language sql stable security definer set search_path = '' set timezone = 'UTC' as $$
  select pg_catalog.jsonb_build_object(
    'id', p.id, 'status', p.status, 'reference', p.reference, 'sender_name', p.sender_name,
    'amount_usd', p.amount_usd, 'currency', p.currency, 'created_at', p.created_at,
    'decided_at', p.decided_at, 'rejection_reason', p.rejection_reason, 'expires_at', p.granted_expires_at
  );
$$;

create function public.get_account_state() returns jsonb
language plpgsql security definer set search_path = '' set timezone = 'UTC' as $$
declare v_user uuid := mm_cnc_private.require_user(); v_profile public.account_profiles; v_now timestamptz;
begin
  perform mm_cnc_private.lock_account(v_user);
  select * into strict v_profile from public.account_profiles p where p.user_id = v_user;
  v_now := pg_catalog.clock_timestamp();
  return pg_catalog.jsonb_build_object(
    'user_id', v_user, 'used_count', v_profile.used_count,
    'free_remaining', greatest(0, 10 - v_profile.used_count),
    'expires_at', v_profile.subscription_expires_at,
    'is_subscribed', coalesce(v_profile.subscription_expires_at > v_now, false),
    'is_admin', exists(select 1 from mm_cnc_private.admin_members a where a.user_id = v_user),
    'annual_price_usd', 30, 'server_time', v_now
  );
end;
$$;

create function public.claim_image(p_sha256 text) returns jsonb
language plpgsql security definer set search_path = '' set timezone = 'UTC' as $$
declare
  v_user uuid := mm_cnc_private.require_user(); v_hash text := pg_catalog.lower(pg_catalog.btrim(p_sha256));
  v_profile public.account_profiles; v_now timestamptz; v_subscribed boolean;
  v_existing boolean; v_allowed boolean; v_reason text;
begin
  if v_hash is null or v_hash !~ '^[0-9a-f]{64}$' then raise exception 'INVALID_SHA256' using errcode = '22023'; end if;
  perform mm_cnc_private.lock_account(v_user);
  select * into strict v_profile from public.account_profiles p where p.user_id = v_user;
  v_now := pg_catalog.clock_timestamp();
  v_subscribed := coalesce(v_profile.subscription_expires_at > v_now, false);
  v_existing := exists(select 1 from public.image_usage u where u.user_id = v_user and u.sha256 = v_hash);
  v_allowed := v_existing or v_subscribed or v_profile.used_count < 10;
  v_reason := case when v_existing then 'already_counted' when v_subscribed then 'subscription'
    when v_allowed then 'trial' else 'quota_exhausted' end;
  if v_allowed and not v_existing then
    insert into public.image_usage(user_id, sha256, authorization_kind, authorized_at)
      values (v_user, v_hash, v_reason, v_now);
    update public.account_profiles p set used_count = p.used_count + 1, updated_at = v_now
      where p.user_id = v_user returning * into v_profile;
  end if;
  return pg_catalog.jsonb_build_object(
    'allowed', v_allowed, 'already_counted', v_existing, 'reason', v_reason,
    'used_count', v_profile.used_count, 'free_remaining', greatest(0, 10 - v_profile.used_count),
    'expires_at', v_profile.subscription_expires_at, 'is_subscribed', v_subscribed, 'server_time', v_now
  );
end;
$$;

create function public.submit_payment_claim(p_reference text, p_sender_name text default null) returns jsonb
language plpgsql security definer set search_path = '' set timezone = 'UTC' as $$
declare
  v_user uuid := mm_cnc_private.require_user(); v_reference text := pg_catalog.btrim(p_reference);
  v_normalized text; v_sender text := nullif(pg_catalog.btrim(p_sender_name), ''); v_payment public.payment_claims;
begin
  v_normalized := pg_catalog.lower(pg_catalog.regexp_replace(v_reference, '[[:space:]]+', '', 'g'));
  if v_reference is null or pg_catalog.char_length(v_reference) not between 3 and 128
    or pg_catalog.char_length(v_normalized) < 3 or v_reference ~ '[[:cntrl:]]' then
    raise exception 'INVALID_PAYMENT_REFERENCE' using errcode = '22023';
  end if;
  if pg_catalog.char_length(v_sender) > 120 or v_sender ~ '[[:cntrl:]]' then
    raise exception 'INVALID_SENDER_NAME' using errcode = '22023';
  end if;
  perform mm_cnc_private.lock_account(v_user);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('mm-cnc:payment:' || v_normalized, 0));
  select * into v_payment from public.payment_claims p
    where p.user_id = v_user and p.normalized_reference = v_normalized and p.status in ('pending', 'approved');
  if found then return mm_cnc_private.payment_json(v_payment); end if;
  if exists(select 1 from mm_cnc_private.approved_payment_references r where r.normalized_reference = v_normalized)
    or exists(select 1 from public.payment_claims p where p.normalized_reference = v_normalized and p.status in ('pending', 'approved')) then
    raise exception 'REFERENCE_ALREADY_USED' using errcode = '23505';
  end if;
  if exists(select 1 from public.payment_claims p where p.user_id = v_user and p.status = 'pending') then
    raise exception 'PAYMENT_PENDING_EXISTS' using errcode = '23505';
  end if;
  insert into public.payment_claims(user_id, reference, normalized_reference, sender_name)
    values (v_user, v_reference, v_normalized, v_sender) returning * into v_payment;
  insert into mm_cnc_private.payment_audit(payment_id, user_id, actor_user_id, event, details)
    values (v_payment.id, v_user, v_user, 'submitted', pg_catalog.jsonb_build_object('amount_usd', 30, 'currency', 'USD'));
  return mm_cnc_private.payment_json(v_payment);
end;
$$;

create function public.list_my_payment_claims() returns jsonb
language plpgsql security definer set search_path = '' set timezone = 'UTC' as $$
declare v_user uuid := mm_cnc_private.require_user(); v_result jsonb;
begin
  select coalesce(pg_catalog.jsonb_agg(mm_cnc_private.payment_json(p) order by p.created_at desc, p.id), '[]'::jsonb)
    into v_result from public.payment_claims p where p.user_id = v_user;
  return v_result;
end;
$$;

create function public.admin_list_pending_payments(p_limit integer default 50, p_offset integer default 0) returns jsonb
language plpgsql security definer set search_path = '' set timezone = 'UTC' as $$
declare v_result jsonb;
begin
  perform mm_cnc_private.require_admin();
  if p_limit is null or p_limit not between 1 and 100 or p_offset is null or p_offset < 0 then
    raise exception 'INVALID_PAGINATION' using errcode = '22023';
  end if;
  select coalesce(pg_catalog.jsonb_agg(q.payload order by q.created_at, q.id), '[]'::jsonb) into v_result
  from (
    select p.id, p.created_at, mm_cnc_private.payment_json(p) ||
      pg_catalog.jsonb_build_object('user_id', p.user_id, 'email', u.email) as payload
    from public.payment_claims p join auth.users u on u.id = p.user_id
    where p.status = 'pending' order by p.created_at, p.id limit p_limit offset p_offset
  ) q;
  return v_result;
end;
$$;

create function public.admin_approve_payment(p_payment_id uuid) returns jsonb
language plpgsql security definer set search_path = '' set timezone = 'UTC' as $$
declare
  v_admin uuid := mm_cnc_private.require_admin(); v_payment public.payment_claims;
  v_previous timestamptz; v_expires timestamptz; v_now timestamptz;
begin
  select * into v_payment from public.payment_claims p where p.id = p_payment_id;
  if not found then raise exception 'PAYMENT_NOT_FOUND' using errcode = 'P0002'; end if;
  perform mm_cnc_private.lock_account(v_payment.user_id);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('mm-cnc:payment:' || v_payment.normalized_reference, 0));
  select * into v_payment from public.payment_claims p where p.id = p_payment_id for update;
  if not found then raise exception 'PAYMENT_NOT_FOUND' using errcode = 'P0002'; end if;
  if v_payment.status = 'approved' then
    return pg_catalog.jsonb_build_object('id', v_payment.id, 'status', 'approved', 'user_id', v_payment.user_id,
      'expires_at', v_payment.granted_expires_at, 'already_decided', true);
  end if;
  if v_payment.status <> 'pending' then raise exception 'PAYMENT_ALREADY_REJECTED' using errcode = '55000'; end if;
  v_now := pg_catalog.clock_timestamp();
  select p.subscription_expires_at into strict v_previous from public.account_profiles p where p.user_id = v_payment.user_id;
  v_expires := greatest(v_now, coalesce(v_previous, v_now)) + interval '1 year';
  insert into mm_cnc_private.approved_payment_references(normalized_reference, payment_id, user_id, approved_at, granted_expires_at)
    values (v_payment.normalized_reference, v_payment.id, v_payment.user_id, v_now, v_expires);
  update public.account_profiles p set subscription_expires_at = v_expires, updated_at = v_now where p.user_id = v_payment.user_id;
  update public.payment_claims p set status = 'approved', decided_at = v_now, decided_by = v_admin, granted_expires_at = v_expires
    where p.id = v_payment.id;
  insert into mm_cnc_private.payment_audit(payment_id, user_id, actor_user_id, event, happened_at, details)
    values (v_payment.id, v_payment.user_id, v_admin, 'approved', v_now,
      pg_catalog.jsonb_build_object('amount_usd', 30, 'currency', 'USD', 'previous_expires_at', v_previous, 'expires_at', v_expires));
  return pg_catalog.jsonb_build_object('id', v_payment.id, 'status', 'approved', 'user_id', v_payment.user_id,
    'expires_at', v_expires, 'already_decided', false);
end;
$$;

create function public.admin_reject_payment(p_payment_id uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' set timezone = 'UTC' as $$
declare
  v_admin uuid := mm_cnc_private.require_admin(); v_payment public.payment_claims;
  v_reason text := pg_catalog.btrim(p_reason); v_now timestamptz;
begin
  if v_reason is null or pg_catalog.char_length(v_reason) not between 3 and 500 then
    raise exception 'INVALID_REJECTION_REASON' using errcode = '22023';
  end if;
  select * into v_payment from public.payment_claims p where p.id = p_payment_id;
  if not found then raise exception 'PAYMENT_NOT_FOUND' using errcode = 'P0002'; end if;
  perform mm_cnc_private.lock_account(v_payment.user_id);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('mm-cnc:payment:' || v_payment.normalized_reference, 0));
  select * into v_payment from public.payment_claims p where p.id = p_payment_id for update;
  if not found then raise exception 'PAYMENT_NOT_FOUND' using errcode = 'P0002'; end if;
  if v_payment.status = 'rejected' then
    return pg_catalog.jsonb_build_object('id', v_payment.id, 'status', 'rejected', 'already_decided', true);
  end if;
  if v_payment.status <> 'pending' then raise exception 'PAYMENT_ALREADY_APPROVED' using errcode = '55000'; end if;
  v_now := pg_catalog.clock_timestamp();
  update public.payment_claims p set status = 'rejected', decided_at = v_now, decided_by = v_admin, rejection_reason = v_reason
    where p.id = v_payment.id;
  insert into mm_cnc_private.payment_audit(payment_id, user_id, actor_user_id, event, happened_at, details)
    values (v_payment.id, v_payment.user_id, v_admin, 'rejected', v_now, pg_catalog.jsonb_build_object('reason', v_reason));
  return pg_catalog.jsonb_build_object('id', v_payment.id, 'status', 'rejected', 'already_decided', false);
end;
$$;

create function public.admin_list_payment_audit(p_payment_id uuid) returns jsonb
language plpgsql security definer set search_path = '' set timezone = 'UTC' as $$
declare v_result jsonb;
begin
  perform mm_cnc_private.require_admin();
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'id', a.id, 'payment_id', a.payment_id, 'user_id', a.user_id, 'actor_user_id', a.actor_user_id,
    'event', a.event, 'happened_at', a.happened_at, 'details', a.details
  ) order by a.happened_at, a.id), '[]'::jsonb) into v_result
    from mm_cnc_private.payment_audit a where a.payment_id = p_payment_id;
  return v_result;
end;
$$;

-- PostgreSQL grants function EXECUTE to PUBLIC by default. Remove that default
-- from these exact functions; only authenticated sessions can reach public RPCs.
revoke all on all functions in schema mm_cnc_private from public, anon, authenticated;
revoke all on function public.get_account_state(), public.claim_image(text),
  public.submit_payment_claim(text, text), public.list_my_payment_claims(),
  public.admin_list_pending_payments(integer, integer), public.admin_approve_payment(uuid),
  public.admin_reject_payment(uuid, text), public.admin_list_payment_audit(uuid) from public, anon, authenticated;
grant execute on function public.get_account_state(), public.claim_image(text),
  public.submit_payment_claim(text, text), public.list_my_payment_claims(),
  public.admin_list_pending_payments(integer, integer), public.admin_approve_payment(uuid),
  public.admin_reject_payment(uuid, text), public.admin_list_payment_audit(uuid) to authenticated;

commit;
