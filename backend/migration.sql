
-- SURGE security migration. Additive only: does not drop or reset existing tables.
-- Review the function definitions and run in Supabase SQL Editor before deploying server.js.
-- Expected existing tables/columns follow the SURGE schema and the current backend routes.

-- Prevent the same account from claiming the same drop more than once.
CREATE UNIQUE INDEX IF NOT EXISTS video_engagements_user_video_unique
  ON public.video_engagements (user_id, video_id);

-- The existing activate_membership_secure function uses square_order_id.
-- Preserve its existing uniqueness constraint; do not add a second billing-reference index here.

CREATE OR REPLACE FUNCTION public.surge_claim_kinetic_secure(
  p_user_id uuid,
  p_video_id text,
  p_daily_limit integer DEFAULT 5,
  p_points integer DEFAULT 10
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_profile public.profiles%ROWTYPE;
  v_video public.videos%ROWTYPE;
  v_count integer;
  v_new_points integer;
BEGIN
  IF p_points <> 10 OR p_daily_limit < 1 OR p_daily_limit > 100 THEN
    RAISE EXCEPTION 'Invalid claim parameters' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_profile FROM public.profiles WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Profile not found' USING ERRCODE = 'P0002'; END IF;

  SELECT * INTO v_video FROM public.videos WHERE id::text = p_video_id AND status = 'approved' LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'Drop not available' USING ERRCODE = 'P0002'; END IF;

  SELECT count(*) INTO v_count
    FROM public.video_engagements
   WHERE user_id = p_user_id
     AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  IF v_count >= p_daily_limit THEN
    RAISE EXCEPTION 'Daily limit reached (%)', p_daily_limit USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.video_engagements (user_id, video_id, points)
  VALUES (p_user_id, v_video.id, p_points);

  v_new_points := COALESCE(v_profile.points, 0) + p_points;
  UPDATE public.profiles SET points = v_new_points WHERE id = p_user_id;

  -- Current saved schema uses total_points; older backend variants use points.
  BEGIN
    INSERT INTO public.leaderboard (user_id, total_points, updated_at)
    VALUES (p_user_id, v_new_points, now())
    ON CONFLICT (user_id) DO UPDATE SET total_points = EXCLUDED.total_points, updated_at = now();
  EXCEPTION WHEN undefined_column THEN
    INSERT INTO public.leaderboard (user_id, points)
    VALUES (p_user_id, v_new_points)
    ON CONFLICT (user_id) DO UPDATE SET points = EXCLUDED.points;
  END;

  RETURN jsonb_build_object('ok', true, 'points', v_new_points);
EXCEPTION
  WHEN unique_violation THEN
    RAISE EXCEPTION 'Already claimed' USING ERRCODE = '23505';
END;
$$;

CREATE OR REPLACE FUNCTION public.surge_redeem_promo_secure(
  p_user_id uuid,
  p_video_id text,
  p_promo_id text,
  p_cost integer
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_profile public.profiles%ROWTYPE;
  v_video public.videos%ROWTYPE;
  v_promo_id uuid;
  v_duration integer;
  v_expected_cost integer;
  v_new_points integer;
  v_start timestamptz := now();
  v_end timestamptz;
BEGIN
  v_expected_cost := CASE p_promo_id WHEN 'boost' THEN 100 WHEN 'feature' THEN 250 WHEN 'review' THEN 500 ELSE NULL END;
  v_duration := CASE p_promo_id WHEN 'boost' THEN 24 WHEN 'feature' THEN 72 WHEN 'review' THEN 168 ELSE NULL END;
  IF v_expected_cost IS NULL OR p_cost <> v_expected_cost THEN
    RAISE EXCEPTION 'Invalid promotion' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_profile FROM public.profiles WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Profile not found' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO v_video FROM public.videos WHERE id::text = p_video_id LIMIT 1;
  IF NOT FOUND OR v_video.user_id <> p_user_id THEN RAISE EXCEPTION 'Not your campaign' USING ERRCODE = '42501'; END IF;
  IF v_video.status <> 'approved' THEN RAISE EXCEPTION 'Campaign not approved' USING ERRCODE = 'P0001'; END IF;
  IF COALESCE(v_profile.points, 0) < v_expected_cost THEN RAISE EXCEPTION 'Insufficient points' USING ERRCODE = 'P0001'; END IF;

  v_new_points := COALESCE(v_profile.points, 0) - v_expected_cost;
  UPDATE public.profiles SET points = v_new_points WHERE id = p_user_id;
  v_end := v_start + make_interval(hours => v_duration);

  INSERT INTO public.promotions (user_id, video_id, promo_type, cost, starts_at, ends_at, status)
  VALUES (p_user_id, v_video.id, p_promo_id, v_expected_cost, v_start, v_end, 'active')
  RETURNING id INTO v_promo_id;

  INSERT INTO public.point_transactions (user_id, amount, reason, video_id, promotion_id)
  VALUES (p_user_id, -v_expected_cost, 'promo_' || p_promo_id, v_video.id, v_promo_id);

  INSERT INTO public.notifications (user_id, type, video_id, body)
  VALUES (p_user_id, 'promotion', v_video.id, 'Your ' || p_promo_id || ' promotion is now active.');

  RETURN jsonb_build_object('ok', true, 'points', v_new_points, 'promotion_id', v_promo_id);
END;
$$;

-- RPCs must only be callable by the backend service role. No public/anon/authenticated execution.
REVOKE ALL ON FUNCTION public.surge_claim_kinetic_secure(uuid, text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.surge_claim_kinetic_secure(uuid, text, integer, integer) TO service_role;
REVOKE ALL ON FUNCTION public.surge_redeem_promo_secure(uuid, text, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.surge_redeem_promo_secure(uuid, text, text, integer) TO service_role;

-- SURGE photo/video publishing and profile pictures. Additive migration only.
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS avatar_url text;
CREATE TABLE IF NOT EXISTS public.surge_media (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  object_key text NOT NULL UNIQUE,
  public_url text NOT NULL,
  media_type text NOT NULL CHECK (media_type IN ('photo','video')),
  content_type text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes > 0),
  title text,
  description text,
  status text NOT NULL DEFAULT 'published' CHECK (status IN ('published','pending','removed')),
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Moderation can temporarily hide a reported post. Reconcile the generated status check
-- so the moderator API can use the hidden state without a constraint violation.
ALTER TABLE public.surge_media DROP CONSTRAINT IF EXISTS surge_media_status_check;
ALTER TABLE public.surge_media ADD CONSTRAINT surge_media_status_check
  CHECK (status IN ('published','pending','hidden','removed'));
CREATE INDEX IF NOT EXISTS surge_media_published_created_idx
  ON public.surge_media (status, created_at DESC);
CREATE INDEX IF NOT EXISTS surge_media_user_created_idx
  ON public.surge_media (user_id, created_at DESC);
ALTER TABLE public.surge_media ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.surge_media FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.surge_media TO service_role;


-- Persistent social layer for published photo/video SURGEs.
CREATE TABLE IF NOT EXISTS public.surge_media_likes (
  media_id uuid NOT NULL REFERENCES public.surge_media(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (media_id, user_id)
);
CREATE INDEX IF NOT EXISTS surge_media_likes_user_idx ON public.surge_media_likes(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.surge_media_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  media_id uuid NOT NULL REFERENCES public.surge_media(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 1000),
  status text NOT NULL DEFAULT 'visible' CHECK (status IN ('visible','hidden','removed')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS surge_media_comments_media_idx ON public.surge_media_comments(media_id, created_at);

CREATE TABLE IF NOT EXISTS public.surge_follows (
  follower_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  followed_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (follower_id, followed_id),
  CHECK (follower_id <> followed_id)
);
CREATE INDEX IF NOT EXISTS surge_follows_followed_idx ON public.surge_follows(followed_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.surge_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  media_id uuid REFERENCES public.surge_media(id) ON DELETE SET NULL,
  reported_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  reason text NOT NULL CHECK (reason IN ('spam','abuse','copyright','other')),
  detail text,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','reviewing','resolved','dismissed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (media_id IS NOT NULL OR reported_user_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS surge_reports_status_created_idx ON public.surge_reports(status, created_at DESC);

-- Backend service role is the only writer/reader for these records; users cannot bypass API checks.
ALTER TABLE public.surge_media_likes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.surge_media_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.surge_follows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.surge_reports ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.surge_media_likes, public.surge_media_comments, public.surge_follows, public.surge_reports FROM anon, authenticated;
GRANT SELECT, INSERT, DELETE ON TABLE public.surge_media_likes TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.surge_media_comments TO service_role;
GRANT SELECT, INSERT, DELETE ON TABLE public.surge_follows TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.surge_reports TO service_role;


-- Legal acceptance audit: records acceptance metadata submitted by the first-party signup flow.
-- This is a supporting record, not a substitute for configuring/enforcing the actual signup flow.
CREATE TABLE IF NOT EXISTS public.surge_legal_acceptances (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  terms_version text NOT NULL,
  privacy_version text NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.surge_legal_acceptances ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.surge_legal_acceptances FROM anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.surge_legal_acceptances TO service_role;

CREATE OR REPLACE FUNCTION public.surge_capture_legal_acceptance()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_meta jsonb := COALESCE(NEW.raw_user_meta_data, '{}'::jsonb);
  v_accepted_at timestamptz;
BEGIN
  IF v_meta->>'surge_terms_accepted' = 'true'
     AND NULLIF(v_meta->>'surge_terms_version','') IS NOT NULL
     AND NULLIF(v_meta->>'surge_privacy_version','') IS NOT NULL THEN
    BEGIN
      v_accepted_at := (v_meta->>'surge_legal_accepted_at')::timestamptz;
    EXCEPTION WHEN others THEN
      v_accepted_at := now();
    END;
    INSERT INTO public.surge_legal_acceptances(user_id, terms_version, privacy_version, accepted_at)
    VALUES (NEW.id, v_meta->>'surge_terms_version', v_meta->>'surge_privacy_version', COALESCE(v_accepted_at, now()))
    ON CONFLICT (user_id) DO UPDATE SET
      terms_version = EXCLUDED.terms_version,
      privacy_version = EXCLUDED.privacy_version,
      accepted_at = EXCLUDED.accepted_at;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS surge_capture_legal_acceptance_after_signup ON auth.users;
CREATE TRIGGER surge_capture_legal_acceptance_after_signup
AFTER INSERT OR UPDATE ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.surge_capture_legal_acceptance();
REVOKE ALL ON FUNCTION public.surge_capture_legal_acceptance() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.surge_capture_legal_acceptance() TO service_role;

-- Three distinct reports may temporarily hide a post while the team reviews it.
ALTER TABLE public.surge_media DROP CONSTRAINT IF EXISTS surge_media_status_check;
ALTER TABLE public.surge_media ADD CONSTRAINT surge_media_status_check
  CHECK (status IN ('published','pending','removed','hidden'));
CREATE UNIQUE INDEX IF NOT EXISTS surge_reports_one_per_user_per_media
  ON public.surge_reports(media_id, reporter_id) WHERE media_id IS NOT NULL;
