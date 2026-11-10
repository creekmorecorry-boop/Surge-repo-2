
-- FEEDSURGE Phase 2: private age verification + post locations.
-- Additive migration. Development database only.

create table if not exists public.feedsurge_private_accounts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  date_of_birth date not null,
  age_verified_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint feedsurge_birthdate_not_future
    check (date_of_birth <= current_date)
);

alter table public.feedsurge_private_accounts
  enable row level security;

revoke all on table public.feedsurge_private_accounts
  from anon, authenticated;

grant select, insert, update, delete
  on table public.feedsurge_private_accounts
  to service_role;

alter table public.feedsurge_posts
  add column if not exists location_name text,
  add column if not exists location_latitude double precision,
  add column if not exists location_longitude double precision,
  add column if not exists location_precision text;

alter table public.feedsurge_posts
  drop constraint if exists feedsurge_posts_location_precision_check;

alter table public.feedsurge_posts
  add constraint feedsurge_posts_location_precision_check
  check (
    location_precision is null
    or location_precision in ('exact', 'approximate')
  );

alter table public.feedsurge_posts
  drop constraint if exists feedsurge_posts_location_coordinates_check;

alter table public.feedsurge_posts
  add constraint feedsurge_posts_location_coordinates_check
  check (
    (location_latitude is null and location_longitude is null)
    or
    (location_latitude between -90 and 90
      and location_longitude between -180 and 180)
  );

create index if not exists feedsurge_posts_location_idx
  on public.feedsurge_posts(location_name)
  where location_name is not null;
