
FEEDSURGE PASSWORDLESS AUTHENTICATION
INSTALLATION INSTRUCTIONS

IMPORTANT:
Do not delete your existing JavaScript files.
Do not delete server.js.
Do not delete your existing login code yet.
Do not delete any Supabase tables or user records.

1. BACKEND

Place feedsurge-passwordless-auth.js
in the same backend folder as server.js.

In server.js, after express.json(),
add:

app.use(require("./feedsurge-passwordless-auth"));

2. FRONTEND

Place feedsurge-auth-client.js
in the frontend's public folder.

Before loading the authentication client,
configure:

window.FEEDSURGE_AUTH_CONFIG = {
  supabaseUrl: "YOUR_SUPABASE_PROJECT_URL",
  publishableKey: "YOUR_SUPABASE_PUBLISHABLE_KEY",
  apiBaseUrl: "https://feedsurge-api-dev.onrender.com"
};

Load the client:

<script type="module"
src="/feedsurge-auth-client.js"></script>

3. SUPABASE

Enable email OTP authentication.

Configure Google and Apple OAuth
before enabling those login buttons.

Configure your frontend URL under
Authentication > URL Configuration.

4. EXISTING ACCOUNTS

Keep existing Supabase accounts,
profiles, posts, and media.

Test existing account login before
disabling the old password method.

5. RENDER

Deploy the backend and frontend
after integrating the new login handlers.

Do not remove the old login until
the replacement has been tested.
