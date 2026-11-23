
(() => {
  "use strict";

  const TOKEN_KEY = "surge_access_token";
  const REFRESH_KEY = "surge_refresh_token";
  const USER_KEY = "surge_profile";

  let supabase = null;
  let busy = false;
  let mode = "login";

  const style = document.createElement("style");

  style.textContent = `
    #surge-auth-overlay {
      position: fixed;
      inset: 0;
      z-index: 999999;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
      background: rgba(0,0,0,.94);
      font-family: Arial,sans-serif;
    }

    #surge-auth-panel {
      width: 100%;
      max-width: 430px;
      max-height: 92vh;
      overflow: auto;
      box-sizing: border-box;
      padding: 26px;
      background: #101014;
      color: white;
      border: 1px solid #333;
      border-radius: 18px;
      box-shadow: 0 0 34px #00e5ff24;
    }

    #surge-auth-panel h2 {
      margin: 0 0 8px;
      color: #00e5ff;
      letter-spacing: 2px;
    }

    #surge-auth-panel p {
      color: #aaa;
      line-height: 1.5;
    }

    #surge-auth-panel input,
    #surge-auth-panel select {
      display: block;
      width: 100%;
      box-sizing: border-box;
      margin: 11px 0;
      padding: 14px;
      border-radius: 9px;
      border: 1px solid #444;
      background: #08090d;
      color: white;
      font-size: 16px;
    }

    #surge-auth-panel button {
      width: 100%;
      padding: 14px;
      margin-top: 10px;
      border: 0;
      border-radius: 9px;
      cursor: pointer;
      background: linear-gradient(100deg,#00d9ff,#9b5cff);
      color: #050509;
      font-weight: 800;
      font-size: 14px;
    }

    #surge-auth-panel button.secondary {
      background: #22232b;
      color: #ddd;
      border: 1px solid #444;
    }

    #surge-auth-panel button:disabled {
      opacity: .55;
      cursor: wait;
    }

    #surge-auth-message {
      min-height: 22px;
      margin-top: 10px;
      color: #69e8ff;
      font-size: 14px;
      overflow-wrap: anywhere;
    }

    #surge-auth-message.error {
      color: #ff7777;
    }

    #surge-auth-links {
      display: flex;
      gap: 10px;
      margin-top: 12px;
    }

    #surge-auth-links button {
      background: none;
      color: #bbb;
      border: 0;
      padding: 7px;
      font-size: 13px;
    }
  `;

  document.head.appendChild(style);

  function syncSession(session) {
    if (session?.access_token) {
      localStorage.setItem(TOKEN_KEY, session.access_token);

      if (session.refresh_token) {
        localStorage.setItem(REFRESH_KEY, session.refresh_token);
      }
    } else {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(REFRESH_KEY);
      localStorage.removeItem(USER_KEY);
    }
  }

  function showMessage(text, error = false) {
    const element = document.getElementById(
      "surge-auth-message"
    );

    if (!element) return;

    element.textContent = text;
    element.className = error ? "error" : "";
  }

  async function getClient() {
    if (supabase) return supabase;

    const config = window.FEEDSURGE_AUTH_CONFIG || {};

    if (
      !config.supabaseUrl ||
      !config.publishableKey ||
      !config.apiBaseUrl
    ) {
      throw new Error(
        "Authentication configuration is missing."
      );
    }

    if (!window.supabase?.createClient) {
      throw new Error(
        "Supabase browser library is not loaded."
      );
    }

    supabase = window.supabase.createClient(
      config.supabaseUrl,
      config.publishableKey,
      {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true
        }
      }
    );

    supabase.auth.onAuthStateChange(
      (_event, session) => syncSession(session)
    );

    const { data, error } =
      await supabase.auth.getSession();

    if (error) throw error;

    syncSession(data.session);

    return supabase;
  }

  function showAuth(nextMode = "login") {
    mode = nextMode;

    document
      .getElementById("surge-auth-overlay")
      ?.remove();

    const overlay = document.createElement("div");

    overlay.id = "surge-auth-overlay";

    overlay.innerHTML = `
      <section
        id="surge-auth-panel"
        role="dialog"
        aria-modal="true"
        aria-label="FEEDSURGE sign in"
      >
        <h2>FEEDSURGE</h2>

        <p id="surge-auth-subtitle"></p>

        <form id="surge-auth-form" novalidate>
          <div id="surge-auth-fields"></div>

          <div
            id="surge-auth-message"
            role="status"
            aria-live="polite"
          ></div>

          <button id="surge-auth-submit" type="submit">
            SEND SIGN-IN CODE
          </button>
        </form>

        <div id="surge-auth-links">
          <button type="button" id="surge-auth-switch"></button>
          <button
            type="button"
            id="surge-auth-resend"
            style="display:none"
          >
            Resend code
          </button>
        </div>

        <button
          type="button"
          class="secondary"
          id="surge-auth-close"
        >
          CLOSE
        </button>
      </section>
    `;

    document.body.appendChild(overlay);

    const fields = document.getElementById(
      "surge-auth-fields"
    );

    const subtitle = document.getElementById(
      "surge-auth-subtitle"
    );

    const submit = document.getElementById(
      "surge-auth-submit"
    );

    const switcher = document.getElementById(
      "surge-auth-switch"
    );

    const resend = document.getElementById(
      "surge-auth-resend"
    );

    fields.innerHTML = `
      <input
        id="surge-auth-email"
        type="email"
        placeholder="Email address"
        autocomplete="email"
        maxlength="254"
        required
      >

      ${
        mode === "register"
          ? `
            <input
              id="surge-auth-name"
              type="text"
              placeholder="Display name"
              maxlength="80"
              autocomplete="name"
            >

            <input
              id="surge-auth-username"
              type="text"
              placeholder="Username (3–24 characters)"
              minlength="3"
              maxlength="24"
              autocomplete="username"
              required
            >

            <input
              id="surge-auth-birthday"
              type="date"
              aria-label="Birthday"
              required
            >

            <select id="surge-auth-account-type">
              <option value="creator">
                Creator account
              </option>

              <option value="business">
                Business account
              </option>
            </select>
          `
          : ""
      }

      <input
        id="surge-auth-code"
        type="text"
        inputmode="numeric"
        autocomplete="one-time-code"
        placeholder="Six-digit email code"
        maxlength="6"
        pattern="[0-9]{6}"
        style="display:none"
      >
    `;

    subtitle.textContent =
      mode === "register"
        ? "CREATE YOUR FEEDSURGE ACCOUNT"
        : "SIGN IN WITH YOUR EMAIL";

    switcher.textContent =
      mode === "login"
        ? "Create account"
        : "Already registered? Sign in";

    switcher.onclick = () => {
      showAuth(
        mode === "login" ? "register" : "login"
      );
    };

    document.getElementById(
      "surge-auth-close"
    ).onclick = () => overlay.remove();

    document.getElementById(
      "surge-auth-form"
    ).onsubmit = async (event) => {
      event.preventDefault();

      if (busy) return;

      const email = document.getElementById(
        "surge-auth-email"
      ).value.trim().toLowerCase();

      const code = document.getElementById(
        "surge-auth-code"
      );

      const verifying =
        code.style.display !== "none";

      busy = true;
      submit.disabled = true;

      try {
        const client = await getClient();

        if (!verifying) {
          if (mode === "register") {
            const username = document.getElementById(
              "surge-auth-username"
            ).value.trim().replace(/^@/, "");

            const birthday = document.getElementById(
              "surge-auth-birthday"
            ).value;

            if (!/^[a-zA-Z0-9_.]{3,24}$/.test(username)) {
              throw new Error(
                "Choose a valid username."
              );
            }

            if (!birthday) {
              throw new Error(
                "Enter your birthday."
              );
            }

            await requestCode(client, {
              email,
              mode: "register",
              username,
              birthday,
              name: document.getElementById(
                "surge-auth-name"
              ).value.trim(),
              accountType: document.getElementById(
                "surge-auth-account-type"
              ).value
            });

          } else {
            await requestCode(client, {
              email,
              mode: "login"
            });
          }

          code.style.display = "block";
          code.required = true;
          code.focus();

          submit.textContent = "VERIFY CODE";

          subtitle.textContent =
            "CHECK YOUR EMAIL FOR THE SIX-DIGIT CODE";

          resend.style.display = "block";

          showMessage(
            "Check your email and enter your six-digit code."
          );

        } else {
          const { data, error } =
            await client.auth.verifyOtp({
              email,
              token: code.value.trim(),
              type: "email"
            });

          if (error) throw error;

          if (!data.session) {
            throw new Error(
              "Verification did not return a session."
            );
          }

          syncSession(data.session);

          localStorage.setItem(
            USER_KEY,
            JSON.stringify({
              id: data.user.id,
              email: data.user.email
            })
          );

          showMessage(
            "You're signed in. Loading FEEDSURGE…"
          );

          setTimeout(() => location.reload(), 450);
        }

      } catch (error) {
        showMessage(
          error?.message || "Sign-in failed.",
          true
        );

      } finally {
        busy = false;
        submit.disabled = false;
      }
    };

    resend.onclick = async () => {
      if (busy) return;

      const email = document.getElementById(
        "surge-auth-email"
      ).value.trim().toLowerCase();

      if (!email) {
        showMessage("Enter your email first.", true);
        return;
      }

      busy = true;
      resend.disabled = true;

      try {
        const client = await getClient();

        const payload = { email, mode };

        if (mode === "register") {
          payload.username = document.getElementById(
            "surge-auth-username"
          ).value.trim().replace(/^@/, "");

          payload.birthday = document.getElementById(
            "surge-auth-birthday"
          ).value;

          payload.name = document.getElementById(
            "surge-auth-name"
          ).value.trim();

          payload.accountType = document.getElementById(
            "surge-auth-account-type"
          ).value;
        }

        await requestCode(client, payload);

        showMessage(
          "A new code request was submitted. Check your email."
        );

      } catch (error) {
        showMessage(
          error?.message || "Could not resend code.",
          true
        );

      } finally {
        busy = false;
        resend.disabled = false;
      }
    };
  }

  async function requestCode(client, payload) {
    const config = window.FEEDSURGE_AUTH_CONFIG;

    const response = await fetch(
      `${config.apiBaseUrl}/api/auth/passwordless/send`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      }
    );

    const result = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(
        result.error || "Could not send email code."
      );
    }

    return result;
  }

  async function logout() {
    try {
      const client = await getClient();
      const { error } = await client.auth.signOut();
      if (error) throw error;
    } catch (error) {
      console.error("FEEDSURGE logout:", error);
    }

    syncSession(null);
    location.reload();
  }

  window.FEEDSURGE_LOGIN = () => showAuth("login");
  window.FEEDSURGE_REGISTER = () => showAuth("register");
  window.FEEDSURGE_LOGOUT = logout;

  window.SURGE_AUTH = {
    getToken: () => localStorage.getItem(TOKEN_KEY),

    getUser: () => {
      try {
        return JSON.parse(
          localStorage.getItem(USER_KEY) || "null"
        );
      } catch {
        return null;
      }
    },

    logout
  };

  document.addEventListener("click", (event) => {
    const button = event.target.closest("button");

    if (!button) return;

    const testId =
      button.getAttribute("data-testid") || "";

    const label =
      (button.innerText || "").trim().toLowerCase();

    if (
      testId === "login-btn" ||
      ["log in", "login", "sign in"].includes(label)
    ) {
      event.preventDefault();
      event.stopImmediatePropagation();
      showAuth("login");

    } else if (
      testId === "create-account-btn" ||
      label.includes("create a free account") ||
      label === "sign up"
    ) {
      event.preventDefault();
      event.stopImmediatePropagation();
      showAuth("register");
    }
  }, true);

  document.addEventListener("DOMContentLoaded", () => {
    getClient().catch((error) => {
      console.error(
        "FEEDSURGE authentication initialization:",
        error
      );
    });
  });

})();
