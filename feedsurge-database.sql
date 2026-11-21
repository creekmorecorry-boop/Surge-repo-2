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
