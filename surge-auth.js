
(() => {
  "use strict";

  const TOKEN_KEY = "feedsurge_access_token";
  const REFRESH_KEY = "feedsurge_refresh_token";
  const USER_KEY = "surge_profile";

  let busy = false;
  let mode = "login";
  let codeSent = false;

  async function getAuth() {
    if (window.FEEDSURGE_AUTH) return window.FEEDSURGE_AUTH;

    await import("./feedsurge-auth-client.js");

    if (!window.FEEDSURGE_AUTH) {
      throw new Error("Authentication client did not initialize.");
    }

    return window.FEEDSURGE_AUTH;
  }

  function saveSession(auth, result) {
    const sessionPromise = auth.getSession();

    return sessionPromise.then((session) => {
      if (!session?.access_token) {
        throw new Error("No valid sign-in session was returned.");
      }

      localStorage.setItem(TOKEN_KEY, session.access_token);

      if (session.refresh_token) {
        localStorage.setItem(REFRESH_KEY, session.refresh_token);
      }

      if (result?.user) {
        localStorage.setItem(USER_KEY, JSON.stringify(result.user));
      }

      return session;
    });
  }

  function showMessage(message, error = false) {
    const element = document.getElementById("surge-auth-message");
    if (!element) return;

    element.textContent = message;
    element.style.color = error ? "#ff7777" : "#69e8ff";
  }

  function showAuth(nextMode = "login") {
    mode = nextMode;
    codeSent = false;

    document.getElementById("surge-auth-overlay")?.remove();

    const overlay = document.createElement("div");
    overlay.id = "surge-auth-overlay";

    overlay.style.cssText =
      "position:fixed;inset:0;z-index:999999;display:flex;" +
      "align-items:center;justify-content:center;padding:20px;" +
      "background:rgba(0,0,0,.95);font-family:Arial,sans-serif;";

    overlay.innerHTML = `
      <section style="
        width:100%;max-width:430px;max-height:92vh;overflow:auto;
        box-sizing:border-box;padding:26px;background:#101014;
        color:white;border:1px solid #333;border-radius:18px;
        box-shadow:0 0 34px #00e5ff24">
        <h2 style="color:#00e5ff;letter-spacing:2px">FEEDSURGE</h2>
        <p id="surge-auth-subtitle" style="color:#aaa"></p>

        <form id="surge-auth-form">
          <div id="surge-auth-fields"></div>
          <div id="surge-auth-message" role="status"
            aria-live="polite" style="min-height:24px"></div>
          <button id="surge-auth-submit" type="submit"
            style="width:100%;padding:14px;border:0;border-radius:9px;
            background:linear-gradient(100deg,#00d9ff,#9b5cff);
            font-weight:800">
            SEND SIGN-IN CODE
          </button>
        </form>

        <button id="surge-auth-switch" type="button"
          style="width:100%;padding:12px;margin-top:10px;
          background:#22232b;color:white;border:1px solid #444">
        </button>

        <button id="surge-auth-close" type="button"
          style="width:100%;padding:12px;margin-top:10px;
          background:#22232b;color:white;border:1px solid #444">
          CLOSE
        </button>
      </section>
    `;

    document.body.appendChild(overlay);

    const fields = document.getElementById("surge-auth-fields");

    fields.innerHTML = `
      <input id="surge-auth-email" type="email"
        placeholder="Email address" autocomplete="email" required
        maxlength="254" style="width:100%;box-sizing:border-box;
        padding:14px;margin:8px 0;background:#08090d;color:white;
        border:1px solid #444;border-radius:9px">

      ${mode === "register" ? `
        <input id="surge-auth-name" type="text"
          placeholder="Display name" maxlength="80"
          style="width:100%;box-sizing:border-box;padding:14px;
          margin:8px 0;background:#08090d;color:white;
          border:1px solid #444;border-radius:9px">

        <input id="surge-auth-username" type="text"
          placeholder="Username (3–24 characters)" required
          minlength="3" maxlength="24"
          style="width:100%;box-sizing:border-box;padding:14px;
          margin:8px 0;background:#08090d;color:white;
          border:1px solid #444;border-radius:9px">

        <input id="surge-auth-birthday" type="date" required
          style="width:100%;box-sizing:border-box;padding:14px;
          margin:8px 0;background:#08090d;color:white;
          border:1px solid #444;border-radius:9px">

        <select id="surge-auth-account-type"
          style="width:100%;box-sizing:border-box;padding:14px;
          margin:8px 0;background:#08090d;color:white;
          border:1px solid #444;border-radius:9px">
          <option value="creator">Creator account</option>
          <option value="business">Business account</option>
        </select>
      ` : ""}

      <input id="surge-auth-code" type="text"
        inputmode="numeric" autocomplete="one-time-code"
        placeholder="Six-digit email code" maxlength="6"
        style="display:none;width:100%;box-sizing:border-box;
        padding:14px;margin:8px 0;background:#08090d;color:white;
        border:1px solid #444;border-radius:9px">
    `;

    document.getElementById("surge-auth-subtitle").textContent =
      mode === "register"
        ? "CREATE YOUR FEEDSURGE ACCOUNT"
        : "SIGN IN WITH YOUR EMAIL";

    document.getElementById("surge-auth-switch").textContent =
      mode === "login" ? "Create account" : "Already registered? Sign in";

    document.getElementById("surge-auth-switch").onclick = () =>
      showAuth(mode === "login" ? "register" : "login");

    document.getElementById("surge-auth-close").onclick = () =>
      overlay.remove();

    document.getElementById("surge-auth-form").onsubmit =
      async (event) => {
        event.preventDefault();
        if (busy) return;

        const submit = document.getElementById("surge-auth-submit");
        const email = document.getElementById("surge-auth-email")
          .value.trim().toLowerCase();
        const code = document.getElementById("surge-auth-code");

        busy = true;
        submit.disabled = true;

        try {
          const auth = await getAuth();

          if (!codeSent) {
            const payload = { email, mode };

            if (mode === "register") {
              payload.username = document
                .getElementById("surge-auth-username")
                .value.trim().replace(/^@/, "");

              payload.birthday = document
                .getElementById("surge-auth-birthday").value;

              payload.name = document
                .getElementById("surge-auth-name").value.trim();

              payload.accountType = document
                .getElementById("surge-auth-account-type").value;
            }

            await auth.sendCode(payload);

            codeSent = true;
            code.style.display = "block";
            code.required = true;
            code.focus();

            submit.textContent = "VERIFY CODE";

            document.getElementById("surge-auth-subtitle")
              .textContent = "CHECK YOUR EMAIL FOR YOUR SIX-DIGIT CODE";

            showMessage("Code sent. Check your email.");

          } else {
            const token = code.value.trim();

            if (!/^\d{6}$/.test(token)) {
              throw new Error("Enter the six-digit code.");
            }

            const result = await auth.verifyCode({ email, token });

            await saveSession(auth, result);

            showMessage("Signed in. Loading FEEDSURGE…");

            setTimeout(() => location.reload(), 500);
          }

        } catch (error) {
          showMessage(error.message || "Authentication failed.", true);
        } finally {
          busy = false;
          submit.disabled = false;
        }
      };
  }

  async function logout() {
    try {
      const auth = await getAuth();
      await auth.signOut();
    } catch (error) {
      console.error("FEEDSURGE logout:", error);
    }

    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(REFRESH_KEY);
    localStorage.removeItem(USER_KEY);
    location.reload();
  }

  window.FEEDSURGE_LOGIN = () => showAuth("login");
  window.FEEDSURGE_REGISTER = () => showAuth("register");
  window.FEEDSURGE_LOGOUT = logout;

  window.SURGE_AUTH = {
    getToken: () => localStorage.getItem(TOKEN_KEY),
    getUser: () => {
      try {
        return JSON.parse(localStorage.getItem(USER_KEY) || "null");
      } catch {
        return null;
      }
    },
    logout
  };

  document.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;

    const label = (button.innerText || "").trim().toLowerCase();
    const testId = button.getAttribute("data-testid") || "";

    if (testId === "login-btn" ||
        ["log in", "login", "sign in"].includes(label)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      showAuth("login");
    } else if (testId === "create-account-btn" ||
        label.includes("create a free account") ||
        label === "sign up") {
      event.preventDefault();
      event.stopImmediatePropagation();
      showAuth("register");
    }
  }, true);

})();
