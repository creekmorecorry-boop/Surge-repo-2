-- Consolidated FEEDSURGE staging migration. Apply only to a backed-up DEVELOPMENT Supabase project.
-- Canonical sources: ../feedsurge-database.sql then ../feedsurge-phase2-platform.sql

-- FEEDSURGE additive database setup
-- Safe to run more than once. Creates missing FEEDSURGE tables and adds
-- missing columns without dropping or truncating existing data.
-- Run in the Supabase SQL Editor for the FEEDSURGE development project.

create extension if not exists pgcrypto;

-- Member profiles. If this table already exists, only missing columns are added.
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text unique,
  display_name text,
  bio text not null default '',
  avatar_url text,
  points integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles add column if not exists username text;
alter table public.profiles add column if not exists display_name text;
alter table public.profiles add column if not exists bio text not null default '';
alter table public.profiles add column if not exists avatar_url text;
alter table public.profiles add column if not exists points integer not null default 0;
alter table public.profiles add column if not exists created_at timestamptz not null default now();
alter table public.profiles add column if not exists updated_at timestamptz not null default now();

create unique index if not exists feedsurge_profiles_username_unique
  on public.profiles (lower(username))
  where username is not null and username <> '';

-- Private age-verification data. Date of birth is never part of public profiles.
create table if not exists public.feedsurge_private_accounts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  date_of_birth date not null,
  age_verified_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint feedsurge_private_dob_not_future check (date_of_birth <= current_date)
);
alter table public.feedsurge_private_accounts
  add column if not exists date_of_birth date;
alter table public.feedsurge_private_accounts
  add column if not exists age_verified_at timestamptz not null default now();
alter table public.feedsurge_private_accounts
  add column if not exists created_at timestamptz not null default now();
alter table public.feedsurge_private_accounts
  add column if not exists updated_at timestamptz not null default now();

-- Arena posts. Story content is intentionally not mixed into this table/endpoint.
create table if not exists public.feedsurge_posts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  body text not null default '',
  media_url text,
  media_type text,
  object_key text,
  size_bytes bigint,
  status text not null default 'published',
  location_name text,
  location_latitude double precision,
  location_longitude double precision,
  location_precision text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.feedsurge_posts add column if not exists body text not null default '';
alter table public.feedsurge_posts add column if not exists media_url text;
alter table public.feedsurge_posts add column if not exists media_type text;
alter table public.feedsurge_posts add column if not exists object_key text;
alter table public.feedsurge_posts add column if not exists size_bytes bigint;
alter table public.feedsurge_posts add column if not exists status text not null default 'published';
alter table public.feedsurge_posts add column if not exists location_name text;
alter table public.feedsurge_posts add column if not exists location_latitude double precision;
alter table public.feedsurge_posts add column if not exists location_longitude double precision;
alter table public.feedsurge_posts add column if not exists location_precision text;
alter table public.feedsurge_posts add column if not exists created_at timestamptz not null default now();
alter table public.feedsurge_posts add column if not exists updated_at timestamptz not null default now();

create index if not exists feedsurge_posts_feed_idx
  on public.feedsurge_posts (status, created_at desc);
create index if not exists feedsurge_posts_user_idx
  on public.feedsurge_posts (user_id, created_at desc);

-- Likes and comments.
create table if not exists public.feedsurge_likes (
  post_id uuid not null references public.feedsurge_posts(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);
create table if not exists public.feedsurge_comments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.feedsurge_posts(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  body text not null,
  created_at timestamptz not null default now()
);
create index if not exists feedsurge_comments_post_idx
  on public.feedsurge_comments (post_id, created_at);

-- Follow graph.
create table if not exists public.feedsurge_follows (
  follower_id uuid not null references auth.users(id) on delete cascade,
  followed_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (follower_id, followed_id),
  constraint feedsurge_no_self_follow check (follower_id <> followed_id)
);
create index if not exists feedsurge_follows_followed_idx
  on public.feedsurge_follows (followed_id, created_at desc);

-- Direct-message conversations and messages.
create table if not exists public.feedsurge_conversations (
  id uuid primary key default gen_random_uuid(),
  user_a uuid not null references auth.users(id) on delete cascade,
  user_b uuid not null references auth.users(id) on delete cascade,
  last_msg_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint feedsurge_conversation_distinct_users check (user_a <> user_b),
  constraint feedsurge_conversation_order check (user_a < user_b)
);
create unique index if not exists feedsurge_conversations_pair_unique
  on public.feedsurge_conversations (user_a, user_b);
create index if not exists feedsurge_conversations_user_a_idx
  on public.feedsurge_conversations (user_a, last_msg_at desc);
create index if not exists feedsurge_conversations_user_b_idx
  on public.feedsurge_conversations (user_b, last_msg_at desc);

create table if not exists public.feedsurge_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.feedsurge_conversations(id) on delete cascade,
  sender_id uuid not null references auth.users(id) on delete cascade,
  body text not null,
  read boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists feedsurge_messages_conversation_idx
  on public.feedsurge_messages (conversation_id, created_at);

-- The API uses the Supabase service-role client for these server-side operations.
-- RLS remains enabled so anon/authenticated clients cannot bypass the API.
do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'profiles',
    'feedsurge_private_accounts',
    'feedsurge_posts',
    'feedsurge_likes',
    'feedsurge_comments',
    'feedsurge_follows',
    'feedsurge_conversations',
    'feedsurge_messages'
  ]
  loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('revoke all on table public.%I from anon, authenticated', table_name);
    execute format('grant all on table public.%I to service_role', table_name);
  end loop;
end $$;

-- Keep public birthday access disabled even if a previous policy existed.
revoke all on table public.feedsurge_private_accounts from anon, authenticated;
grant all on table public.feedsurge_private_accounts to service_role;


-- FEEDSURGE Phase 2: additive platform tables and profile entitlements.
-- Safe to re-run. Does not drop, truncate, or rewrite existing member content.
-- Apply after feedsurge-database.sql in the FEEDSURGE Supabase project.

create extension if not exists pgcrypto;

-- Extend member profiles without exposing date of birth.
alter table public.profiles add column if not exists avatar_preset text;
alter table public.profiles add column if not exists account_type text not null default 'creator';
alter table public.profiles add column if not exists tier text not null default 'FREE';
alter table public.profiles add column if not exists onboarding_completed boolean not null default false;
alter table public.profiles add column if not exists updated_at timestamptz not null default now();

-- Preserve media duration for server-side video-limit enforcement.
alter table public.feedsurge_posts add column if not exists duration_seconds numeric;

-- Stories are deliberately separate from Arena posts.
create table if not exists public.feedsurge_stories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  body text not null default '',
  media_url text,
  media_type text check (media_type is null or media_type in ('photo','video')),
  object_key text,
  size_bytes bigint,
  duration_seconds numeric,
  status text not null default 'published' check (status in ('published','hidden','removed')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '24 hours'),
  constraint feedsurge_stories_content_check check (
    char_length(body) <= 1000 and (char_length(trim(body)) > 0 or media_url is not null)
  )
);
create index if not exists feedsurge_stories_feed_idx
  on public.feedsurge_stories(status, expires_at desc, created_at desc);
create index if not exists feedsurge_stories_user_idx
  on public.feedsurge_stories(user_id, created_at desc);

-- Add duration to existing Story tables as well as fresh installs.
alter table public.feedsurge_stories add column if not exists duration_seconds numeric;

-- Multi-photo Arena carousels. Single-media posts remain supported by feedsurge_posts.media_url.
create table if not exists public.feedsurge_post_media (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.feedsurge_posts(id) on delete cascade,
  position integer not null default 0 check (position >= 0),
  media_url text not null,
  media_type text not null check (media_type in ('photo','video')),
  object_key text,
  size_bytes bigint,
  duration_seconds numeric,
  created_at timestamptz not null default now(),
  unique(post_id, position)
);
alter table public.feedsurge_post_media add column if not exists duration_seconds numeric;
create index if not exists feedsurge_post_media_post_idx
  on public.feedsurge_post_media(post_id, position);

-- Business advertising campaigns and measurable delivery events.
create table if not exists public.feedsurge_ad_campaigns (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(trim(name)) between 1 and 180),
  objective text not null check (objective in ('views','clicks','conversions')),
  status text not null default 'draft' check (status in ('draft','scheduled','active','paused','completed','rejected')),
  headline text not null default '' check (char_length(headline) <= 180),
  body text not null default '' check (char_length(body) <= 2000),
  destination_url text,
  media_url text,
  media_object_key text,
  budget_cents bigint not null default 0 check (budget_cents >= 0),
  spent_cents bigint not null default 0 check (spent_cents >= 0),
  starts_at timestamptz,
  ends_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- Preserve the complete Ads Manager wizard configuration.
alter table public.feedsurge_ad_campaigns add column if not exists audience text not null default '';
alter table public.feedsurge_ad_campaigns add column if not exists placement text not null default 'arena' check (placement in ('arena','flick'));
alter table public.feedsurge_ad_campaigns add column if not exists cta text not null default 'Learn more';
alter table public.feedsurge_ad_campaigns add column if not exists bid_type text not null default 'cpm' check (bid_type in ('cpm','cpc'));
alter table public.feedsurge_ad_campaigns add column if not exists bid_amount_cents bigint not null default 1200 check (bid_amount_cents > 0);
create index if not exists feedsurge_ad_campaigns_owner_idx
  on public.feedsurge_ad_campaigns(owner_id, created_at desc);
create index if not exists feedsurge_ad_campaigns_delivery_idx
  on public.feedsurge_ad_campaigns(status, starts_at, ends_at);

create table if not exists public.feedsurge_ad_events (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.feedsurge_ad_campaigns(id) on delete cascade,
  viewer_id uuid references auth.users(id) on delete set null,
  event_type text not null check (event_type in ('impression','click','conversion')),
  occurred_at timestamptz not null default now()
);
create index if not exists feedsurge_ad_events_campaign_idx
  on public.feedsurge_ad_events(campaign_id, occurred_at desc);
create index if not exists feedsurge_ad_events_viewer_idx
  on public.feedsurge_ad_events(viewer_id, occurred_at desc);

-- User safety controls and moderation reports.
create table if not exists public.feedsurge_blocks (
  blocker_id uuid not null references auth.users(id) on delete cascade,
  blocked_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key(blocker_id, blocked_id),
  constraint feedsurge_no_self_block check(blocker_id <> blocked_id)
);
create table if not exists public.feedsurge_reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references auth.users(id) on delete cascade,
  post_id uuid references public.feedsurge_posts(id) on delete cascade,
  story_id uuid references public.feedsurge_stories(id) on delete cascade,
  reported_user_id uuid references auth.users(id) on delete cascade,
  reason text not null check(reason in ('spam','harassment','hate','nudity','violence','misinformation','copyright','other')),
  detail text check(detail is null or char_length(detail) <= 2000),
  status text not null default 'open' check(status in ('open','reviewing','resolved','dismissed')),
  created_at timestamptz not null default now(),
  constraint feedsurge_report_target_check check(num_nonnulls(post_id, story_id, reported_user_id) = 1)
);
create index if not exists feedsurge_reports_status_idx
  on public.feedsurge_reports(status, created_at asc);

-- Keep all direct client access closed; API uses the service role after session validation.
do $$
declare t text;
begin
  foreach t in array array[
    'feedsurge_stories',
    'feedsurge_post_media',
    'feedsurge_ad_campaigns',
    'feedsurge_ad_events',
    'feedsurge_blocks',
    'feedsurge_reports'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated', t);
    execute format('grant all on table public.%I to service_role', t);
  end loop;
end $$;

revoke all on table public.profiles from anon, authenticated;
grant all on table public.profiles to service_role;


-- Persistent member activity, saved posts, and reposts. Additive only.
create table if not exists public.feedsurge_saved_posts (
  user_id uuid not null references auth.users(id) on delete cascade,
  post_id uuid not null references public.feedsurge_posts(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, post_id)
);
create index if not exists feedsurge_saved_posts_user_created_idx on public.feedsurge_saved_posts(user_id, created_at desc);

create table if not exists public.feedsurge_reposts (
  user_id uuid not null references auth.users(id) on delete cascade,
  post_id uuid not null references public.feedsurge_posts(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, post_id)
);
create index if not exists feedsurge_reposts_post_idx on public.feedsurge_reposts(post_id, created_at desc);

create table if not exists public.feedsurge_notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references auth.users(id) on delete cascade,
  actor_id uuid references auth.users(id) on delete set null,
  type text not null check (type in ('like','comment','follow','repost','mention','system')),
  post_id uuid references public.feedsurge_posts(id) on delete cascade,
  body text not null default '',
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists feedsurge_notifications_recipient_created_idx on public.feedsurge_notifications(recipient_id, created_at desc);
create index if not exists feedsurge_notifications_unread_idx on public.feedsurge_notifications(recipient_id) where read_at is null;

alter table public.feedsurge_saved_posts enable row level security;
alter table public.feedsurge_reposts enable row level security;
alter table public.feedsurge_notifications enable row level security;

revoke all on table public.feedsurge_saved_posts, public.feedsurge_reposts, public.feedsurge_notifications from anon, authenticated;
grant all on table public.feedsurge_saved_posts, public.feedsurge_reposts, public.feedsurge_notifications to service_role;


-- Authenticated account settings. JSONB keeps existing settings groups additive and versionable.
create table if not exists public.feedsurge_user_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  settings jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
create index if not exists feedsurge_user_settings_updated_idx on public.feedsurge_user_settings(updated_at desc);
alter table public.feedsurge_user_settings enable row level security;
revoke all on table public.feedsurge_user_settings from anon, authenticated;
grant all on table public.feedsurge_user_settings to service_role;


-- Pass 43: query paths for paginated Arena delivery and creator discovery.
-- Additive only; existing posts, accounts, and media are untouched.
create index if not exists feedsurge_posts_published_cursor_idx
  on public.feedsurge_posts (created_at desc, id desc)
  where status = 'published';
create index if not exists feedsurge_posts_author_published_cursor_idx
  on public.feedsurge_posts (user_id, created_at desc, id desc)
  where status = 'published';
create index if not exists feedsurge_follows_follower_followed_idx
  on public.feedsurge_follows (follower_id, followed_id);
create index if not exists feedsurge_follows_followed_idx
  on public.feedsurge_follows (followed_id);
create index if not exists feedsurge_user_settings_user_id_idx
  on public.feedsurge_user_settings (user_id);


-- Pass 44: auditable billing and owner finance ledger. Additive only.
alter table public.profiles add column if not exists membership_expires_at timestamptz;
create table if not exists public.feedsurge_billing_purchases (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete restrict,
  account_type text not null check (account_type in ('creator','business')),
  plan text not null,
  amount_cents bigint not null check (amount_cents > 0),
  currency text not null default 'USD' check (currency = 'USD'),
  status text not null default 'pending' check (status in ('pending','paid','checkout_failed','refunded','cancelled')),
  square_order_id text unique,
  square_payment_id text unique,
  checkout_url text,
  paid_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists feedsurge_billing_purchases_user_idx on public.feedsurge_billing_purchases(user_id,created_at desc);
create table if not exists public.feedsurge_financial_ledger (
  id uuid primary key default gen_random_uuid(),
  event_key text not null unique,
  entry_type text not null check (entry_type in ('membership','ad_revenue','refund','expense','payout','escrow_funding','escrow_release','adjustment')),
  direction text not null check (direction in ('in','out')),
  amount_cents bigint not null check (amount_cents > 0),
  currency text not null default 'USD' check (currency = 'USD'),
  account_id uuid references auth.users(id) on delete set null,
  reference_id uuid,
  description text not null default '',
  occurred_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists feedsurge_financial_ledger_time_idx on public.feedsurge_financial_ledger(occurred_at desc,id desc);
create index if not exists feedsurge_financial_ledger_type_idx on public.feedsurge_financial_ledger(entry_type,direction,occurred_at desc);
create table if not exists public.feedsurge_square_webhook_events (
  event_id text primary key,
  event_type text not null,
  payload jsonb not null,
  received_at timestamptz not null default now()
);
revoke all on table public.feedsurge_billing_purchases, public.feedsurge_financial_ledger, public.feedsurge_square_webhook_events from anon, authenticated;
grant all on table public.feedsurge_billing_purchases, public.feedsurge_financial_ledger, public.feedsurge_square_webhook_events to service_role;
alter table public.feedsurge_billing_purchases enable row level security;
alter table public.feedsurge_financial_ledger enable row level security;
alter table public.feedsurge_square_webhook_events enable row level security;


-- Pass 46: immutable audit trail for every new ledger row. Service-role only.
create table if not exists public.feedsurge_finance_audit (
  id uuid primary key default gen_random_uuid(),
  ledger_id uuid not null unique references public.feedsurge_financial_ledger(id) on delete restrict,
  event_key text not null,
  entry_type text not null,
  direction text not null check (direction in ('in','out')),
  amount_cents bigint not null check (amount_cents > 0),
  actor_id uuid references auth.users(id) on delete set null,
  action text not null default 'ledger_insert',
  snapshot jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists feedsurge_finance_audit_created_idx on public.feedsurge_finance_audit(created_at desc,id desc);
revoke all on table public.feedsurge_finance_audit from anon, authenticated;
grant all on table public.feedsurge_finance_audit to service_role;
alter table public.feedsurge_finance_audit enable row level security;
create or replace function public.feedsurge_audit_finance_ledger_insert()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  insert into public.feedsurge_finance_audit(ledger_id,event_key,entry_type,direction,amount_cents,actor_id,action,snapshot)
  values(new.id,new.event_key,new.entry_type,new.direction,new.amount_cents,
    case when coalesce(new.metadata->>'created_by','') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then (new.metadata->>'created_by')::uuid else null end,
    case when new.metadata ? 'reverses_entry_id' then 'ledger_reversal' else 'ledger_insert' end,
    jsonb_build_object('description',new.description,'reference_id',new.reference_id,'metadata',new.metadata,'occurred_at',new.occurred_at));
  return new;
end; $$;
drop trigger if exists feedsurge_finance_ledger_audit_insert on public.feedsurge_financial_ledger;
create trigger feedsurge_finance_ledger_audit_insert after insert on public.feedsurge_financial_ledger
for each row execute function public.feedsurge_audit_finance_ledger_insert();


-- Exact database-side aggregation avoids PostgREST row-limit truncation in financial totals.
create or replace function public.feedsurge_owner_finance_summary(p_from timestamptz default null,p_to timestamptz default null)
returns jsonb language sql stable security definer set search_path=public as $$
  with ledger as (
    select entry_type,direction,amount_cents,occurred_at
    from public.feedsurge_financial_ledger
    where (p_from is null or occurred_at >= p_from)
      and (p_to is null or occurred_at < p_to)
  ), totals as (
    select
      coalesce(sum(amount_cents) filter (where direction='in'),0)::bigint as gross_revenue_cents,
      coalesce(sum(amount_cents) filter (where entry_type='refund' and direction='out'),0)::bigint as refunds_cents,
      coalesce(sum(amount_cents) filter (where entry_type='expense' and direction='out'),0)::bigint as expenses_cents,
      coalesce(sum(amount_cents) filter (where entry_type='payout' and direction='out'),0)::bigint as payouts_cents,
      coalesce(sum(amount_cents) filter (where entry_type='escrow_funding' and direction='out'),0)::bigint as escrow_funding_cents,
      coalesce(sum(amount_cents) filter (where entry_type='escrow_release' and direction='out'),0)::bigint as escrow_release_cents,
      coalesce(sum(case when direction='in' then amount_cents else -amount_cents end),0)::bigint as net_cents,
      count(*)::bigint as entries,
      max(occurred_at) as latest_entry_at
    from ledger
  ), by_type as (
    select coalesce(jsonb_object_agg(entry_type,total), '{}'::jsonb) as value
    from (select entry_type,sum(amount_cents)::bigint as total from ledger group by entry_type) grouped
  ), pending as (
    select count(*)::bigint as count,coalesce(sum(amount_cents),0)::bigint as amount_cents
    from public.feedsurge_billing_purchases where status='pending'
  )
  select jsonb_build_object(
    'currency','USD',
    'totals',to_jsonb(totals),
    'by_type',by_type.value,
    'pending_memberships',to_jsonb(pending),
    'latest_entry_at',totals.latest_entry_at
  ) from totals cross join by_type cross join pending;
$$;
revoke all on function public.feedsurge_owner_finance_summary(timestamptz,timestamptz) from public,anon,authenticated;
grant execute on function public.feedsurge_owner_finance_summary(timestamptz,timestamptz) to service_role;
