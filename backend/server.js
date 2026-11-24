  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif"
].includes(String(content_type || "").toLowerCase());

if (mode === "avatar") {
  if (!isImage) {
    return res.status(400).json({ error: "Profile photos must be JPEG, PNG, WEBP, or GIF." });
  }

  const { error: profileError } = await admin
    .from("profiles")
    .update({ avatar_url: public_url })
    .eq("id", user_id);

  if (profileError) {
    return res.status(503).json({ error: "Could not update profile photo." });
  }

  return res.json({ ok: true, avatar_url: public_url, publicUrl: public_url });
}

if (!["photo", "video"].includes(media_type)) {
  return res.status(400).json({ error: "Media type must be photo or video." });
}

const { data, error } = await admin
  .from("surge_media")
  .insert({
    user_id,
    object_key: key,
    public_url,
    media_type,
    content_type: content_type || null,
    size_bytes: Number(size_bytes) || null,
    title: String(caption || title || "New post").slice(0, 500),
    description: String(description || "").slice(0, 2000),
    status: "published"
  })
  .select("*")
  .single();

if (error) {
  console.error("Media insert failed:", error);
  return res.status(503).json({ error: "Your upload completed, but the post could not be saved." });
}

return res.status(201).json({
  ok: true,
  media: data,
  post: data,
  id: data.id,
  media_url: data.public_url,
  public_url: data.public_url,
  caption: data.title
});
} catch (error) {
  console.error("POST /api/media:", error);
  return res.status(500).json({ error: "Could not publish this post." });
}
});

app.get("/api/media", async (req, res) => {
  if (!admin) return res.status(503).json({ error: "Database is not configured." });

  const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 100);

  try {
    const { data, error } = await admin
      .from("surge_media")
      .select("id,user_id,object_key,public_url,media_type,content_type,size_bytes,title,description,status,created_at")
      .eq("status", "published")
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error) throw error;

    const userIds = [...new Set((data || []).map(item => item.user_id).filter(Boolean))];
    let profiles = [];

    if (userIds.length) {
      const result = await admin
        .from("profiles")
        .select("id,username,display_name,avatar_url")
        .in("id", userIds);

      if (!result.error) profiles = result.data || [];
    }

    const profileMap = new Map(profiles.map(profile => [profile.id, profile]));

    const media = (data || []).map(item => ({
      ...item,
      media_url: item.public_url,
      caption: item.title,
      author: profileMap.get(item.user_id) || null,
      profile: profileMap.get(item.user_id) || null
    }));

    return res.json({ ok: true, media, items: media, posts: media });
  } catch (error) {
    console.error("GET /api/media:", error);
    return res.status(503).json({ error: "Could not load the feed." });
  }
});

app.get("/api/me/profile", async (req, res) => {
  const user_id = await getUserId(req);
  if (!user_id) return res.status(401).json({ error: "Sign in required." });

  try {
    const profile = await getProfile(user_id);
    return res.json({ ok: true, profile });
  } catch {
    return res.status(503).json({ error: "Could not load your profile." });
  }
});

app.get("/api/users/:id/profile", async (req, res) => {
  if (!admin) return res.status(503).json({ error: "Database is not configured." });

  const targetId = req.params.id;
  if (!isUuid(targetId)) return res.status(400).json({ error: "Invalid user ID." });

  try {
    const [profileResult, mediaResult, followerResult, followingResult] = await Promise.all([
      admin.from("profiles").select("*").eq("id", targetId).maybeSingle(),
      admin.from("surge_media").select("id,user_id,public_url,media_type,title,created_at")
        .eq("user_id", targetId).eq("status", "published")
        .order("created_at", { ascending: false }).limit(100),
      admin.from("surge_follows").select("follower_id", { count: "exact", head: true })
        .eq("followed_id", targetId),
      admin.from("surge_follows").select("followed_id", { count: "exact", head: true })
        .eq("follower_id", targetId)
    ]);

    if (profileResult.error) throw profileResult.error;
    if (mediaResult.error) throw mediaResult.error;

    return res.json({
      ok: true,
      profile: profileResult.data,
      media: (mediaResult.data || []).map(item => ({
        ...item,
        media_url: item.public_url,
        caption: item.title
      })),
      posts: (mediaResult.data || []).map(item => ({
        ...item,
        media_url: item.public_url,
        caption: item.title
      })),
      counts: {
        posts: mediaResult.data?.length || 0,
        followers: followerResult.count || 0,
        following: followingResult.count || 0
      }
    });
  } catch (error) {
    console.error("GET user profile:", error);
    return res.status(503).json({ error: "Could not load this profile." });
  }
});

async function toggleLike(req, res) {
  const user_id = await getUserId(req);
  if (!user_id) return res.status(401).json({ error: "Sign in required." });
  if (!admin) return res.status(503).json({ error: "Database is not configured." });

  const media_id = req.body?.media_id || req.params?.id;
  if (!isUuid(media_id)) return res.status(400).json({ error: "Invalid post ID." });

  try {
    const { data: existing, error: findError } = await admin
      .from("surge_media_likes")
      .select("media_id")
      .eq("media_id", media_id)
      .eq("user_id", user_id)
      .maybeSingle();

    if (findError) throw findError;

    let liked;

    if (existing) {
      const { error } = await admin.from("surge_media_likes")
        .delete().eq("media_id", media_id).eq("user_id", user_id);
      if (error) throw error;
      liked = false;
    } else {
      const { error } = await admin.from("surge_media_likes")
        .insert({ media_id, user_id });
      if (error) throw error;
      liked = true;
    }

    const { count } = await admin.from("surge_media_likes")
      .select("media_id", { count: "exact", head: true })
      .eq("media_id", media_id);

    return res.json({
      ok: true,
      liked,
      alreadyLiked: liked,
      count: count || 0
    });
  } catch (error) {
    console.error("Like toggle:", error);
    return res.status(503).json({ error: "Could not update like." });
  }
}

app.post("/api/likes", authActionLimiter, toggleLike);
app.post("/api/media/:id/like", authActionLimiter, toggleLike);

app.get("/api/media/:id/comments", async (req, res) => {
  if (!admin) return res.status(503).json({ error: "Database is not configured." });

  const media_id = req.params.id;
  if (!isUuid(media_id)) return res.status(400).json({ error: "Invalid post ID." });

  try {
    const { data, error } = await admin
      .from("surge_media_comments")
      .select("id,media_id,user_id,body,created_at,status")
      .eq("media_id", media_id)
      .eq("status", "visible")
      .order("created_at", { ascending: true })
      .limit(200);

    if (error) throw error;
    return res.json({ ok: true, comments: data || [] });
  } catch {
    return res.status(503).json({ error: "Could not load comments." });
  }
});

app.post("/api/media/:id/comments", authActionLimiter, async (req, res) => {
  const user_id = await getUserId(req);
  if (!user_id) return res.status(401).json({ error: "Sign in required." });
  if (!admin) return res.status(503).json({ error: "Database is not configured." });

  const media_id = req.params.id;
  const body = String(req.body?.body || req.body?.comment || "").trim();

  if (!isUuid(media_id)) return res.status(400).json({ error: "Invalid post ID." });
  if (!body || body.length > 2000) {
    return res.status(400).json({ error: "Comment must be between 1 and 2,000 characters." });
  }

  try {
    const { data, error } = await admin
      .from("surge_media_comments")
      .insert({ media_id, user_id, body, status: "visible" })
      .select("*")
      .single();

    if (error) throw error;
    return res.status(201).json({ ok: true, comment: data });
  } catch (error) {
    console.error("Create comment:", error);
    return res.status(503).json({ error: "Could not post comment." });
  }
});

app.post("/api/users/:id/follow", authActionLimiter, async (req, res) => {
  const follower_id = await getUserId(req);
  if (!follower_id) return res.status(401).json({ error: "Sign in required." });
  if (!admin) return res.status(503).json({ error: "Database is not configured." });

  const followed_id = req.params.id;
  if (!isUuid(followed_id) || followed_id === follower_id) {
    return res.status(400).json({ error: "Invalid follow target." });
  }

  try {
    const { data: existing, error: findError } = await admin
      .from("surge_follows")
      .select("follower_id")
      .eq("follower_id", follower_id)
      .eq("followed_id", followed_id)
      .maybeSingle();

    if (findError) throw findError;

    let following;
    if (existing) {
      const { error } = await admin.from("surge_follows")
        .delete().eq("follower_id", follower_id).eq("followed_id", followed_id);
      if (error) throw error;
      following = false;
    } else {
      const { error } = await admin.from("surge_follows")
        .insert({ follower_id, followed_id });
      if (error) throw error;
      following = true;
    }

    return res.json({ ok: true, following });
  } catch (error) {
    console.error("Follow toggle:", error);
    return res.status(503).json({ error: "Could not update follow." });
  }
});

app.post("/api/reports", authActionLimiter, async (req, res) => {
  const reporter_id = await getUserId(req);
  if (!reporter_id) return res.status(401).json({ error: "Sign in required." });
  if (!admin) return res.status(503).json({ error: "Database is not configured." });

  const media_id = req.body?.media_id || null;
  const reported_user_id = req.body?.reported_user_id || req.body?.user_id || null;
  const reason = String(req.body?.reason || "").toLowerCase();
  const detail = String(req.body?.detail || req.body?.description || "").slice(0, 2000);

  if (!["spam", "abuse", "copyright", "other"].includes(reason)) {
    return res.status(400).json({ error: "Choose a valid report reason." });
  }
  if (!media_id && !reported_user_id) {
    return res.status(400).json({ error: "A post or user must be selected." });
  }
  if (media_id && !isUuid(media_id)) return res.status(400).json({ error: "Invalid post ID." });
  if (reported_user_id && !isUuid(reported_user_id)) {
    return res.status(400).json({ error: "Invalid user ID." });
  }

  try {
    const { data, error } = await admin.from("surge_reports")
      .insert({ reporter_id, media_id, reported_user_id, reason, detail, status: "open" })
      .select("*").single();

    if (error) throw error;

    if (media_id) {
      const { data: reports } = await admin.from("surge_reports")
        .select("reporter_id")
        .eq("media_id", media_id);

      const distinctReporters = new Set((reports || []).map(row => row.reporter_id));
      if (distinctReporters.size >= 3) {
        await admin.from("surge_media")
          .update({ status: "hidden" })
          .eq("id", media_id);
      }
    }

    return res.status(201).json({ ok: true, report: data });
  } catch (error) {
    console.error("Create report:", error);
    return res.status(503).json({ error: "Could not submit report." });
  }
});

app.get("/api/moderation/reports", authActionLimiter, async (req, res) => {
  const user_id = await getUserId(req);
  if (!user_id) return res.status(401).json({ error: "Sign in required." });
  if (!MODERATOR_IDS.has(user_id)) {
    return res.status(MODERATOR_IDS.size ? 403 : 503).json({
      error: MODERATOR_IDS.size
        ? "Moderator access required."
        : "Moderation is not configured. Set SURGE_MODERATOR_IDS on the backend."
    });
  }
  if (!admin) return res.status(503).json({ error: "Database is not configured." });

  const status = String(req.query.status || "open").toLowerCase();
  if (!["open", "reviewing", "resolved", "dismissed", "all"].includes(status)) {
    return res.status(400).json({ error: "Invalid report status." });
  }

  try {
    let query = admin.from("surge_reports")
      .select("id,reporter_id,media_id,reported_user_id,reason,detail,status,created_at")
      .order("created_at", { ascending: true })
      .limit(100);

    if (status !== "all") query = query.eq("status", status);
    const { data, error } = await query;
    if (error) throw error;

    return res.json({ ok: true, reports: data || [] });
  } catch {
    return res.status(503).json({ error: "Moderation queue is not ready. Apply the latest migration." });
  }
});

app.post("/api/moderation/reports/:id/status", authActionLimiter, async (req, res) => {
  const user_id = await getUserId(req);
  if (!user_id) return res.status(401).json({ error: "Sign in required." });
  if (!MODERATOR_IDS.has(user_id)) return res.status(403).json({ error: "Moderator access required." });
  if (!admin) return res.status(503).json({ error: "Database is not configured." });

  const status = String(req.body?.status || "").toLowerCase();
  if (!["open", "reviewing", "resolved", "dismissed"].includes(status)) {
    return res.status(400).json({ error: "Invalid report status." });
  }

  try {
    const { data, error } = await admin.from("surge_reports")
      .update({ status })
      .eq("id", req.params.id)
      .select("*")
      .single();

    if (error) throw error;
    return res.json({ ok: true, report: data });
  } catch {
    return res.status(503).json({ error: "Could not update report." });
  }
});

app.post("/api/moderation/media/:id/status", authActionLimiter, async (req, res) => {
  const user_id = await getUserId(req);
  if (!user_id) return res.status(401).json({ error: "Sign in required." });
  if (!MODERATOR_IDS.has(user_id)) return res.status(403).json({ error: "Moderator access required." });
  if (!admin) return res.status(503).json({ error: "Database is not configured." });

  const status = String(req.body?.status || "").toLowerCase();
  if (!["published", "hidden", "removed"].includes(status)) {
    return res.status(400).json({ error: "Invalid media status." });
  }

  try {
    const { data, error } = await admin.from("surge_media")
      .update({ status })
      .eq("id", req.params.id)
      .select("*")
      .single();

    if (error) throw error;
    return res.json({ ok: true, media: data });
  } catch {
    return res.status(503).json({ error: "Could not update media status." });
  }
});
// Square is intentionally retained. Billing activation and payment-link
// behavior can be reconciled against the live Square account separately.
app.post("/api/square/checkout", authActionLimiter, async (req, res) => {
  const user_id = await getUserId(req);
  if (!user_id) return res.status(401).json({ error: "Sign in required." });

  const tier = normalizeTier(req.body?.tier || req.body?.plan);
  if (!["pro", "elite", "studio"].includes(tier)) {
    return res.status(400).json({ error: "Choose a valid membership tier." });
  }

  if (!square || !SQUARE_LOCATION_ID) {
    return res.status(503).json({ error: "Square billing is not configured yet." });
  }

  return res.status(503).json({
    error: "Square is connected, but checkout needs to be reconciled with the current membership setup before payments are enabled."
  });
});

app.post("/api/square/confirm", authActionLimiter, async (req, res) => {
  const user_id = await getUserId(req);
  if (!user_id) return res.status(401).json({ error: "Sign in required." });

  if (!square) {
    return res.status(503).json({ error: "Square billing is not configured yet." });
  }

  return res.status(503).json({
    error: "Payment confirmation is temporarily disabled while the Square membership flow is reconciled."
  });
});

app.post("/api/tier/starter", authActionLimiter, async (req, res) => {
  const user_id = await getUserId(req);
  if (!user_id) return res.status(401).json({ error: "Sign in required." });
  if (!admin) return res.status(503).json({ error: "Database is not configured." });

  try {
    const { data: profile, error: readError } = await admin
      .from("profiles")
      .select("membership_tier,tier")
      .eq("id", user_id)
      .maybeSingle();

    if (readError) throw readError;

    const currentTier = String(
      profile?.membership_tier || profile?.tier || "free"
    ).toLowerCase();

    if (["pro", "elite", "studio"].includes(currentTier)) {
      return res.status(409).json({
        error: "Your current membership cannot be changed through this endpoint."
      });
    }

    return res.json({ ok: true, tier: "free", message: "You are on the free tier." });
  } catch (error) {
    console.error("Starter tier:", error);
    return res.status(503).json({ error: "Could not verify your membership." });
  }
});

// Promotion redemption is retained; this is separate from Kinetic.
app.post("/api/promo/redeem", authActionLimiter, async (req, res) => {
  const user_id = await getUserId(req);
  if (!user_id) return res.status(401).json({ error: "Sign in required." });
  if (!admin) return res.status(503).json({ error: "Database is not configured." });

  const video_id = req.body?.video_id;
  const promo_id = req.body?.promo_id;
  const cost = Number(req.body?.cost);

  if (!isUuid(video_id) || !isUuid(promo_id)) {
    return res.status(400).json({ error: "A valid post and promotion are required." });
  }
  if (![100, 250, 500].includes(cost)) {
    return res.status(400).json({ error: "Invalid promotion cost." });
  }

  try {
    const { data, error } = await admin.rpc("surge_redeem_promo_secure", {
      p_user_id: user_id,
      p_video_id: video_id,
      p_promo_id: promo_id,
      p_cost: cost
    });

    if (error) throw error;
    return res.json({ ok: true, result: data });
  } catch (error) {
    console.error("Promo redemption:", error);
    return res.status(503).json({ error: "Promotion redemption is not ready. Check the promotion database setup." });
  }
});

app.post("/api/notify", async (req, res) => {
  // Notification delivery can be connected without blocking core app actions.
  return res.json({ ok: true, accepted: true });
});

app.use((req, res) => {
  return res.status(404).json({
    error: "Route not found.",
    path: req.path
  });
});

app.use((error, req, res, next) => {
  console.error("Unhandled API error:", error);

  if (res.headersSent) return next(error);

  return res.status(500).json({
    error: "An unexpected server error occurred."
  });
});

const PORT = Number(process.env.PORT) || 10000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`SURGE API running on port ${PORT}`);
  console.log(`Supabase: ${admin ? "configured" : "missing configuration"}`);
  console.log(`R2 uploads: ${r2 ? "configured" : "missing configuration"}`);
  console.log(`Square: ${square ? "configured" : "missing configuration"}`);
});
