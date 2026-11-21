
  if (!user_id) return res.status(401).json({ error: "Sign in before saving an upload." });
  if (!admin || !r2 || !R2_BUCKET || !R2_PUBLIC_URL) return res.status(503).json({ error: "Media storage/database is not configured on the backend." });
  const key = String(req.body?.key || "");
  const mode = String(req.body?.mode || "post").toLowerCase();
  const title = String(req.body?.title || "").trim().slice(0, 180);
  const description = String(req.body?.description || "").trim().slice(0, 2000);
  if (!key || key.length > 500 || !["post", "avatar"].includes(mode)) return res.status(400).json({ error: "Invalid upload details." });
  const prefix = mode === "avatar" ? `avatars/${user_id}/` : `surges/${user_id}/`;
  if (!key.startsWith(prefix) || key.includes("..") || key.includes("\\")) return res.status(403).json({ error: "Upload does not belong to this account." });
  try {
    const head = await r2.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: key }));
    const content_type = String(head.ContentType || "").toLowerCase();
    const size = Number(head.ContentLength || 0);
    const isImage = ["image/jpeg", "image/png", "image/webp"].includes(content_type);
    const isVideo = ["video/mp4", "video/webm", "video/quicktime"].includes(content_type);
    if (mode === "avatar" && !isImage) return res.status(400).json({ error: "Uploaded profile picture type is not allowed." });
    if (mode === "post" && !(isImage || isVideo)) return res.status(400).json({ error: "Uploaded media type is not allowed." });
    if (!size || size > (isImage ? (mode === "avatar" ? 8 : 12) : 100) * 1024 * 1024) return res.status(413).json({ error: "Uploaded file size is invalid." });
    const public_url = `${R2_PUBLIC_URL}/${key}`;
    if (mode === "avatar") {
      const { error } = await admin.from("profiles").upsert({ id: user_id, avatar_url: public_url }, { onConflict: "id" });
      if (error) return res.status(503).json({ error: "Photo uploaded but profile table is not ready. Apply the supplied migration." });
      return res.json({ ok: true, mode, public_url, key });
    }
    const { data, error } = await admin.from("surge_media").insert({
      user_id, object_key: key, public_url, media_type: isImage ? "photo" : "video",
      content_type, size_bytes: size, title: title || null, description: description || null, status: "published"
    }).select("id,user_id,object_key,public_url,media_type,title,description,created_at,status").single();
    if (error) return res.status(503).json({ error: "Media uploaded but the SURGE media table is not ready. Apply the supplied migration." });
    return res.json({ ok: true, mode, media: data });
  } catch (e) {
    if (e?.$metadata?.httpStatusCode === 404 || e?.name === "NotFound") return res.status(400).json({ error: "Upload was not found in storage. Try uploading again." });
    return res.status(500).json({ error: "Could not verify and save the uploaded media." });
  }
});

app.get("/api/me/profile", async (req, res) => {
  const user_id = await getUserId(req);
  if (!user_id) return res.status(401).json({ error: "Sign in required." });
  if (!admin) return res.status(503).json({ error: "Database is not configured." });
  try {
    const { data, error } = await admin.from("profiles").select("id,avatar_url").eq("id", user_id).maybeSingle();
    if (error) throw error;
    return res.json({ ok: true, profile: data || { id: user_id, avatar_url: null } });
  } catch { return res.status(503).json({ error: "Profile table is not ready. Apply the supplied migration and confirm the profile schema." }); }
});

app.get("/api/media", async (req, res) => {
  if (!admin) return res.status(503).json({ error: "Supabase is not configured on the backend." });
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
  try {
    const { data, error } = await admin.from("surge_media")
      .select("id,user_id,public_url,media_type,title,description,created_at,status")
      .eq("status", "published").order("created_at", { ascending: false }).limit(limit);
    if (error) throw error;
    const media = data || [];
    const userIds = [...new Set(media.map(item => item.user_id).filter(Boolean))];
    let authorMap = {};
    if (userIds.length) {
      // Keep the feed resilient to older profile schemas: avatar_url is the only
      // profile field this integration adds and depends on.
      const authors = await admin.from("profiles").select("id,avatar_url").in("id", userIds);
      if (!authors.error) authorMap = Object.fromEntries((authors.data || []).map(a => [a.id, { id: a.id, avatar_url: a.avatar_url || null }]));
    }
    res.json({ ok: true, media: media.map(item => ({ ...item, author: authorMap[item.user_id] || { id: item.user_id, avatar_url: null } })) });
  } catch { res.status(503).json({ error: "SURGE media feed is not ready. Apply the supplied migration." }); }
});

// Public creator card data. Only published content and aggregate counts are exposed.
app.get("/api/users/:id/profile", async (req, res) => {
  if (!admin) return res.status(503).json({ error: "Database is not configured." });
  const creator_id = String(req.params.id || "");
  if (!/^[0-9a-f-]{36}$/i.test(creator_id)) return res.status(400).json({ error: "Invalid creator id." });
  const viewer_id = await getUserId(req);
  try {
    const profileResult = await admin.from("profiles").select("id,avatar_url").eq("id", creator_id).maybeSingle();
    if (profileResult.error) throw profileResult.error;
    const [posts, followers, following, followState] = await Promise.all([
      admin.from("surge_media").select("id", { count: "exact", head: true }).eq("user_id", creator_id).eq("status", "published"),
      admin.from("surge_follows").select("follower_id", { count: "exact", head: true }).eq("followed_id", creator_id),
      admin.from("surge_follows").select("followed_id", { count: "exact", head: true }).eq("follower_id", creator_id),
      viewer_id && viewer_id !== creator_id
        ? admin.from("surge_follows").select("follower_id").eq("follower_id", viewer_id).eq("followed_id", creator_id).maybeSingle()
        : Promise.resolve({ data: null, error: null })
    ]);
    for (const result of [posts, followers, following, followState]) if (result.error) throw result.error;
    return res.json({ ok: true, profile: {
      id: creator_id,
      avatar_url: profileResult.data?.avatar_url || null,
      posts: posts.count || 0,
      followers: followers.count || 0,
      following: following.count || 0,
      is_following: !!followState.data,
      is_self: viewer_id === creator_id
    }});
  } catch { return res.status(503).json({ error: "Creator profile is not ready. Apply the latest migration and confirm the profile schema." }); }
});

// Persistent social actions for SURGE photo/video posts. All writes require a verified Supabase session.
app.post("/api/media/:id/like", authActionLimiter, async (req, res) => {
  const user_id = await getUserId(req);
  if (!user_id) return res.status(401).json({ error: "Sign in to like a SURGE." });
  if (!admin) return res.status(503).json({ error: "Database is not configured." });
  const media_id = String(req.params.id || "");
  if (!/^[0-9a-f-]{36}$/i.test(media_id)) return res.status(400).json({ error: "Invalid media id." });
  try {
    const existing = await admin.from("surge_media_likes").select("media_id").eq("media_id", media_id).eq("user_id", user_id).maybeSingle();
    if (existing.error) throw existing.error;
    if (existing.data) {
      const removed = await admin.from("surge_media_likes").delete().eq("media_id", media_id).eq("user_id", user_id);
      if (removed.error) throw removed.error;
    } else {
      const added = await admin.from("surge_media_likes").insert({ media_id, user_id });
      if (added.error) throw added.error;
    }
    const count = await admin.from("surge_media_likes").select("media_id", { count: "exact", head: true }).eq("media_id", media_id);
    if (count.error) throw count.error;
    return res.json({ ok: true, liked: !existing.data, count: count.count || 0 });
  } catch { return res.status(503).json({ error: "Likes are not ready. Apply the latest migration." }); }
});

app.get("/api/media/:id/comments", async (req, res) => {
  if (!admin) return res.status(503).json({ error: "Database is not configured." });
  const media_id = String(req.params.id || "");
  if (!/^[0-9a-f-]{36}$/i.test(media_id)) return res.status(400).json({ error: "Invalid media id." });
  try {
    const { data, error } = await admin.from("surge_media_comments").select("id,media_id,user_id,body,created_at").eq("media_id", media_id).eq("status", "visible").order("created_at", { ascending: true }).limit(100);
    if (error) throw error;
    return res.json({ ok: true, comments: data || [] });
  } catch { return res.status(503).json({ error: "Comments are not ready. Apply the latest migration." }); }
});

app.post("/api/media/:id/comments", authActionLimiter, async (req, res) => {
  const user_id = await getUserId(req);
  if (!user_id) return res.status(401).json({ error: "Sign in to comment." });
  if (!admin) return res.status(503).json({ error: "Database is not configured." });
  const media_id = String(req.params.id || "");
  const body = String(req.body?.body || "").trim();
  if (!/^[0-9a-f-]{36}$/i.test(media_id)) return res.status(400).json({ error: "Invalid media id." });
  if (!body || body.length > 1000) return res.status(400).json({ error: "Comment must be 1–1000 characters." });
  try {
    const { data, error } = await admin.from("surge_media_comments").insert({ media_id, user_id, body }).select("id,media_id,user_id,body,created_at").single();
    if (error) throw error;
    return res.status(201).json({ ok: true, comment: data });
  } catch { return res.status(503).json({ error: "Comments are not ready. Apply the latest migration." }); }
});

app.post("/api/users/:id/follow", authActionLimiter, async (req, res) => {
  const user_id = await getUserId(req);
  if (!user_id) return res.status(401).json({ error: "Sign in to follow creators." });
  if (!admin) return res.status(503).json({ error: "Database is not configured." });
  const target_id = String(req.params.id || "");
  if (!/^[0-9a-f-]{36}$/i.test(target_id) || target_id === user_id) return res.status(400).json({ error: "Invalid creator." });
  try {
    const existing = await admin.from("surge_follows").select("follower_id").eq("follower_id", user_id).eq("followed_id", target_id).maybeSingle();
    if (existing.error) throw existing.error;
    if (existing.data) {
      const { error } = await admin.from("surge_follows").delete().eq("follower_id", user_id).eq("followed_id", target_id);
      if (error) throw error;
    } else {
      const { error } = await admin.from("surge_follows").insert({ follower_id: user_id, followed_id: target_id });
      if (error) throw error;
    }
    return res.json({ ok: true, following: !existing.data });
  } catch { return res.status(503).json({ error: "Follows are not ready. Apply the latest migration." }); }
});

// Moderator-only queue and status controls. Configure exact Supabase auth user UUIDs
// in SURGE_MODERATOR_IDS; an empty list disables these endpoints by design.
app.get("/api/moderation/reports", authActionLimiter, async (req, res) => {
  const user_id = await getUserId(req);
  if (!user_id) return res.status(401).json({ error: "Sign in required." });
  if (!MODERATOR_IDS.has(user_id)) return res.status(MODERATOR_IDS.size ? 403 : 503).json({ error: MODERATOR_IDS.size ? "Moderator access required." : "Moderation is not configured. Set SURGE_MODERATOR_IDS on the backend." });
  if (!admin) return res.status(503).json({ error: "Database is not configured." });
  const status = String(req.query.status || "open").toLowerCase();
  if (!["open", "reviewing", "resolved", "dismissed", "all"].includes(status)) return res.status(400).json({ error: "Invalid report status filter." });
  try {
    let query = admin.from("surge_reports").select("id,reporter_id,media_id,reported_user_id,reason,detail,status,created_at").order("created_at", { ascending: true }).limit(100);
    if (status !== "all") query = query.eq("status", status);
    const { data, error } = await query;
    if (error) throw error;
    return res.json({ ok: true, reports: data || [] });
  } catch { return res.status(503).json({ error: "Moderation queue is not ready. Apply the latest migration." }); }
});

app.post("/api/moderation/reports/:id/status", authActionLimiter, async (req, res) => {
  const user_id = await getUserId(req);
  if (!user_id) return res.status(401).json({ error: "Sign in required." });
  if (!MODERATOR_IDS.has(user_id)) return res.status(MODERATOR_IDS.size ? 403 : 503).json({ error: MODERATOR_IDS.size ? "Moderator access required." : "Moderation is not configured. Set SURGE_MODERATOR_IDS on the backend." });
  if (!admin) return res.status(503).json({ error: "Database is not configured." });
  const report_id = String(req.params.id || "");
  const status = String(req.body?.status || "").toLowerCase();
  if (!/^[0-9a-f-]{36}$/i.test(report_id) || !["reviewing", "resolved", "dismissed"].includes(status)) return res.status(400).json({ error: "Invalid report or moderation status." });
  try {
    const { data, error } = await admin.from("surge_reports").update({ status }).eq("id", report_id).select("id,status").maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: "Report not found." });
    return res.json({ ok: true, report: data });
  } catch { return res.status(503).json({ error: "Could not update the report status." }); }
});

app.post("/api/moderation/media/:id/status", authActionLimiter, async (req, res) => {
  const user_id = await getUserId(req);
  if (!user_id) return res.status(401).json({ error: "Sign in required." });
  if (!MODERATOR_IDS.has(user_id)) return res.status(MODERATOR_IDS.size ? 403 : 503).json({ error: MODERATOR_IDS.size ? "Moderator access required." : "Moderation is not configured. Set SURGE_MODERATOR_IDS on the backend." });
  if (!admin) return res.status(503).json({ error: "Database is not configured." });
  const media_id = String(req.params.id || "");
  const status = String(req.body?.status || "").toLowerCase();
  if (!/^[0-9a-f-]{36}$/i.test(media_id) || !["published", "hidden", "removed"].includes(status)) return res.status(400).json({ error: "Invalid media or moderation status." });
  try {
    const { data, error } = await admin.from("surge_media").update({ status }).eq("id", media_id).select("id,status").maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: "Media not found." });
    return res.json({ ok: true, media: data });
  } catch { return res.status(503).json({ error: "Could not update the media status." }); }
});

app.post("/api/reports", authActionLimiter, async (req, res) => {
  const user_id = await getUserId(req);
  if (!user_id) return res.status(401).json({ error: "Sign in to submit a report." });

  if (!user_id) return res.status(401).json({ error: "Sign in before saving an upload." });
  if (!admin || !r2 || !R2_BUCKET || !R2_PUBLIC_URL) return res.status(503).json({ error: "Media storage/database is not configured on the backend." });
  const key = String(req.body?.key || "");
  const mode = String(req.body?.mode || "post").toLowerCase();
  const title = String(req.body?.title || "").trim().slice(0, 180);
  const description = String(req.body?.description || "").trim().slice(0, 2000);
  if (!key || key.length > 500 || !["post", "avatar"].includes(mode)) return res.status(400).json({ error: "Invalid upload details." });
  const prefix = mode === "avatar" ? `avatars/${user_id}/` : `surges/${user_id}/`;
  if (!key.startsWith(prefix) || key.includes("..") || key.includes("\\")) return res.status(403).json({ error: "Upload does not belong to this account." });
  try {
    const head = await r2.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: key }));
    const content_type = String(head.ContentType || "").toLowerCase();
    const size = Number(head.ContentLength || 0);
    const isImage = ["image/jpeg", "image/png", "image/webp"].includes(content_type);
    const isVideo = ["video/mp4", "video/webm", "video/quicktime"].includes(content_type);
    if (mode === "avatar" && !isImage) return res.status(400).json({ error: "Uploaded profile picture type is not allowed." });
    if (mode === "post" && !(isImage || isVideo)) return res.status(400).json({ error: "Uploaded media type is not allowed." });
    if (!size || size > (isImage ? (mode === "avatar" ? 8 : 12) : 100) * 1024 * 1024) return res.status(413).json({ error: "Uploaded file size is invalid." });
    const public_url = `${R2_PUBLIC_URL}/${key}`;
    if (mode === "avatar") {
      const { error } = await admin.from("profiles").upsert({ id: user_id, avatar_url: public_url }, { onConflict: "id" });
      if (error) return res.status(503).json({ error: "Photo uploaded but profile table is not ready. Apply the supplied migration." });
      return res.json({ ok: true, mode, public_url, key });
    }
    const { data, error } = await admin.from("surge_media").insert({
      user_id, object_key: key, public_url, media_type: isImage ? "photo" : "video",
      content_type, size_bytes: size, title: title || null, description: description || null, status: "published"
    }).select("id,user_id,object_key,public_url,media_type,title,description,created_at,status").single();
    if (error) return res.status(503).json({ error: "Media uploaded but the SURGE media table is not ready. Apply the supplied migration." });
    return res.json({ ok: true, mode, media: data });
  } catch (e) {
    if (e?.$metadata?.httpStatusCode === 404 || e?.name === "NotFound") return res.status(400).json({ error: "Upload was not found in storage. Try uploading again." });
    return res.status(500).json({ error: "Could not verify and save the uploaded media." });
  }
});

app.get("/api/me/profile", async (req, res) => {
  const user_id = await getUserId(req);
  if (!user_id) return res.status(401).json({ error: "Sign in required." });
  if (!admin) return res.status(503).json({ error: "Database is not configured." });
  try {
    const { data, error } = await admin.from("profiles").select("id,avatar_url").eq("id", user_id).maybeSingle();
    if (error) throw error;
    return res.json({ ok: true, profile: data || { id: user_id, avatar_url: null } });
  } catch { return res.status(503).json({ error: "Profile table is not ready. Apply the supplied migration and confirm the profile schema." }); }
});

app.get("/api/media", async (req, res) => {
  if (!admin) return res.status(503).json({ error: "Supabase is not configured on the backend." });
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
  try {
    const { data, error } = await admin.from("surge_media")
      .select("id,user_id,public_url,media_type,title,description,created_at,status")
      .eq("status", "published").order("created_at", { ascending: false }).limit(limit);
    if (error) throw error;
    const media = data || [];
    const userIds = [...new Set(media.map(item => item.user_id).filter(Boolean))];
    let authorMap = {};
    if (userIds.length) {
      // Keep the feed resilient to older profile schemas: avatar_url is the only
      // profile field this integration adds and depends on.
      const authors = await admin.from("profiles").select("id,avatar_url").in("id", userIds);
      if (!authors.error) authorMap = Object.fromEntries((authors.data || []).map(a => [a.id, { id: a.id, avatar_url: a.avatar_url || null }]));
    }
    res.json({ ok: true, media: media.map(item => ({ ...item, author: authorMap[item.user_id] || { id: item.user_id, avatar_url: null } })) });
  } catch { res.status(503).json({ error: "SURGE media feed is not ready. Apply the supplied migration." }); }
});

// Public creator card data. Only published content and aggregate counts are exposed.
app.get("/api/users/:id/profile", async (req, res) => {
  if (!admin) return res.status(503).json({ error: "Database is not configured." });
  const creator_id = String(req.params.id || "");
  if (!/^[0-9a-f-]{36}$/i.test(creator_id)) return res.status(400).json({ error: "Invalid creator id." });
  const viewer_id = await getUserId(req);
  try {
    const profileResult = await admin.from("profiles").select("id,avatar_url").eq("id", creator_id).maybeSingle();
    if (profileResult.error) throw profileResult.error;
    const [posts, followers, following, followState] = await Promise.all([
      admin.from("surge_media").select("id", { count: "exact", head: true }).eq("user_id", creator_id).eq("status", "published"),
      admin.from("surge_follows").select("follower_id", { count: "exact", head: true }).eq("followed_id", creator_id),
      admin.from("surge_follows").select("followed_id", { count: "exact", head: true }).eq("follower_id", creator_id),
      viewer_id && viewer_id !== creator_id
        ? admin.from("surge_follows").select("follower_id").eq("follower_id", viewer_id).eq("followed_id", creator_id).maybeSingle()
        : Promise.resolve({ data: null, error: null })
    ]);
    for (const result of [posts, followers, following, followState]) if (result.error) throw result.error;
    return res.json({ ok: true, profile: {
      id: creator_id,
      avatar_url: profileResult.data?.avatar_url || null,
      posts: posts.count || 0,
      followers: followers.count || 0,
      following: following.count || 0,
      is_following: !!followState.data,
      is_self: viewer_id === creator_id
    }});
  } catch { return res.status(503).json({ error: "Creator profile is not ready. Apply the latest migration and confirm the profile schema." }); }
});

// Persistent social actions for SURGE photo/video posts. All writes require a verified Supabase session.
app.post("/api/media/:id/like", authActionLimiter, async (req, res) => {
  const user_id = await getUserId(req);
  if (!user_id) return res.status(401).json({ error: "Sign in to like a SURGE." });
  if (!admin) return res.status(503).json({ error: "Database is not configured." });
  const media_id = String(req.params.id || "");
  if (!/^[0-9a-f-]{36}$/i.test(media_id)) return res.status(400).json({ error: "Invalid media id." });
  try {
    const existing = await admin.from("surge_media_likes").select("media_id").eq("media_id", media_id).eq("user_id", user_id).maybeSingle();
    if (existing.error) throw existing.error;
    if (existing.data) {
      const removed = await admin.from("surge_media_likes").delete().eq("media_id", media_id).eq("user_id", user_id);
      if (removed.error) throw removed.error;
    } else {
      const added = await admin.from("surge_media_likes").insert({ media_id, user_id });
      if (added.error) throw added.error;
    }
    const count = await admin.from("surge_media_likes").select("media_id", { count: "exact", head: true }).eq("media_id", media_id);
    if (count.error) throw count.error;
    return res.json({ ok: true, liked: !existing.data, count: count.count || 0 });
  } catch { return res.status(503).json({ error: "Likes are not ready. Apply the latest migration." }); }
});

app.get("/api/media/:id/comments", async (req, res) => {
  if (!admin) return res.status(503).json({ error: "Database is not configured." });
  const media_id = String(req.params.id || "");
  if (!/^[0-9a-f-]{36}$/i.test(media_id)) return res.status(400).json({ error: "Invalid media id." });
  try {
    const { data, error } = await admin.from("surge_media_comments").select("id,media_id,user_id,body,created_at").eq("media_id", media_id).eq("status", "visible").order("created_at", { ascending: true }).limit(100);
    if (error) throw error;
    return res.json({ ok: true, comments: data || [] });
  } catch { return res.status(503).json({ error: "Comments are not ready. Apply the latest migration." }); }
});

app.post("/api/media/:id/comments", authActionLimiter, async (req, res) => {
  const user_id = await getUserId(req);
  if (!user_id) return res.status(401).json({ error: "Sign in to comment." });
  if (!admin) return res.status(503).json({ error: "Database is not configured." });
  const media_id = String(req.params.id || "");
  const body = String(req.body?.body || "").trim();
  if (!/^[0-9a-f-]{36}$/i.test(media_id)) return res.status(400).json({ error: "Invalid media id." });
  if (!body || body.length > 1000) return res.status(400).json({ error: "Comment must be 1–1000 characters." });
  try {
    const { data, error } = await admin.from("surge_media_comments").insert({ media_id, user_id, body }).select("id,media_id,user_id,body,created_at").single();
    if (error) throw error;
    return res.status(201).json({ ok: true, comment: data });
  } catch { return res.status(503).json({ error: "Comments are not ready. Apply the latest migration." }); }
});

app.post("/api/users/:id/follow", authActionLimiter, async (req, res) => {
  const user_id = await getUserId(req);
  if (!user_id) return res.status(401).json({ error: "Sign in to follow creators." });
  if (!admin) return res.status(503).json({ error: "Database is not configured." });
  const target_id = String(req.params.id || "");
  if (!/^[0-9a-f-]{36}$/i.test(target_id) || target_id === user_id) return res.status(400).json({ error: "Invalid creator." });
  try {
    const existing = await admin.from("surge_follows").select("follower_id").eq("follower_id", user_id).eq("followed_id", target_id).maybeSingle();
    if (existing.error) throw existing.error;
    if (existing.data) {
      const { error } = await admin.from("surge_follows").delete().eq("follower_id", user_id).eq("followed_id", target_id);
      if (error) throw error;
    } else {
      const { error } = await admin.from("surge_follows").insert({ follower_id: user_id, followed_id: target_id });
      if (error) throw error;
    }
    return res.json({ ok: true, following: !existing.data });
  } catch { return res.status(503).json({ error: "Follows are not ready. Apply the latest migration." }); }
});

// Moderator-only queue and status controls. Configure exact Supabase auth user UUIDs
// in SURGE_MODERATOR_IDS; an empty list disables these endpoints by design.
app.get("/api/moderation/reports", authActionLimiter, async (req, res) => {
  const user_id = await getUserId(req);
  if (!user_id) return res.status(401).json({ error: "Sign in required." });
  if (!MODERATOR_IDS.has(user_id)) return res.status(MODERATOR_IDS.size ? 403 : 503).json({ error: MODERATOR_IDS.size ? "Moderator access required." : "Moderation is not configured. Set SURGE_MODERATOR_IDS on the backend." });
  if (!admin) return res.status(503).json({ error: "Database is not configured." });
  const status = String(req.query.status || "open").toLowerCase();
  if (!["open", "reviewing", "resolved", "dismissed", "all"].includes(status)) return res.status(400).json({ error: "Invalid report status filter." });
  try {
    let query = admin.from("surge_reports").select("id,reporter_id,media_id,reported_user_id,reason,detail,status,created_at").order("created_at", { ascending: true }).limit(100);
    if (status !== "all") query = query.eq("status", status);
    const { data, error } = await query;
    if (error) throw error;
    return res.json({ ok: true, reports: data || [] });
  } catch { return res.status(503).json({ error: "Moderation queue is not ready. Apply the latest migration." }); }
});

app.post("/api/moderation/reports/:id/status", authActionLimiter, async (req, res) => {
  const user_id = await getUserId(req);
  if (!user_id) return res.status(401).json({ error: "Sign in required." });
  if (!MODERATOR_IDS.has(user_id)) return res.status(MODERATOR_IDS.size ? 403 : 503).json({ error: MODERATOR_IDS.size ? "Moderator access required." : "Moderation is not configured. Set SURGE_MODERATOR_IDS on the backend." });
  if (!admin) return res.status(503).json({ error: "Database is not configured." });
  const report_id = String(req.params.id || "");
  const status = String(req.body?.status || "").toLowerCase();
  if (!/^[0-9a-f-]{36}$/i.test(report_id) || !["reviewing", "resolved", "dismissed"].includes(status)) return res.status(400).json({ error: "Invalid report or moderation status." });
  try {
    const { data, error } = await admin.from("surge_reports").update({ status }).eq("id", report_id).select("id,status").maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: "Report not found." });
    return res.json({ ok: true, report: data });
  } catch { return res.status(503).json({ error: "Could not update the report status." }); }
});

app.post("/api/moderation/media/:id/status", authActionLimiter, async (req, res) => {
  const user_id = await getUserId(req);
  if (!user_id) return res.status(401).json({ error: "Sign in required." });
  if (!MODERATOR_IDS.has(user_id)) return res.status(MODERATOR_IDS.size ? 403 : 503).json({ error: MODERATOR_IDS.size ? "Moderator access required." : "Moderation is not configured. Set SURGE_MODERATOR_IDS on the backend." });
  if (!admin) return res.status(503).json({ error: "Database is not configured." });
  const media_id = String(req.params.id || "");
  const status = String(req.body?.status || "").toLowerCase();
  if (!/^[0-9a-f-]{36}$/i.test(media_id) || !["published", "hidden", "removed"].includes(status)) return res.status(400).json({ error: "Invalid media or moderation status." });
  try {
    const { data, error } = await admin.from("surge_media").update({ status }).eq("id", media_id).select("id,status").maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: "Media not found." });
    return res.json({ ok: true, media: data });
  } catch { return res.status(503).json({ error: "Could not update the media status." }); }
});

app.post("/api/reports", authActionLimiter, async (req, res) => {
  const user_id = await getUserId(req);
  if (!user_id) return res.status(401).json({ error: "Sign in to submit a report." });

  if (!admin) return res.status(503).json({ error: "Database is not configured." });
  const media_id = req.body?.media_id ? String(req.body.media_id) : null;
  const reported_user_id = req.body?.reported_user_id ? String(req.body.reported_user_id) : null;
  const reason = String(req.body?.reason || "").toLowerCase();
  const detail = String(req.body?.detail || "").trim().slice(0, 2000);
  if (!(["spam", "abuse", "copyright", "other"].includes(reason)) || (!media_id && !reported_user_id)) return res.status(400).json({ error: "Choose a report reason and target." });
  if (media_id && !/^[0-9a-f-]{36}$/i.test(media_id)) return res.status(400).json({ error: "Invalid media id." });
  if (reported_user_id && !/^[0-9a-f-]{36}$/i.test(reported_user_id)) return res.status(400).json({ error: "Invalid creator id." });
  try {
    if (media_id) {
      const { data: prior, error: priorError } = await admin.from("surge_reports").select("id").eq("media_id", media_id).eq("reporter_id", user_id).maybeSingle();
      if (priorError) throw priorError;
      if (prior) return res.status(409).json({ error: "You have already reported this post." });
    }
    const { error } = await admin.from("surge_reports").insert({ reporter_id: user_id, media_id, reported_user_id, reason, detail: detail || null, status: "open" });
    if (error) throw error;
    let hidden = false;
    if (media_id) {
      const { data: reports, error: countError } = await admin.from("surge_reports").select("reporter_id").eq("media_id", media_id).neq("status", "dismissed");
      if (countError) throw countError;
      const uniqueReporters = new Set((reports || []).map(row => row.reporter_id));
      if (uniqueReporters.size >= 3) {
        const { error: hideError } = await admin.from("surge_media").update({ status: "hidden" }).eq("id", media_id).eq("status", "published");
        if (hideError) throw hideError;
        hidden = true;
      }
    }
    return res.status(201).json({ ok: true, temporarily_hidden_for_review: hidden });
  } catch { return res.status(503).json({ error: "Reports are not ready. Apply the latest migration." }); }
});

// BILLING SAFETY STOP: the current Square API implementation creates one-time payment links,
// while SURGE's pricing UI promises monthly subscriptions. Do not activate paid tiers through
// that mismatch. Replace these guards only after recurring plans, webhook verification,
// cancellations/refunds, and idempotent membership reconciliation are implemented and tested.
app.post("/api/square/checkout", authActionLimiter, async (req, res) => {
  return res.status(503).json({
    error: "Paid membership checkout is temporarily unavailable while recurring billing is verified.",
    code: "SURGE_BILLING_NOT_READY"
  });
  const user_id = await getUserId(req);
  if (!user_id) return res.status(401).json({ error: "sign in required" });
  const tier = String(req.body?.tier || "").toLowerCase();
  if (!Object.hasOwn(PRICES, tier)) return res.status(400).json({ error: "bad tier" });
  if (!SQUARE_TOKEN || !SQUARE_LOCATION) return res.status(500).json({ error: "Square not configured on backend" });
  try {
    const client = await squareClient();
    const ref = `surge-${user_id}-${tier}-${randomUUID()}`;
    const redirectUrl = new URL("/", FRONTEND_URL);
    redirectUrl.searchParams.set("paid", "1");
    redirectUrl.searchParams.set("tier", tier);
    redirectUrl.hash = "pricing";
    const r = await client.checkoutApi.createPaymentLink({
      idempotencyKey: randomUUID(),
      order: { locationId: SQUARE_LOCATION, referenceId: ref, lineItems: [{ name: `SURGE ${tier.toUpperCase()} - One-time`, quantity: "1", basePriceMoney: { amount: BigInt(PRICES[tier]), currency: "USD" } }] },
      checkoutOptions: { redirectUrl: redirectUrl.toString(), askForShippingAddress: false }
    });
    const link = r?.result?.paymentLink;
    if (!link?.url || !link?.orderId) return res.status(502).json({ error: "Square did not return a valid checkout link" });
    res.json({ checkoutUrl: link.url, orderId: link.orderId, ref });
  } catch (e) { res.status(502).json({ error: e.message || "Square checkout failed" }); }
});

app.post("/api/square/confirm", authActionLimiter, async (req, res) => {
  return res.status(503).json({
    error: "Paid membership activation is paused until recurring subscription reconciliation is verified.",
    code: "SURGE_BILLING_NOT_READY"
  });
  const user_id = await getUserId(req);
  if (!user_id) return res.status(401).json({ error: "sign in required" });
  const order_id = String(req.body?.order_id || "");
  const ref = String(req.body?.ref || "");
  const tier = String(req.body?.tier || "").toLowerCase();
  if (!order_id || order_id.length > 200 || !Object.hasOwn(PRICES, tier)) return res.status(400).json({ error: "Invalid order details" });
  if (!admin) return res.status(500).json({ error: "Supabase not configured" });
  if (!SQUARE_TOKEN) return res.status(500).json({ error: "Square not configured" });
  const refPrefix = `surge-${user_id}-${tier}-`;
  if (!ref.startsWith(refPrefix) || ref.length > 300) return res.status(403).json({ error: "Order reference mismatch" });
  try {
    const client = await squareClient();
    const result = await client.ordersApi.retrieveOrder(order_id);
    const order = result?.result?.order;
    if (!order) return res.status(404).json({ error: "Square order not found" });
    if (String(order.referenceId || "") !== ref) return res.status(403).json({ error: "Order mismatch" });
    if (order.locationId && String(order.locationId) !== String(SQUARE_LOCATION)) return res.status(403).json({ error: "Square location mismatch" });
    const total = Number(order.totalMoney?.amount ?? NaN);
    const currency = String(order.totalMoney?.currency || "").toUpperCase();
    if (!Number.isFinite(total) || total !== PRICES[tier] || currency !== "USD") return res.status(402).json({ error: "Order amount or currency mismatch" });
    const tenders = order.tenders || [];
    const paidCents = tenders.reduce((sum, t) => {
      const status = String(t.status || "").toUpperCase();
      const cardStatus = String(t.cardDetails?.status || "").toUpperCase();
      // Authorization alone is not proof of a captured payment.
      if (status === "CAPTURED" || status === "COMPLETED" || cardStatus === "CAPTURED") return sum + Number(t.amountMoney?.amount || 0);
      return sum;
    }, 0);
    if (paidCents < PRICES[tier]) return res.status(402).json({ error: "Payment not completed or captured" });

    // Use the existing database activation function: it atomically records the order
    // and grants a 30-day membership. Do not write billing_events/profile fields separately.
    const paidAt = new Date().toISOString();
    const { data: activation, error: activationError } = await admin.rpc("activate_membership_secure", {
      p_user_id: user_id,
      p_tier: TIER_DB[tier],
      p_order_id: order_id,
      p_paid_at: paidAt
    });
    if (activationError) {
      if (String(activationError.message || "").includes("function") && String(activationError.message || "").includes("does not exist")) {
        return res.status(503).json({ error: "Membership activation function is missing. Verify the existing Supabase schema before deploying." });
      }
      throw activationError;
    }
    if (!activation || activation.ok !== true) {
      return res.status(409).json({ error: activation?.error || "Membership activation was not confirmed" });
    }
    // The SQL function returns duplicate=true when this Square order was already recorded.
    // Confirm that the existing record belongs to this exact user and purchase before success.
    if (activation.duplicate === true) {
      const existing = await admin.from("billing_events")
        .select("user_id,tier,amount_cents,currency,status")
        .eq("square_order_id", order_id).maybeSingle();
      if (existing.error || !existing.data || existing.data.user_id !== user_id ||
          String(existing.data.tier).toUpperCase() !== TIER_DB[tier] ||
          Number(existing.data.amount_cents) !== PRICES[tier] ||
          String(existing.data.currency).toUpperCase() !== "USD" ||
          !["completed", "paid"].includes(String(existing.data.status).toLowerCase())) {
        return res.status(409).json({ error: "Order was already recorded for different details" });
      }
    }
    res.json({ ok: true, tier, subscription_end: activation.subscription_end || null, duplicate: activation.duplicate === true });
  } catch (e) { res.status(500).json({ error: e.message || "Payment confirmation failed" }); }
});

app.post("/api/tier/starter", authActionLimiter, async (req, res) => {
  const user_id = await getUserId(req);
  if (!user_id) return res.status(401).json({ error: "sign in required" });
  if (!admin) return res.status(500).json({ error: "Supabase not configured" });
  try {
    // Starter downgrade is deliberately not permitted through this public endpoint.
    const p = await getProfile(user_id);
    if (normalizeTier(p) !== "starter") return res.status(403).json({ error: "Contact support to change a paid membership" });
    res.json({ ok: true, tier: "starter" });
  } catch (e) { res.status(500).json({ error: e.message || "Unable to verify membership" }); }
});

app.post("/api/kinetic/claim", authActionLimiter, async (req, res) => {
  const user_id = await getUserId(req);
  if (!user_id) return res.status(401).json({ error: "sign in required" });
  const video_id = req.body?.video_id;
  if ((!Number.isInteger(video_id) && typeof video_id !== "string") || String(video_id).length > 200) return res.status(400).json({ error: "Invalid video id" });
  if (!admin) return res.status(500).json({ error: "Supabase not configured" });
  try {
    const p = await getProfile(user_id);
    if (!p) return res.status(404).json({ error: "Profile not found" });
    const tier = normalizeTier(p);
    const limit = TIER_DAILY[tier] || 5;
    const { data, error } = await admin.rpc("surge_claim_kinetic_secure", {
      p_user_id: user_id, p_video_id: String(video_id), p_daily_limit: limit, p_points: 10
    });
    if (error) {
      const msg = String(error.message || "");
      if (msg.includes("Already claimed") || String(error.code) === "23505") return res.status(409).json({ error: "Already claimed" });
      if (msg.includes("Daily limit reached")) return res.status(429).json({ error: msg });
      if (msg.includes("Drop not available")) return res.status(404).json({ error: "Drop not available" });
      if (msg.includes("function") && msg.includes("does not exist")) return res.status(503).json({ error: "Secure Kinetic claim migration is not installed. Apply migration.sql first." });
      throw error;
    }
    res.json(data || { ok: true });
  } catch (e) { res.status(500).json({ error: e.message || "Claim failed" }); }
});

app.post("/api/promo/redeem", authActionLimiter, async (req, res) => {
  const user_id = await getUserId(req);
  if (!user_id) return res.status(401).json({ error: "sign in required" });
  const video_id = req.body?.video_id;
  const promo_id = String(req.body?.promo_id || "");
  if ((!Number.isInteger(video_id) && typeof video_id !== "string") || String(video_id).length > 200) return res.status(400).json({ error: "Invalid video id" });
  const COSTS = Object.freeze({ boost: 100, feature: 250, review: 500 });
  const cost = COSTS[promo_id];
  if (!cost) return res.status(400).json({ error: "bad promo" });
  if (!admin) return res.status(500).json({ error: "Supabase not configured" });
  try {
    const v = await admin.from("videos").select("id,user_id,status").eq("id", video_id).maybeSingle();
    if (v.error) throw v.error;
    if (!v.data || v.data.user_id !== user_id) return res.status(403).json({ error: "not your campaign" });
    if (v.data.status !== "approved") return res.status(400).json({ error: "campaign not approved" });
    // Atomic spend + promotion creation requires the supplied SQL RPC migration. Do not use a
    // read-then-update balance check here, which can double-spend points under concurrent requests.
    const { data, error } = await admin.rpc("surge_redeem_promo_secure", { p_user_id: user_id, p_video_id: video_id, p_promo_id: promo_id, p_cost: cost });
    if (error) return res.status(503).json({ error: "Secure promotion redemption is not installed. Apply migration.sql first." });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message || "Promotion redemption failed" }); }
});

app.post("/api/notify", async (req, res) => {
  const user_id = await getUserId(req);
  if (!user_id) return res.status(401).json({ error: "sign in required" });
  res.json({ ok: true });
});
app.use((req, res) => res.status(404).json({ error: "Not found" }));
app.use((err, req, res, next) => { console.error("Unhandled request error:", err?.message || err); if (res.headersSent) return next(err); res.status(500).json({ error: "Internal server error" }); });

const PORT = Number(process.env.PORT || 3001);
app.listen(PORT, () => console.log(`SURGE hardened backend listening on ${PORT}`));
