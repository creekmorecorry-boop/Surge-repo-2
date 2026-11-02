
(() => {
  "use strict";

  const API = "https://surge-repo-2-1.onrender.com";
  const TOKEN_KEY = "surge_access_token";
  const REFRESH_KEY = "surge_refresh_token";
  const USER_KEY = "surge_profile";

  const request = async (path, body, token) => {
    const response = await fetch(API + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: "Bearer " + token } : {})
      },
      body: JSON.stringify(body)
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) {
      throw new Error(data.error || data.message || "Request failed. Please try again.");
    }
    return data;
  };

  const saveSession = (data) => {
    const session = data.session;
    if (!session || !session.access_token) {
      throw new Error("Account created. Check your email to confirm your account, then log in.");
    }

    localStorage.setItem(TOKEN_KEY, session.access_token);
    if (session.refresh_token) {
      localStorage.setItem(REFRESH_KEY, session.refresh_token);
    }

    if (data.user) {
      localStorage.setItem(USER_KEY, JSON.stringify(data.user));
    }
  };

  const logout = () => {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(REFRESH_KEY);
    localStorage.removeItem(USER_KEY);
    location.reload();
  };

  window.SURGE_AUTH = {
    api: API,
    logout,
    getToken: () => localStorage.getItem(TOKEN_KEY),
    getUser: () => {
      try {
        return JSON.parse(localStorage.getItem(USER_KEY) || "null");
      } catch {
        return null;
      }
    }
  };

  const style = document.createElement("style");
  style.textContent = `
    #surge-auth-overlay {
      position:fixed; inset:0; z-index:999999;
      display:flex; align-items:center; justify-content:center;
      padding:20px; background:rgba(0,0,0,.94);
      font-family:Arial,sans-serif;
    }
    #surge-auth-panel {
      width:100%; max-width:430px; padding:28px;
      background:#111; color:#fff; border:1px solid #333;
      border-radius:16px; box-shadow:0 0 35px #00ff8830;
    }
    #surge-auth-panel h2 {
      margin:0 0 8px; color:#00ff88; letter-spacing:2px;
    }
    #surge-auth-panel p { color:#aaa; line-height:1.5; }
    #surge-auth-panel input {
      display:block; width:100%; box-sizing:border-box;
      margin:12px 0; padding:14px; border-radius:8px;
      border:1px solid #444; background:#080808;
      color:white; font-size:16px;
    }
    #surge-auth-panel button {
      width:100%; padding:14px; margin-top:12px;
      border:0; border-radius:8px; cursor:pointer;
      background:#00ff88; color:#050505;
      font-weight:800; font-size:15px;
    }
    #surge-auth-panel button.secondary {
      background:#222; color:#ddd; border:1px solid #444;
    }
    #surge-auth-panel label {
      display:flex; gap:9px; align-items:flex-start;
      color:#bbb; font-size:13px; margin-top:12px;
    }
    #surge-auth-panel label input {
      width:auto; margin:2px 0;
    }
    #surge-auth-message {
      min-height:22px; color:#00ff88; font-size:14px;
      overflow-wrap:anywhere;
    }
    #surge-auth-message.error { color:#ff6868; }
    #surge-auth-links {
      display:flex; gap:12px; margin-top:18px;
    }
    #surge-auth-links button {
      background:none; color:#aaa; border:0;
      padding:5px; font-size:13px;
    }
  `;
  document.head.appendChild(style);

  let mode = "login";

  function showAuth(nextMode) {
    mode = nextMode || "login";
    document.getElementById("surge-auth-overlay")?.remove();

    const overlay = document.createElement("div");
    overlay.id = "surge-auth-overlay";
    overlay.innerHTML = `
      <div id="surge-auth-panel">
        <h2>SURGE</h2>
        <p id="surge-auth-subtitle">ENTER THE NETWORK</p>
        <form id="surge-auth-form">
          <div id="surge-auth-username-wrap"></div>
          <input id="surge-auth-email" type="email"
            placeholder="Email address" autocomplete="email" required>
          <input id="surge-auth-password" type="password"
            placeholder="Password" autocomplete="current-password" minlength="8">
          <div id="surge-auth-terms-wrap"></div>
          <div id="surge-auth-message" role="status"></div>
          <button id="surge-auth-submit" type="submit">LOG IN</button>
        </form>
        <div id="surge-auth-links">
          <button type="button" id="surge-auth-switch">Create account</button>
          <button type="button" id="surge-auth-reset">Forgot password?</button>
        </div>
        <button type="button" class="secondary"
          id="surge-auth-close">BACK TO SURGE</button>
      </div>
    `;
    document.body.appendChild(overlay);

    const usernameWrap = document.getElementById("surge-auth-username-wrap");
    const termsWrap = document.getElementById("surge-auth-terms-wrap");
    const subtitle = document.getElementById("surge-auth-subtitle");
    const submit = document.getElementById("surge-auth-submit");
    const password = document.getElementById("surge-auth-password");
    const message = document.getElementById("surge-auth-message");
    const switchButton = document.getElementById("surge-auth-switch");
    const resetButton = document.getElementById("surge-auth-reset");

    if (mode === "register") {
      subtitle.textContent = "CREATE YOUR SURGE IDENTITY";
      usernameWrap.innerHTML =
        '<input id="surge-auth-username" placeholder="Username (3–24 characters)" minlength="3" maxlength="24" required>';
      termsWrap.innerHTML =
        '<label><input id="surge-auth-terms" type="checkbox" required><span>I accept the Terms of Service and Privacy Policy.</span></label>';
      submit.textContent = "CREATE ACCOUNT";
      switchButton.textContent = "Already have an account? Log in";
      password.autocomplete = "new-password";
    } else {
      subtitle.textContent = "ENTER THE NETWORK";
      submit.textContent = "LOG IN";
      switchButton.textContent = "Create account";
      password.autocomplete = "current-password";
    }

    switchButton.onclick = () => showAuth(mode === "login" ? "register" : "login");
    resetButton.onclick = async () => {
      const email = document.getElementById("surge-auth-email").value.trim();
      if (!email) {
        message.textContent = "Enter your email address first.";
        message.className = "error";
        return;
      }
      try {
        await request("/api/auth/password-reset", { email });
        message.className = "";
        message.textContent = "If that account exists, a password-reset email has been sent.";
      } catch (error) {
        message.className = "error";
        message.textContent = error.message;
      }
    };

    document.getElementById("surge-auth-close").onclick = () => overlay.remove();

    document.getElementById("surge-auth-form").onsubmit = async (event) => {
      event.preventDefault();
      message.className = "";
      message.textContent = "Connecting securely…";
      submit.disabled = true;

      const email = document.getElementById("surge-auth-email").value.trim();
      const pass = password.value;

      try {
        let data;

        if (mode === "register") {
          const username = document.getElementById("surge-auth-username").value.trim();
          const accepted = document.getElementById("surge-auth-terms").checked;

          if (!accepted) throw new Error("You must accept the terms to register.");

          data = await request("/api/auth/register", {
            email,
            password: pass,
            username,
            terms_accepted: true
          });

          if (data.confirmation_required || !data.session) {
            message.textContent =
              "Account created. Confirm your email, then return here and log in.";
            submit.disabled = false;
            return;
          }
        } else {
          data = await request("/api/auth/login", {
            email,
            password: pass
          });
        }

        saveSession(data);
        message.textContent = "Secure login successful. Loading SURGE…";
        setTimeout(() => location.reload(), 500);

      } catch (error) {
        message.className = "error";
        message.textContent = error.message;
        submit.disabled = false;
      }
    };
  }

  document.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;

    const testId = button.getAttribute("data-testid") || "";
    const label = (button.innerText || "").trim().toLowerCase();

    if (
      testId === "login-btn" ||
      label === "log in" ||
      label === "login"
    ) {
      event.preventDefault();
      event.stopImmediatePropagation();
      showAuth("login");
    } else if (
      testId === "create-account-btn" ||
      label.includes("create a free account")
    ) {
      event.preventDefault();
      event.stopImmediatePropagation();
      showAuth("register");
    }
  }, true);

})();
