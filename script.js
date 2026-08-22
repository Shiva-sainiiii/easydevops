// ── STATE ──
const history = [];
let isLoading = false;
let activeController = null;   // AbortController for the in-flight /chat (or /upload) request
let userCancelled = false;     // distinguishes a manual Stop from a network error

// ══════════════════════════════════════════════════════════════════
// APP SETTINGS (localStorage) — small client-only UI preferences.
// Nothing here is security/auth-relevant; safe defaults if storage is
// unavailable or the key is missing/corrupt.
// ══════════════════════════════════════════════════════════════════
const APP_SETTINGS_KEY = 'devops_agent_settings_v1';
const DEFAULT_SETTINGS = { haptics: true, autoscroll: true, confirmClear: true, amoled: false };

function loadAppSettings() {
  try {
    const raw = localStorage.getItem(APP_SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch (e) {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveAppSettings() {
  try { localStorage.setItem(APP_SETTINGS_KEY, JSON.stringify(appSettings)); } catch (e) {}
}

let appSettings = loadAppSettings();

function applyTheme() {
  document.documentElement.setAttribute('data-theme', appSettings.amoled ? 'amoled' : 'default');
}
applyTheme();

// ══════════════════════════════════════════════════════════════════
// AUTH — GitHub OAuth session check.
// This app never stores its own credentials client-side; it only ever
// asks the server "am I logged in right now?" via the session cookie
// (httponly, so JS can't read/forge it) and reflects whatever the
// server says. /api/me is the single source of truth.
// ══════════════════════════════════════════════════════════════════
let authedUser = null; // { login, avatar_url, vercelConnected, vercelUsername, netlifyConnected, netlifyEmail, renderConnected, renderEmail } | null

async function checkAuth() {
  try {
    const res = await fetch('/api/me', { credentials: 'same-origin' });
    const data = await res.json();
    if (data.logged_in) {
      authedUser = {
        login: data.login,
        avatar_url: data.avatar_url,
        vercelConnected: !!data.vercel_connected,
        vercelUsername: data.vercel_username || null,
        netlifyConnected: !!data.netlify_connected,
        netlifyEmail: data.netlify_email || null,
        renderConnected: !!data.render_connected,
        renderEmail: data.render_email || null,
      };
      hideLoginGate();
      renderUserBadge();
    } else {
      authedUser = null;
      showLoginGate();
    }
  } catch (e) {
    // Network hiccup — don't hard-fail into the login gate on a transient
    // error, but don't pretend we're logged in either.
    showLoginGate();
  }
}

function showLoginGate() {
  document.getElementById('login-gate').classList.add('show');
  document.getElementById('user-badge').style.display = 'none';
  const params = new URLSearchParams(location.search);
  const err = params.get('auth_error');
  if (err) {
    const banner = document.getElementById('login-error-banner');
    const messages = {
      state_mismatch: 'Login verify nahi hua (state mismatch). Dubara try karo.',
      no_code: 'GitHub se code nahi mila. Dubara try karo.',
      identity_fetch_failed: 'GitHub identity fetch nahi hui. Dubara try karo.',
      access_denied: 'Tumne permission deny kar di. Connect karne ke liye access dena zaroori hai.',
    };
    banner.textContent = messages[err] || `Login error: ${err}`;
    banner.classList.add('show');
    history_replaceCleanUrl();
  }
}

function history_replaceCleanUrl() {
  // Strip ?auth_error=... from the URL bar without a reload, so a page
  // refresh doesn't re-show the same stale error.
  const url = new URL(location.href);
  url.searchParams.delete('auth_error');
  window.history.replaceState({}, '', url.pathname + url.search);
}

function hideLoginGate() {
  document.getElementById('login-gate').classList.remove('show');
}

function renderUserBadge() {
  if (!authedUser) return;
  const badge = document.getElementById('user-badge');
  const avatar = document.getElementById('user-avatar');
  avatar.src = authedUser.avatar_url || '';
  avatar.alt = authedUser.login;
  badge.style.display = 'flex';
  document.getElementById('user-menu-name').textContent = '@' + authedUser.login;
  renderVercelMenuState();
  renderNetlifyMenuState();
  renderRenderMenuState();
}

function renderVercelMenuState() {
  const item = document.getElementById('vercel-menu-item');
  const label = document.getElementById('vercel-menu-label');
  if (!authedUser) return;
  if (authedUser.vercelConnected) {
    item.classList.add('connected');
    label.textContent = `Vercel: @${authedUser.vercelUsername || 'connected'} ✓`;
  } else {
    item.classList.remove('connected');
    label.textContent = 'Connect Vercel';
  }
  // Keep the drawer's Connected Apps list in sync too, in case it's open
  // (or gets opened next) after a connect/disconnect changed authedUser.
  renderAppsList();
  renderDrawerProfile();
}

function renderNetlifyMenuState() {
  const item = document.getElementById('netlify-menu-item');
  const label = document.getElementById('netlify-menu-label');
  if (!authedUser) return;
  if (authedUser.netlifyConnected) {
    item.classList.add('connected');
    label.textContent = `Netlify: ${authedUser.netlifyEmail || 'connected'} ✓`;
  } else {
    item.classList.remove('connected');
    label.textContent = 'Connect Netlify';
  }
  renderAppsList();
  renderDrawerProfile();
}

function renderRenderMenuState() {
  const item = document.getElementById('render-menu-item');
  const label = document.getElementById('render-menu-label');
  if (!authedUser) return;
  if (authedUser.renderConnected) {
    item.classList.add('connected');
    label.textContent = `Render: ${authedUser.renderEmail || 'connected'} ✓`;
  } else {
    item.classList.remove('connected');
    label.textContent = 'Connect Render';
  }
  renderAppsList();
  renderDrawerProfile();
}

function toggleUserMenu() {
  document.getElementById('user-menu').classList.toggle('show');
}

document.addEventListener('click', (e) => {
  const menu = document.getElementById('user-menu');
  const badge = document.getElementById('user-badge');
  if (menu.classList.contains('show') && !menu.contains(e.target) && !badge.contains(e.target)) {
    menu.classList.remove('show');
  }
});

async function handleLogout() {
  document.getElementById('user-menu').classList.remove('show');
  try {
    await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' });
  } catch (e) {
    // Even if the network call fails, still clear local state and show
    // the gate — worst case the server-side session lingers until it
    // naturally expires, but the user isn't stuck looking logged-in.
  }
  authedUser = null;
  // Wipe ALL local chat sessions and settings on logout, not just the
  // active one — this device may be shared, and the next person to log
  // in (a different GitHub account) shouldn't see this user's chat
  // history sitting in the drawer.
  try {
    localStorage.removeItem(SESSIONS_KEY);
    localStorage.removeItem(APP_SETTINGS_KEY);
  } catch (e) {}
  location.reload();
}

// ══════════════════════════════════════════════════════════════════
// VERCEL CONNECTION — manual token paste (see server.py comment near
// /api/vercel/connect for why this is a paste flow, not OAuth).
// Clicking the menu item either opens the paste modal (not connected yet)
// or disconnects (already connected) — same click-to-toggle pattern as
// a lot of "connected account" UIs.
// ══════════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════════
// CLIENT-SIDE TOKEN PRE-VALIDATION (tick/cross before submit)
// Debounced call to /api/<provider>/validate as the user types/pastes
// into a token field — shows a spinner while checking, then a green
// tick or red cross + short label, all BEFORE they hit Connect. The
// real /connect call on submit still re-validates server-side (this
// never skips that), it just gives earlier feedback so a typo'd or
// expired token doesn't have to round-trip through the full connect
// flow to be caught.
// ══════════════════════════════════════════════════════════════════
const TOKEN_VALIDATE_DEBOUNCE_MS = 600;
const _tokenValidateTimers = {};
const _tokenValidateSeq = { vercel: 0, netlify: 0, render: 0 };

const TOKEN_ICON_SPINNER = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 3a9 9 0 019 9"/></svg>';
const TOKEN_ICON_CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>';
const TOKEN_ICON_CROSS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18M6 6l12 12"/></svg>';

const TOKEN_VALIDATE_LABELS = {
  vercel: { valid: 'Token valid hai', invalid: 'Ye token valid nahi hai' },
  netlify: { valid: 'Token valid hai', invalid: 'Ye token valid nahi hai' },
  render: { valid: 'API key valid hai', invalid: 'Ye API key valid nahi hai' },
};

function onTokenInput(provider) {
  const input = document.getElementById(`${provider}-token-input`);
  const icon = document.getElementById(`${provider}-token-icon`);
  const label = document.getElementById(`${provider}-token-label`);
  const value = input.value.trim();

  clearTimeout(_tokenValidateTimers[provider]);

  if (!value) {
    input.classList.remove('token-valid', 'token-invalid');
    icon.classList.remove('show', 'checking', 'valid', 'invalid');
    label.classList.remove('show', 'valid', 'invalid');
    return;
  }

  // Show a checking spinner immediately so typing feels responsive,
  // then actually fire the validate call after the debounce window.
  input.classList.remove('token-valid', 'token-invalid');
  icon.className = 'token-validate-icon show checking';
  icon.innerHTML = TOKEN_ICON_SPINNER;
  label.classList.remove('show');

  const mySeq = ++_tokenValidateSeq[provider];
  _tokenValidateTimers[provider] = setTimeout(async () => {
    try {
      const res = await fetch(`/api/${provider}/validate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ token: value }),
      });
      const data = await res.json();

      // Stale response guard — if the user kept typing, a newer call has
      // already been fired; don't let a slow older response overwrite it.
      if (mySeq !== _tokenValidateSeq[provider]) return;

      if (data.valid === true) {
        input.classList.add('token-valid');
        input.classList.remove('token-invalid');
        icon.className = 'token-validate-icon show valid';
        icon.innerHTML = TOKEN_ICON_CHECK;
        label.textContent = data.label ? `${TOKEN_VALIDATE_LABELS[provider].valid} (@${data.label})` : TOKEN_VALIDATE_LABELS[provider].valid;
        label.className = 'token-validate-label show valid';
      } else if (data.valid === false) {
        input.classList.add('token-invalid');
        input.classList.remove('token-valid');
        icon.className = 'token-validate-icon show invalid';
        icon.innerHTML = TOKEN_ICON_CROSS;
        label.textContent = TOKEN_VALIDATE_LABELS[provider].invalid;
        label.className = 'token-validate-label show invalid';
      } else {
        // valid === null (network hiccup talking to the provider) —
        // inconclusive, so just hide the indicator rather than guess.
        input.classList.remove('token-valid', 'token-invalid');
        icon.classList.remove('show', 'checking', 'valid', 'invalid');
        label.classList.remove('show');
      }
    } catch (e) {
      if (mySeq !== _tokenValidateSeq[provider]) return;
      input.classList.remove('token-valid', 'token-invalid');
      icon.classList.remove('show', 'checking', 'valid', 'invalid');
      label.classList.remove('show');
    }
  }, TOKEN_VALIDATE_DEBOUNCE_MS);
}

function onVercelMenuClick() {
  document.getElementById('user-menu').classList.remove('show');
  if (authedUser && authedUser.vercelConnected) {
    confirmDisconnectVercel();
  } else {
    showVercelModal();
  }
}

function resetTokenValidateUI(provider) {
  const input = document.getElementById(`${provider}-token-input`);
  const icon = document.getElementById(`${provider}-token-icon`);
  const label = document.getElementById(`${provider}-token-label`);
  clearTimeout(_tokenValidateTimers[provider]);
  _tokenValidateSeq[provider]++; // invalidates any in-flight validate response
  input.classList.remove('token-valid', 'token-invalid');
  icon.classList.remove('show', 'checking', 'valid', 'invalid');
  label.classList.remove('show', 'valid', 'invalid');
}

function showVercelModal() {
  document.getElementById('vercel-modal-overlay').classList.add('show');
  document.getElementById('vercel-modal-error').classList.remove('show');
  const input = document.getElementById('vercel-token-input');
  input.value = '';
  resetTokenValidateUI('vercel');
  setTimeout(() => input.focus(), 50);
}

function hideVercelModal() {
  document.getElementById('vercel-modal-overlay').classList.remove('show');
}

async function submitVercelToken() {
  const input = document.getElementById('vercel-token-input');
  const errBox = document.getElementById('vercel-modal-error');
  const btn = document.getElementById('vercel-connect-btn');
  const token = input.value.trim();

  errBox.classList.remove('show');
  if (!token) {
    errBox.textContent = 'Token paste karo pehle.';
    errBox.classList.add('show');
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Connecting...';

  try {
    const res = await fetch('/api/vercel/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ token }),
    });
    const data = await res.json();

    if (!res.ok || !data.ok) {
      errBox.textContent = data.reply || 'Connect nahi hua. Token check karke dubara try karo.';
      errBox.classList.add('show');
      btn.disabled = false;
      btn.textContent = 'Connect';
      return;
    }

    authedUser.vercelConnected = true;
    authedUser.vercelUsername = data.vercel_username;
    renderVercelMenuState();
    hideVercelModal();
    addMessage('agent', `✅ Vercel connect ho gaya! (@${data.vercel_username}) Ab tum apne repos Vercel pe deploy kar sakte ho.`, 'success');
  } catch (e) {
    errBox.textContent = 'Server se connect nahi ho paya. Dubara try karo.';
    errBox.classList.add('show');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Connect';
  }
}

function confirmDisconnectVercel() {
  const messages = document.getElementById('messages');
  const es = document.getElementById('empty-state');
  if (es) es.style.display = 'none';

  const wrap = document.createElement('div');
  wrap.className = 'msg-wrap agent';
  const label = document.createElement('div');
  label.className = 'msg-label';
  label.textContent = 'Agent';
  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble warning';
  bubble.innerHTML = `Vercel disconnect kar du? (@${authedUser.vercelUsername || ''}) Vercel commands tab tak kaam nahi karenge jab tak dubara connect na karo.`;

  const actions = document.createElement('div');
  actions.className = 'confirm-actions';
  const yesBtn = document.createElement('button');
  yesBtn.className = 'confirm-btn danger';
  yesBtn.textContent = 'Haan, Disconnect Karo';
  yesBtn.onclick = async () => {
    yesBtn.disabled = true;
    noBtn.disabled = true;
    try {
      await fetch('/api/vercel/disconnect', { method: 'POST', credentials: 'same-origin' });
    } catch (e) {}
    authedUser.vercelConnected = false;
    authedUser.vercelUsername = null;
    renderVercelMenuState();
    addMessage('agent', 'Vercel disconnect ho gaya.', '');
  };
  const noBtn = document.createElement('button');
  noBtn.className = 'confirm-btn cancel';
  noBtn.textContent = 'Cancel';
  noBtn.onclick = () => { yesBtn.disabled = true; noBtn.disabled = true; };

  actions.appendChild(yesBtn);
  actions.appendChild(noBtn);
  bubble.appendChild(actions);
  wrap.appendChild(label);
  wrap.appendChild(bubble);
  messages.appendChild(wrap);
  scrollToBottom();
}

// ══════════════════════════════════════════════════════════════════
// NETLIFY CONNECTION — same manual-token-paste pattern as Vercel above.
// See server.py comment near /api/netlify/connect for why this is a
// paste flow, not OAuth.
// ══════════════════════════════════════════════════════════════════
function onNetlifyMenuClick() {
  document.getElementById('user-menu').classList.remove('show');
  if (authedUser && authedUser.netlifyConnected) {
    confirmDisconnectNetlify();
  } else {
    showNetlifyModal();
  }
}

function showNetlifyModal() {
  document.getElementById('netlify-modal-overlay').classList.add('show');
  document.getElementById('netlify-modal-error').classList.remove('show');
  const input = document.getElementById('netlify-token-input');
  input.value = '';
  resetTokenValidateUI('netlify');
  setTimeout(() => input.focus(), 50);
}

function hideNetlifyModal() {
  document.getElementById('netlify-modal-overlay').classList.remove('show');
}

async function submitNetlifyToken() {
  const input = document.getElementById('netlify-token-input');
  const errBox = document.getElementById('netlify-modal-error');
  const btn = document.getElementById('netlify-connect-btn');
  const token = input.value.trim();

  errBox.classList.remove('show');
  if (!token) {
    errBox.textContent = 'Token paste karo pehle.';
    errBox.classList.add('show');
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Connecting...';

  try {
    const res = await fetch('/api/netlify/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ token }),
    });
    const data = await res.json();

    if (!res.ok || !data.ok) {
      errBox.textContent = data.reply || 'Connect nahi hua. Token check karke dubara try karo.';
      errBox.classList.add('show');
      btn.disabled = false;
      btn.textContent = 'Connect';
      return;
    }

    authedUser.netlifyConnected = true;
    authedUser.netlifyEmail = data.netlify_email;
    renderNetlifyMenuState();
    hideNetlifyModal();
    addMessage('agent', `✅ Netlify connect ho gaya! (${data.netlify_email}) Ab tum apni sites Netlify pe manage kar sakte ho.`, 'success');
  } catch (e) {
    errBox.textContent = 'Server se connect nahi ho paya. Dubara try karo.';
    errBox.classList.add('show');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Connect';
  }
}

function confirmDisconnectNetlify() {
  const messages = document.getElementById('messages');
  const es = document.getElementById('empty-state');
  if (es) es.style.display = 'none';

  const wrap = document.createElement('div');
  wrap.className = 'msg-wrap agent';
  const label = document.createElement('div');
  label.className = 'msg-label';
  label.textContent = 'Agent';
  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble warning';
  bubble.innerHTML = `Netlify disconnect kar du? (${authedUser.netlifyEmail || ''}) Netlify commands tab tak kaam nahi karenge jab tak dubara connect na karo.`;

  const actions = document.createElement('div');
  actions.className = 'confirm-actions';
  const yesBtn = document.createElement('button');
  yesBtn.className = 'confirm-btn danger';
  yesBtn.textContent = 'Haan, Disconnect Karo';
  yesBtn.onclick = async () => {
    yesBtn.disabled = true;
    noBtn.disabled = true;
    try {
      await fetch('/api/netlify/disconnect', { method: 'POST', credentials: 'same-origin' });
    } catch (e) {}
    authedUser.netlifyConnected = false;
    authedUser.netlifyEmail = null;
    renderNetlifyMenuState();
    addMessage('agent', 'Netlify disconnect ho gaya.', '');
  };
  const noBtn = document.createElement('button');
  noBtn.className = 'confirm-btn cancel';
  noBtn.textContent = 'Cancel';
  noBtn.onclick = () => { yesBtn.disabled = true; noBtn.disabled = true; };

  actions.appendChild(yesBtn);
  actions.appendChild(noBtn);
  bubble.appendChild(actions);
  wrap.appendChild(label);
  wrap.appendChild(bubble);
  messages.appendChild(wrap);
  scrollToBottom();
}

// ══════════════════════════════════════════════════════════════════
// RENDER CONNECTION — same manual-token-paste pattern as Vercel/Netlify
// above. See server.py comment near /api/render/connect for why this is
// a paste flow (Render has no public OAuth at all).
// ══════════════════════════════════════════════════════════════════
function onRenderMenuClick() {
  document.getElementById('user-menu').classList.remove('show');
  if (authedUser && authedUser.renderConnected) {
    confirmDisconnectRender();
  } else {
    showRenderModal();
  }
}

function showRenderModal() {
  document.getElementById('render-modal-overlay').classList.add('show');
  document.getElementById('render-modal-error').classList.remove('show');
  const input = document.getElementById('render-token-input');
  input.value = '';
  resetTokenValidateUI('render');
  setTimeout(() => input.focus(), 50);
}

function hideRenderModal() {
  document.getElementById('render-modal-overlay').classList.remove('show');
}

async function submitRenderToken() {
  const input = document.getElementById('render-token-input');
  const errBox = document.getElementById('render-modal-error');
  const btn = document.getElementById('render-connect-btn');
  const token = input.value.trim();

  errBox.classList.remove('show');
  if (!token) {
    errBox.textContent = 'API key paste karo pehle.';
    errBox.classList.add('show');
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Connecting...';

  try {
    const res = await fetch('/api/render/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ token }),
    });
    const data = await res.json();

    if (!res.ok || !data.ok) {
      errBox.textContent = data.reply || 'Connect nahi hua. Key check karke dubara try karo.';
      errBox.classList.add('show');
      btn.disabled = false;
      btn.textContent = 'Connect';
      return;
    }

    authedUser.renderConnected = true;
    authedUser.renderEmail = data.render_email;
    renderRenderMenuState();
    hideRenderModal();
    addMessage('agent', `✅ Render connect ho gaya! (${data.render_email}) Ab tum apni services Render pe manage kar sakte ho.`, 'success');
  } catch (e) {
    errBox.textContent = 'Server se connect nahi ho paya. Dubara try karo.';
    errBox.classList.add('show');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Connect';
  }
}

function confirmDisconnectRender() {
  const messages = document.getElementById('messages');
  const es = document.getElementById('empty-state');
  if (es) es.style.display = 'none';

  const wrap = document.createElement('div');
  wrap.className = 'msg-wrap agent';
  const label = document.createElement('div');
  label.className = 'msg-label';
  label.textContent = 'Agent';
  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble warning';
  bubble.innerHTML = `Render disconnect kar du? (${authedUser.renderEmail || ''}) Render commands tab tak kaam nahi karenge jab tak dubara connect na karo.`;

  const actions = document.createElement('div');
  actions.className = 'confirm-actions';
  const yesBtn = document.createElement('button');
  yesBtn.className = 'confirm-btn danger';
  yesBtn.textContent = 'Haan, Disconnect Karo';
  yesBtn.onclick = async () => {
    yesBtn.disabled = true;
    noBtn.disabled = true;
    try {
      await fetch('/api/render/disconnect', { method: 'POST', credentials: 'same-origin' });
    } catch (e) {}
    authedUser.renderConnected = false;
    authedUser.renderEmail = null;
    renderRenderMenuState();
    addMessage('agent', 'Render disconnect ho gaya.', '');
  };
  const noBtn = document.createElement('button');
  noBtn.className = 'confirm-btn cancel';
  noBtn.textContent = 'Cancel';
  noBtn.onclick = () => { yesBtn.disabled = true; noBtn.disabled = true; };

  actions.appendChild(yesBtn);
  actions.appendChild(noBtn);
  bubble.appendChild(actions);
  wrap.appendChild(label);
  wrap.appendChild(bubble);
  messages.appendChild(wrap);
  scrollToBottom();
}


// ══════════════════════════════════════════════════════════════════
// CHAT PERSISTENCE (Firestore, via server/api/sessions/*) — multi-session
// Keeps multiple separate conversations across page reloads/app restarts/
// devices — this used to be pure localStorage, which meant a cleared
// browser cache or a fresh device lost every conversation. Now the
// server (server/firestore_db.py) is the source of truth; this module is
// a thin in-memory mirror (`sessionsState`) of the server's state, kept
// around so the existing render code (renderChatHistoryList,
// renderActiveChatIntoView, etc.) can stay synchronous and instant —
// every mutation updates the mirror immediately for a snappy UI, then
// fires a background call to persist it server-side. If that background
// call fails (offline, server hiccup), the in-memory chat still works
// for the rest of the session; it just won't have survived a reload.
// Each session is {id, title, messages: [{role, content, actionClass}],
// updatedAt}. Deliberately does NOT persist confirm-action buttons
// (delete/destructive prompts) — those are re-issued fresh by the server
// each time and should never be resurrected from a stale save after a
// reload.
// ══════════════════════════════════════════════════════════════════
const SESSION_MSG_MAX = 200; // cap per session, mirrors server/firestore_db.py SESSION_MSG_MAX
const SESSIONS_MAX = 50;     // cap number of sessions kept, mirrors server/firestore_db.py SESSIONS_MAX

let sessionsState = { sessions: [], activeSessionId: null };

// Fire-and-forget POST — used for the background persistence calls below.
// Swallows errors deliberately: a failed sync shouldn't surface as a user-
// facing error mid-chat, it just means this particular change didn't make
// it to the server (next successful call re-syncs the latest state anyway).
async function _syncPost(url, body) {
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
  } catch (e) { /* offline or server hiccup — in-memory state still works */ }
}

async function _syncDelete(url) {
  try {
    await fetch(url, { method: 'DELETE', credentials: 'same-origin' });
  } catch (e) { /* see _syncPost */ }
}

function titleFromMessages(messages) {
  const firstUser = messages.find(m => m.role === 'user');
  if (!firstUser) return 'Nayi Chat';
  const t = firstUser.content.trim().replace(/\s+/g, ' ');
  return t.length > 42 ? t.slice(0, 42) + '…' : t;
}

function getActiveSession() {
  if (!sessionsState.activeSessionId) return null;
  return sessionsState.sessions.find(s => s.id === sessionsState.activeSessionId) || null;
}

// ensureActiveSession() historically both "get or create" AND was called
// synchronously from saveChatEntry(). Keeping it synchronous (operating
// only on the in-memory mirror) avoids making every single message-send
// path async just to persist a session id — the background sync calls
// below (append_message etc.) create the session server-side on first
// write anyway (see append_message() in firestore_db.py), so a client-
// minted id here is fine; it just needs to be stable for this browser tab.
function ensureActiveSession() {
  let s = getActiveSession();
  if (s) return s;
  s = { id: 'sess_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8), title: 'Nayi Chat', messages: [], updatedAt: Date.now() };
  sessionsState.sessions.unshift(s);
  sessionsState.activeSessionId = s.id;
  _syncPost(`/api/sessions/${encodeURIComponent(s.id)}/active`, null);
  return s;
}

function saveChatEntry(entry) {
  const s = ensureActiveSession();
  s.messages.push(entry);
  if (s.messages.length > SESSION_MSG_MAX) s.messages.splice(0, s.messages.length - SESSION_MSG_MAX);
  if (s.messages.length === 1 && entry.role === 'user') s.title = titleFromMessages(s.messages);
  s.updatedAt = Date.now();
  if (sessionsState.sessions.length > SESSIONS_MAX) {
    sessionsState.sessions.sort((a, b) => b.updatedAt - a.updatedAt);
    sessionsState.sessions = sessionsState.sessions.slice(0, SESSIONS_MAX);
  }
  renderChatHistoryList();
  _syncPost(`/api/sessions/${encodeURIComponent(s.id)}/messages`, entry);
}

function clearSavedChat() {
  const s = getActiveSession();
  if (s) {
    s.messages = [];
    s.title = 'Nayi Chat';
    s.updatedAt = Date.now();
    renderChatHistoryList();
    _syncPost(`/api/sessions/${encodeURIComponent(s.id)}/clear`, null);
  }
}

// Wipes the visible chat area and (re)renders whichever session is
// currently active — used on load and after switching sessions.
function renderActiveChatIntoView() {
  const messages = document.getElementById('messages');
  messages.innerHTML = '';
  history.length = 0;
  resetDividerTracking();

  const s = getActiveSession();
  const es = document.getElementById('empty-state');

  if (!s || !s.messages.length) {
    if (es) es.style.display = 'flex';
    scrollToBottom();
    renderChatHistoryList();
    return;
  }

  if (es) es.style.display = 'none';

  s.messages.forEach(entry => {
    // Rich cards (file lists, repo/vercel/netlify/render grids) need their
    // structured data (items/repos/projects/etc, saved alongside content —
    // see saveChatEntry calls above) rebuilt as real DOM widgets here too,
    // not just plain markdown — otherwise they only look right until the
    // next reload. buildRichBubbleNode is the same dispatcher the live
    // /chat response path uses, so a saved entry renders identically to
    // how it looked when it first arrived.
    const richNode = entry.role === 'agent' ? buildRichBubbleNode(entry) : null;
    const { wrap, bubble } = renderMessage(entry.role, entry.content, entry.actionClass || '', entry.ts || null, entry.action || null);
    if (richNode) {
      bubble.innerHTML = '';
      bubble.appendChild(richNode);
    }
    addMessageActions(wrap, bubble, entry.role, entry.content, entry.actionClass || '', () => resendMessage(entry.content));
    history.push({ role: entry.role === 'user' ? 'user' : 'assistant', content: entry.content });
  });

  // If the conversation was left mid-confirmation (buttons intentionally
  // aren't persisted — see the note above SESSIONS_KEY), let the user know
  // instead of leaving them wondering where the Yes/Cancel buttons went.
  const last = s.messages[s.messages.length - 1];
  if (last && last.role === 'agent' && /pakka|confirm|sure\?|delete karna/i.test(last.content)) {
    renderMessage('agent', '_(Ye confirmation expire ho gaya — command dobara bhejo agar abhi bhi karna hai.)_', 'warning');
  }

  scrollToBottom();
  renderChatHistoryList();
}

async function restoreChatOnLoad() {
  try {
    const res = await fetch('/api/sessions', { credentials: 'same-origin' });
    if (res.ok) {
      const state = await res.json();
      if (state && Array.isArray(state.sessions)) {
        // Defensive: guarantee every session has a messages array, even
        // if a doc somehow lacks one — every render path below assumes
        // s.messages exists without re-checking.
        state.sessions.forEach(s => { if (!Array.isArray(s.messages)) s.messages = []; });
        sessionsState = state;
      }
    }
  } catch (e) {
    // Offline or not logged in yet — fall back to a fresh empty session so
    // the chat UI still works; ensureActiveSession() below mints one
    // locally and it'll sync once connectivity/login is available.
  }
  ensureActiveSession();
  renderActiveChatIntoView();
}

function startNewChatSession() {
  vibrate(10);
  const s = { id: 'sess_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8), title: 'Nayi Chat', messages: [], updatedAt: Date.now() };
  sessionsState.sessions.unshift(s);
  sessionsState.activeSessionId = s.id;
  renderActiveChatIntoView();
  closeDrawer();
  _syncPost(`/api/sessions/${encodeURIComponent(s.id)}/active`, null);
}

function switchToSession(id) {
  if (id === sessionsState.activeSessionId) { closeDrawer(); return; }
  vibrate(10);
  sessionsState.activeSessionId = id;
  renderActiveChatIntoView();
  closeDrawer();
  _syncPost(`/api/sessions/${encodeURIComponent(id)}/active`, null);
}

function deleteSession(id) {
  sessionsState.sessions = sessionsState.sessions.filter(s => s.id !== id);
  if (sessionsState.activeSessionId === id) {
    sessionsState.activeSessionId = sessionsState.sessions.length ? sessionsState.sessions[0].id : null;
  }
  renderChatHistoryList();
  // If we just deleted the active session, the view needs to reflect
  // whatever session (or empty state) is now active.
  if (!getActiveSession() || sessionsState.activeSessionId !== id) {
    renderActiveChatIntoView();
  }
  _syncDelete(`/api/sessions/${encodeURIComponent(id)}`);
}

function renderChatHistoryList() {
  const list = document.getElementById('chat-hist-list');
  if (!list) return;
  list.innerHTML = '';

  const sorted = [...sessionsState.sessions].sort((a, b) => b.updatedAt - a.updatedAt);

  if (!sorted.length) {
    list.innerHTML = '<div class="chat-hist-empty">Koi purani chat nahi hai.</div>';
    return;
  }

  sorted.forEach(s => {
    const item = document.createElement('div');
    item.className = 'chat-hist-item' + (s.id === sessionsState.activeSessionId ? ' active' : '');
    item.onclick = () => switchToSession(s.id);

    const icon = document.createElement('div');
    icon.className = 'chat-hist-icon';
    icon.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>`;

    const info = document.createElement('div');
    info.className = 'chat-hist-info';
    const title = document.createElement('div');
    title.className = 'chat-hist-title';
    title.textContent = s.title || 'Nayi Chat';
    const meta = document.createElement('div');
    meta.className = 'chat-hist-meta';
    meta.textContent = `${s.messages.length} messages · ${timeAgo(s.updatedAt)}`;
    info.appendChild(title);
    info.appendChild(meta);

    const delBtn = document.createElement('button');
    delBtn.className = 'chat-hist-delete';
    delBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6h14z"/></svg>`;
    delBtn.onclick = (e) => {
      e.stopPropagation();
      vibrate(12);
      if (confirm(`"${s.title}" delete karein? Ye wapas nahi aayega.`)) {
        deleteSession(s.id);
      }
    };

    item.appendChild(icon);
    item.appendChild(info);
    item.appendChild(delBtn);
    list.appendChild(item);
  });
}

function timeAgo(ts) {
  const diff = Math.max(0, Date.now() - ts);
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'abhi';
  if (mins < 60) return `${mins}m pehle`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h pehle`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d pehle`;
  return new Date(ts).toLocaleDateString();
}

// ══════════════════════════════════════════════════════════════════
// COMMAND AUTOFILL — mirrors server.py INTENT_RULES for this multi-tenant
// build. GitHub commands always show; Vercel commands only show once the
// user has connected Vercel (checked at render time via authedUser).
// ══════════════════════════════════════════════════════════════════
const COMMANDS = [
  { id: 'LIST_FILES',   tpl: 'list files in {repo}',                          desc: 'GitHub · list files in a repo',        kw: ['list','files','file','sare','dikhao','repo'] },
  { id: 'READ_FILE',    tpl: 'read file {path} from {repo}',                  desc: 'GitHub · read a file',                 kw: ['read','padho','file','open','kholo'] },
  { id: 'DELETE_FILE',  tpl: 'delete file {path} from {repo}',                desc: 'GitHub · delete a file',               kw: ['delete','uda','hata','remove','file'] },
  { id: 'EDIT_FILE',    tpl: 'edit file {path} in {repo}',                    desc: 'GitHub · edit/update a file (AI content)', kw: ['edit','update','change','badlo','file'] },
  { id: 'CREATE_FILE',  tpl: 'create file {path} in {repo}',                  desc: 'GitHub · create a new file (AI content)',  kw: ['create','banao','naya','file','new'] },

  { id: 'CREATE_REPO',  tpl: 'create repo {repo}',                            desc: 'GitHub · create a new repository',     kw: ['create','banao','naya','repo','repository'] },
  { id: 'DELETE_REPO',  tpl: 'delete repo {repo}',                            desc: 'GitHub · delete a repository ⚠️',      kw: ['delete','uda','hata','remove','repo'] },
  { id: 'LIST_REPOS',   tpl: 'list all my repos',                             desc: 'GitHub · list all repositories',       kw: ['list','sare','mere','repos','show'] },
  { id: 'GET_REPO_INFO', tpl: 'info about {repo}',                            desc: 'GitHub · get repo details',            kw: ['info','information','details','repo'] },

  // ── VERCEL (only surfaced in suggestions once connected — see
  // renderSuggestions' filter below) ──
  { id: 'VERCEL_LIST',  tpl: 'list vercel projects',                          desc: 'Vercel · list all projects',           kw: ['list','vercel','projects','sare','dikhao'], vercel: true },
  { id: 'VERCEL_IMPORT', tpl: 'import {repo} to vercel',                      desc: 'Vercel · import a GitHub repo',        kw: ['import','connect','vercel','repo'], vercel: true },
  { id: 'VERCEL_DEPLOY', tpl: 'deploy {project_name} to vercel',              desc: 'Vercel · deploy a project',            kw: ['deploy','vercel','project'], vercel: true },
  { id: 'VERCEL_DELETE', tpl: 'delete vercel project {project_name}',         desc: 'Vercel · delete a project ⚠️',         kw: ['delete','uda','hata','vercel','project'], vercel: true },
  { id: 'VERCEL_ENV_GET', tpl: 'get env for {project_name} vercel',           desc: 'Vercel · view environment variables',  kw: ['env','environment','vars','get','show','vercel'], vercel: true },
  { id: 'VERCEL_ENV_SET', tpl: 'set vercel env {KEY}={value} for {project_name}', desc: 'Vercel · set an environment variable', kw: ['set','env','vercel','add','update'], vercel: true },
  { id: 'VERCEL_LIST_DEPLOYMENTS', tpl: 'list deployments for {project_name} vercel', desc: 'Vercel · list recent production deployments', kw: ['deployments','history','list','vercel','recent'], vercel: true },
  { id: 'VERCEL_ROLLBACK', tpl: 'rollback {project_name} to previous version', desc: 'Vercel · roll back to a previous deployment ⚠️', kw: ['rollback','revert','undo','previous','pichli','vercel'], vercel: true },

  // ── AI CODE GENERATION (multi-file, no provider gate) ──
  { id: 'CODE_GENERATE', tpl: 'build {feature} in {repo}',                    desc: 'AI · generate/edit code across the repo', kw: ['build','banao','code','editor','edit','fix','feature','create','refactor'] },

  // ── NETLIFY (only surfaced once connected) ──
  { id: 'NETLIFY_LIST',  tpl: 'list netlify sites',                          desc: 'Netlify · list all sites',             kw: ['list','netlify','sites','sare','dikhao'], netlify: true },
  { id: 'NETLIFY_INFO',  tpl: 'info about netlify site {site_name}',         desc: 'Netlify · get site details',           kw: ['info','information','details','netlify','site'], netlify: true },
  { id: 'NETLIFY_DELETE', tpl: 'delete netlify site {site_name}',            desc: 'Netlify · delete a site ⚠️',           kw: ['delete','uda','hata','netlify','site'], netlify: true },
  { id: 'NETLIFY_ENV_GET', tpl: 'get env for {site_name} netlify',           desc: 'Netlify · view environment variables', kw: ['env','environment','vars','get','show','netlify'], netlify: true },
  { id: 'NETLIFY_ENV_SET', tpl: 'set netlify env {KEY}={value} for {site_name}', desc: 'Netlify · set an environment variable', kw: ['set','env','netlify','add','update'], netlify: true },

  // ── RENDER (only surfaced once connected) ──
  { id: 'RENDER_LIST',  tpl: 'list render services',                         desc: 'Render · list all services',           kw: ['list','render','services','sare','dikhao'], render: true },
  { id: 'RENDER_DELETE', tpl: 'delete service {service_id}',                 desc: 'Render · delete a service ⚠️',         kw: ['delete','uda','hata','render','service'], render: true },
  { id: 'RENDER_ENV_GET', tpl: 'get env for {service_id} render',            desc: 'Render · view environment variables',  kw: ['env','environment','vars','get','show','render'], render: true },
  { id: 'RENDER_ENV_SET', tpl: 'set render env {KEY}={value} for {service_id}', desc: 'Render · set an environment variable', kw: ['set','env','render','add','update'], render: true },
  { id: 'RENDER_DEPLOY', tpl: 'deploy {service_id} to render',               desc: 'Render · trigger a deploy',            kw: ['deploy','render','service'], render: true },
];

// ── AUTOFILL STATE ──
let suggestIndex = -1;   // currently highlighted suggestion (keyboard nav)
let activeSuggestions = [];

function onInputChange() {
  const input = document.getElementById('userInput');
  renderSuggestions(input.value);
}

// Lightweight fuzzy match: scores by how many typed words appear as a
// substring in the template text or its keyword list. No network calls,
// no build step — just string scanning against the static COMMANDS list.
function scoreCommand(cmd, queryWords) {
  const haystack = ((cmd.tpl || '') + ' ' + cmd.desc + ' ' + cmd.kw.join(' ')).toLowerCase();
  let score = 0;
  for (const w of queryWords) {
    if (!w) continue;
    if (haystack.includes(w)) score += w.length >= 3 ? 2 : 1;
  }
  return score;
}

function renderSuggestions(rawValue) {
  const panel = document.getElementById('suggest-panel');
  const value = rawValue.trim();

  if (!value) {
    panel.classList.remove('show');
    panel.innerHTML = '';
    activeSuggestions = [];
    suggestIndex = -1;
    return;
  }

  const queryWords = value.toLowerCase().split(/\s+/).filter(Boolean);
  const vercelReady = !!(authedUser && authedUser.vercelConnected);
  const netlifyReady = !!(authedUser && authedUser.netlifyConnected);
  const renderReady = !!(authedUser && authedUser.renderConnected);
  const scored = COMMANDS
    .filter(cmd => (!cmd.vercel || vercelReady) && (!cmd.netlify || netlifyReady) && (!cmd.render || renderReady))
    .map(cmd => ({ cmd, score: scoreCommand(cmd, queryWords) }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);

  activeSuggestions = scored.map(x => x.cmd);
  suggestIndex = -1;

  if (activeSuggestions.length === 0) {
    panel.classList.remove('show');
    panel.innerHTML = '';
    return;
  }

  panel.innerHTML = '';
  const label = document.createElement('div');
  label.className = 'suggest-group-label';
  label.textContent = 'Commands';
  panel.appendChild(label);

  activeSuggestions.forEach((cmd, i) => {
    const item = document.createElement('div');
    item.className = 'suggest-item';
    item.dataset.index = i;

    const tplEl = document.createElement('div');
    tplEl.className = 'tpl';
    tplEl.innerHTML = highlightTemplate(cmd.tpl, queryWords);

    const descEl = document.createElement('div');
    descEl.className = 'desc';
    descEl.textContent = cmd.desc;

    item.appendChild(tplEl);
    item.appendChild(descEl);
    item.onclick = () => applySuggestion(cmd);

    panel.appendChild(item);
  });

  panel.classList.add('show');
}

// Renders the template with {placeholders} styled distinctly, and any
// matched query words underlined so the user sees why it matched.
function highlightTemplate(tpl, queryWords) {
  let out = escHtml(tpl);
  out = out.replace(/\{([a-zA-Z_]+)\}/g, '<span class="ph">$1</span>');
  queryWords.forEach(w => {
    if (w.length < 2) return;
    const safe = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`(${safe})(?![^<]*>)`, 'gi'), '<span class="hl">$1</span>');
  });
  return out;
}

// ══════════════════════════════════════════════════════════════════
// STRUCTURED COMMAND FORMS
// Selecting a suggestion no longer dumps a raw "{repo}" text template
// into the input for manual typing. Instead it opens an in-chat form
// bubble (same visual pattern as the file-upload flow) with one field
// per placeholder. Fields with a known live data source — repo, path,
// vercel project, render service — render as a searchable dropdown
// pre-filled from the backend; everything else stays a plain text
// input. On submit, the template placeholders are substituted and the
// resulting sentence is sent through the normal sendMsg() pipeline —
// the backend's regex intent parser is untouched.
// ══════════════════════════════════════════════════════════════════

// Maps a {placeholder} name (+ the owning command id, for the few cases
// that need to disambiguate) to a field "kind". Add new mappings here as
// new live sources appear.
function placeholderKind(name, cmdId) {
  if (name === 'repo') return 'repo';
  if (name === 'project_name') return 'vercel_project';
  if (name === 'path') {
    // CREATE_FILE's {path} is a brand-new file that doesn't exist yet —
    // showing existing files as suggestions would be misleading, so it
    // stays a plain text field. READ/EDIT/DELETE FILE genuinely pick from
    // what's already in the repo.
    return cmdId === 'CREATE_FILE' ? 'new_path' : 'path';
  }
  return 'text';
}

function placeholderLabel(name) {
  const labels = {
    repo: 'Repository', path: 'File path', message: 'Message',
    project_name: 'Vercel project', KEY: 'Env key', value: 'Env value',
  };
  return labels[name] || name.replace(/_/g, ' ');
}

// ── APPLY SUGGESTION: open a structured form bubble for this command ──
function applySuggestion(cmd) {
  hideSuggestions();
  const input = document.getElementById('userInput');
  input.value = '';
  autoResize(input);

  const placeholders = [...new Set((cmd.tpl.match(/\{([a-zA-Z_]+)\}/g) || []).map(p => p.slice(1, -1)))];

  // No placeholders at all (e.g. "list all my repos") — just send it.
  if (placeholders.length === 0) {
    input.value = cmd.tpl;
    autoResize(input);
    input.focus();
    return;
  }

  buildCommandFormBubble(cmd, placeholders);
}

// Builds the in-chat form bubble: one row per placeholder, a Run
// button that substitutes values into cmd.tpl and sends it.
function buildCommandFormBubble(cmd, placeholders) {
  const es = document.getElementById('empty-state');
  if (es) es.style.display = 'none';

  const messages = document.getElementById('messages');
  const wrap = document.createElement('div');
  wrap.className = 'msg-wrap agent';

  const label = document.createElement('div');
  label.className = 'msg-label';
  label.textContent = 'Agent';

  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble info';
  bubble.innerHTML = `<strong>${escHtml(cmd.desc)}</strong>`;

  const form = document.createElement('div');
  form.className = 'prompt-form';

  // fieldRefs[name] = { input, kind, datalist? }
  const fieldRefs = {};

  placeholders.forEach(name => {
    const kind = placeholderKind(name, cmd.id);
    const fieldWrap = document.createElement('div');

    const fieldLabel = document.createElement('div');
    fieldLabel.className = 'prompt-hint';
    fieldLabel.textContent = placeholderLabel(name);
    fieldWrap.appendChild(fieldLabel);

    const listId = `field-list-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const datalist = document.createElement('datalist');
    datalist.id = listId;

    const inputEl = document.createElement('input');
    inputEl.type = 'text';
    inputEl.placeholder = placeholderLabel(name);
    inputEl.autocomplete = 'off';

    if (kind === 'repo') {
      inputEl.setAttribute('list', listId);
      getRepoNames().then(names => fillDatalist(datalist, names));
    } else if (kind === 'vercel_project') {
      inputEl.setAttribute('list', listId);
      getVercelProjectNames().then(names => fillDatalist(datalist, names));
    } else if (kind === 'path') {
      inputEl.setAttribute('list', listId);
      inputEl.placeholder = 'file path (pick a repo first)';
    } else if (kind === 'new_path') {
      inputEl.placeholder = 'e.g. src/newfile.js';
    }

    fieldWrap.appendChild(inputEl);
    fieldWrap.appendChild(datalist);
    form.appendChild(fieldWrap);
    fieldRefs[name] = { input: inputEl, kind, datalist };
  });

  // If both a repo field and a real (existing-file) path field exist,
  // refresh the path datalist whenever the repo field changes — same
  // live-lookup pattern as the upload flow's askUploadPath step. Skipped
  // for CREATE_FILE's 'new_path' kind, which has no datalist to refresh.
  if (fieldRefs.repo && fieldRefs.path && fieldRefs.path.kind === 'path') {
    fieldRefs.repo.input.addEventListener('change', () => {
      const repo = fieldRefs.repo.input.value.trim();
      if (!repo) return;
      fetch(`/api/repo-files?repo=${encodeURIComponent(repo)}`)
        .then(r => r.json())
        .then(data => fillDatalist(fieldRefs.path.datalist, data.files || []))
        .catch(() => {});
    });
  }

  const actions = document.createElement('div');
  actions.className = 'prompt-actions';

  const goBtn = document.createElement('button');
  goBtn.className = 'prompt-btn go';
  goBtn.textContent = 'Run →';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'prompt-btn cancel';
  cancelBtn.textContent = 'Cancel';

  const submit = () => {
    let sentence = cmd.tpl;
    for (const name of placeholders) {
      let val = fieldRefs[name].input.value.trim();
      if (!val) { fieldRefs[name].input.focus(); return; }
      // Render service dropdown shows "name (id)" — extract just the id.
      if (fieldRefs[name].kind === 'render_service') {
        const idMatch = val.match(/\(([^)]+)\)\s*$/);
        if (idMatch) val = idMatch[1];
      }
      sentence = sentence.replace(`{${name}}`, val);
    }
    goBtn.disabled = true;
    cancelBtn.disabled = true;
    Object.values(fieldRefs).forEach(f => { f.input.disabled = true; });
    const input = document.getElementById('userInput');
    input.value = sentence;
    autoResize(input);
    sendMsg();
  };

  goBtn.onclick = submit;
  cancelBtn.onclick = () => {
    goBtn.disabled = true;
    cancelBtn.disabled = true;
    Object.values(fieldRefs).forEach(f => { f.input.disabled = true; });
    addMessage('agent', 'Theek hai, cancel kar diya.', '');
  };

  actions.appendChild(goBtn);
  actions.appendChild(cancelBtn);
  form.appendChild(actions);
  bubble.appendChild(form);

  wrap.appendChild(label);
  wrap.appendChild(bubble);
  messages.appendChild(wrap);
  scrollToBottom();

  const firstInput = form.querySelector('input');
  if (firstInput) firstInput.focus();
}

function hideSuggestions() {
  const panel = document.getElementById('suggest-panel');
  panel.classList.remove('show');
  panel.innerHTML = '';
  activeSuggestions = [];
  suggestIndex = -1;
}

// Finds the next {placeholder} at/after `fromPos` and selects its inner
// text (including braces removed) so typing immediately replaces it —
// snippet-editor style. Returns true if a placeholder was found.
function selectNextPlaceholder(input, fromPos) {
  const val = input.value;
  const re = /\{[a-zA-Z_]+\}/g;
  re.lastIndex = fromPos;
  const match = re.exec(val);
  if (!match) return false;

  const start = match.index;
  const end = start + match[0].length;
  // Replace "{repo}" with "repo" (strip braces) and select it in place.
  const inner = match[0].slice(1, -1);
  input.value = val.slice(0, start) + inner + val.slice(end);
  input.setSelectionRange(start, start + inner.length);
  autoResize(input);
  return true;
}

function jumpToNextPlaceholder() {
  const input = document.getElementById('userInput');
  const found = selectNextPlaceholder(input, input.selectionEnd || 0);
  if (!found) {
    // No more placeholders — just place cursor at the end.
    input.setSelectionRange(input.value.length, input.value.length);
  }
}

document.addEventListener('click', (e) => {
  const panel = document.getElementById('suggest-panel');
  const input = document.getElementById('userInput');
  if (!panel.contains(e.target) && e.target !== input) {
    hideSuggestions();
  }
});

// ── ATTACH MENU (files / folder / zip picker) ──
function toggleAttachMenu() {
  const menu = document.getElementById('attach-menu');
  menu.classList.toggle('show');
}
function hideAttachMenu() {
  document.getElementById('attach-menu').classList.remove('show');
}
document.addEventListener('click', (e) => {
  const menu = document.getElementById('attach-menu');
  const clipBtn = document.querySelector('.clip-btn');
  if (menu.classList.contains('show') && !menu.contains(e.target) && e.target !== clipBtn && !clipBtn.contains(e.target)) {
    hideAttachMenu();
  }
});

// ── TEXTAREA AUTO RESIZE ──
function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}

// ── KEY HANDLER ──
function handleKey(e) {
  const panelOpen = document.getElementById('suggest-panel').classList.contains('show');

  // Navigate suggestion list with arrow keys while panel is open.
  if (panelOpen && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
    e.preventDefault();
    moveSuggestIndex(e.key === 'ArrowDown' ? 1 : -1);
    return;
  }

  // Enter selects the highlighted suggestion if one is active;
  // otherwise falls through to normal send behavior.
  if (panelOpen && e.key === 'Enter' && !e.shiftKey && suggestIndex >= 0) {
    e.preventDefault();
    applySuggestion(activeSuggestions[suggestIndex]);
    return;
  }

  if (e.key === 'Escape' && panelOpen) {
    e.preventDefault();
    hideSuggestions();
    return;
  }

  // Tab jumps to the next {placeholder} in the input instead of
  // shifting focus away — makes filling multi-field commands fast.
  if (e.key === 'Tab' && !panelOpen) {
    const input = e.target;
    if (/\{[a-zA-Z_]+\}/.test(input.value)) {
      e.preventDefault();
      jumpToNextPlaceholder();
      return;
    }
  }

  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMsg();
  }
}

function moveSuggestIndex(delta) {
  if (activeSuggestions.length === 0) return;
  const items = document.querySelectorAll('#suggest-panel .suggest-item');
  items.forEach(el => el.classList.remove('active'));

  suggestIndex += delta;
  if (suggestIndex < 0) suggestIndex = activeSuggestions.length - 1;
  if (suggestIndex >= activeSuggestions.length) suggestIndex = 0;

  const el = items[suggestIndex];
  if (el) {
    el.classList.add('active');
    el.scrollIntoView({ block: 'nearest' });
  }
}

function fillInput(text) {
  const input = document.getElementById('userInput');
  input.value = text;
  input.focus();
  autoResize(input);
  hideSuggestions();
}

// ── FILE UPLOAD (attach button) ──
// Remembers the last repo/path the user typed, so repeat uploads to the
// same place don't re-prompt every time.
let lastUploadRepo = '';
let lastUploadDir = '';

function onFilePicked(event) {
  const files = Array.from(event.target.files || []);
  event.target.value = ''; // allow picking the same file(s) again later
  if (!files.length) return;
  askUploadRepo(files);
}

// Folder picker (webkitdirectory) — browser gives us every file inside the
// chosen folder (recursively) with .webkitRelativePath set on each, so the
// nested structure comes along for free. Reuses the exact same
// askUploadRepo → askUploadPath → doUploadMany pipeline as regular
// multi-file upload; askUploadPath's relPath() helper below does the work
// of preserving subfolders instead of flattening everything to the root.
function onFolderPicked(event) {
  const files = Array.from(event.target.files || []);
  event.target.value = '';
  if (!files.length) return;
  askUploadRepo(files);
}

// Zip picker — routed to a separate flow since it needs its own /upload-zip
// endpoint (server extracts it), not the per-file /upload endpoint.
function onZipPicked(event) {
  const files = Array.from(event.target.files || []);
  event.target.value = '';
  if (!files.length) return;
  const file = files[0];
  if (!/\.zip$/i.test(file.name)) {
    addMessage('agent', '❌ Ye zip file nahi lag rahi. `.zip` extension chahiye.', 'error');
    return;
  }
  askZipUploadRepo(file);
}

// Cache repo names once per page load (refreshed lazily on each upload flow start).
let cachedRepoNames = null;
let repoNamesFetchPromise = null;

function getRepoNames() {
  if (cachedRepoNames) return Promise.resolve(cachedRepoNames);
  if (repoNamesFetchPromise) return repoNamesFetchPromise;
  repoNamesFetchPromise = fetch('/api/repos')
    .then(r => r.json())
    .then(data => { cachedRepoNames = data.repos || []; return cachedRepoNames; })
    .catch(() => []);
  return repoNamesFetchPromise;
}

// Same cache-once pattern as getRepoNames() above, for the Vercel
// {project_name} field. Only meaningful once Vercel is connected — the
// endpoint itself returns an empty list otherwise, so this just quietly
// yields no suggestions rather than erroring.
let cachedVercelProjectNames = null;
let vercelProjectNamesFetchPromise = null;

function getVercelProjectNames() {
  if (cachedVercelProjectNames) return Promise.resolve(cachedVercelProjectNames);
  if (vercelProjectNamesFetchPromise) return vercelProjectNamesFetchPromise;
  vercelProjectNamesFetchPromise = fetch('/api/vercel-projects')
    .then(r => r.json())
    .then(data => { cachedVercelProjectNames = data.projects || []; return cachedVercelProjectNames; })
    .catch(() => []);
  return vercelProjectNamesFetchPromise;
}

function fillDatalist(datalistEl, items) {
  datalistEl.innerHTML = '';
  items.forEach(v => {
    const opt = document.createElement('option');
    opt.value = v;
    datalistEl.appendChild(opt);
  });
}

// Step 1: ask which repo, as an in-chat form bubble (not a native prompt).
function askUploadRepo(files) {
  const es = document.getElementById('empty-state');
  if (es) es.style.display = 'none';

  const messages = document.getElementById('messages');
  const wrap = document.createElement('div');
  wrap.className = 'msg-wrap agent';

  const label = document.createElement('div');
  label.className = 'msg-label';
  label.textContent = 'Agent';

  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble info';
  const filesDesc = files.length === 1
    ? `<strong>${escHtml(files[0].name)}</strong>`
    : `<strong>${files.length} files</strong> (${escHtml(files.map(f => f.name).join(', '))})`;
  bubble.innerHTML = `📎 ${filesDesc} select hui hai${files.length > 1 ? 'n' : ''}. Kis repo me upload karni hai${files.length > 1 ? 'n' : ''}?`;

  const form = document.createElement('div');
  form.className = 'prompt-form';

  const listId = 'repo-list-' + Date.now();
  const datalist = document.createElement('datalist');
  datalist.id = listId;

  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'repo-name';
  input.value = lastUploadRepo;
  input.setAttribute('list', listId);
  input.autocomplete = 'off';

  getRepoNames().then(names => fillDatalist(datalist, names));

  const actions = document.createElement('div');
  actions.className = 'prompt-actions';

  const goBtn = document.createElement('button');
  goBtn.className = 'prompt-btn go';
  goBtn.textContent = 'Next →';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'prompt-btn cancel';
  cancelBtn.textContent = 'Cancel';

  const submit = () => {
    const repo = input.value.trim();
    if (!repo) { input.focus(); return; }
    goBtn.disabled = true;
    cancelBtn.disabled = true;
    input.disabled = true;
    lastUploadRepo = repo;
    askUploadPath(files, repo);
  };

  goBtn.onclick = submit;
  input.onkeydown = (e) => { if (e.key === 'Enter') submit(); };
  cancelBtn.onclick = () => {
    goBtn.disabled = true;
    cancelBtn.disabled = true;
    input.disabled = true;
    addMessage('agent', 'Theek hai, upload cancel kar diya.', '');
  };

  actions.appendChild(goBtn);
  actions.appendChild(cancelBtn);
  form.appendChild(input);
  form.appendChild(datalist);
  form.appendChild(actions);
  bubble.appendChild(form);

  wrap.appendChild(label);
  wrap.appendChild(bubble);
  messages.appendChild(wrap);
  scrollToBottom();
  input.focus();
}

// Step 2: ask which folder inside that repo (blank = repo root).
function askUploadPath(files, repo) {
  const messages = document.getElementById('messages');
  const wrap = document.createElement('div');
  wrap.className = 'msg-wrap agent';

  const label = document.createElement('div');
  label.className = 'msg-label';
  label.textContent = 'Agent';

  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble info';
  bubble.innerHTML = `<strong>${escHtml(repo)}</strong> me kis folder me daalni hai? Khaali chhodo root ke liye.`;

  const form = document.createElement('div');
  form.className = 'prompt-form';

  const listId = 'folder-list-' + Date.now();
  const datalist = document.createElement('datalist');
  datalist.id = listId;

  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'folder (optional)';
  input.value = lastUploadDir;
  input.setAttribute('list', listId);
  input.autocomplete = 'off';

  fetch(`/api/repo-folders?repo=${encodeURIComponent(repo)}`)
    .then(r => r.json())
    .then(data => fillDatalist(datalist, data.folders || []))
    .catch(() => {});

  const hint = document.createElement('div');
  hint.className = 'prompt-hint';
  hint.id = 'upload-path-hint';

  // For a folder-picker selection each File carries webkitRelativePath
  // (e.g. "my-folder/src/index.js") which preserves the nested structure.
  // We drop only the top-level picked-folder name — the destination
  // folder the user types here replaces it — so subfolders inside stay intact.
  const relPath = (f) => {
    if (f.webkitRelativePath) {
      const parts = f.webkitRelativePath.split('/');
      return parts.slice(1).join('/') || f.name;
    }
    return f.name;
  };
  const buildDestList = (dir) => files.map(f => dir ? `${dir}/${relPath(f)}` : relPath(f));
  const updateHint = () => {
    const dir = input.value.trim().replace(/^\/+|\/+$/g, '');
    const dests = buildDestList(dir);
    if (dests.length === 1) {
      hint.textContent = `Save hogi: ${dests[0]}`;
    } else if (dests.length <= 8) {
      hint.textContent = `${dests.length} files save hongi:\n${dests.join('\n')}`;
    } else {
      hint.textContent = `${dests.length} files save hongi (structure preserve hoga):\n${dests.slice(0, 6).join('\n')}\n… +${dests.length - 6} more`;
    }
    hint.style.whiteSpace = 'pre-line';
  };
  input.oninput = updateHint;
  updateHint();

  const actions = document.createElement('div');
  actions.className = 'prompt-actions';

  const goBtn = document.createElement('button');
  goBtn.className = 'prompt-btn go';
  goBtn.textContent = files.length === 1 ? 'Upload' : `Upload ${files.length} files`;

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'prompt-btn cancel';
  cancelBtn.textContent = 'Cancel';

  const submit = () => {
    goBtn.disabled = true;
    cancelBtn.disabled = true;
    input.disabled = true;
    const dir = input.value.trim().replace(/^\/+|\/+$/g, '');
    lastUploadDir = dir;
    const paths = buildDestList(dir);
    doUploadMany(files, repo, paths);
  };

  goBtn.onclick = submit;
  input.onkeydown = (e) => { if (e.key === 'Enter') submit(); };
  cancelBtn.onclick = () => {
    goBtn.disabled = true;
    cancelBtn.disabled = true;
    input.disabled = true;
    addMessage('agent', 'Theek hai, upload cancel kar diya.', '');
  };

  actions.appendChild(goBtn);
  actions.appendChild(cancelBtn);
  form.appendChild(input);
  form.appendChild(datalist);
  form.appendChild(hint);
  form.appendChild(actions);
  bubble.appendChild(form);

  wrap.appendChild(label);
  wrap.appendChild(bubble);
  messages.appendChild(wrap);
  scrollToBottom();
  input.focus();
}

// Step 3: actually send one file.
// ══════════════════════════════════════════════════════════════════
// UPLOAD PROGRESS — shared XHR wrapper (fetch() has no upload progress
// events) + a small SVG ring rendered as a chat bubble while it runs.
// ══════════════════════════════════════════════════════════════════
function xhrUploadWithProgress(url, formData, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) {
        onProgress(Math.round((e.loaded / e.total) * 100));
      }
    };
    xhr.onload = () => {
      let data;
      try { data = JSON.parse(xhr.responseText); } catch (_) { data = { reply: 'Server se invalid response aaya.', action: 'error' }; }
      resolve({ status: xhr.status, data });
    };
    xhr.onerror = () => reject(new Error('network error'));
    xhr.send(formData);
  });
}

const RING_RADIUS = 13;
const RING_CIRC = 2 * Math.PI * RING_RADIUS;

// Renders a progress-ring bubble into the messages list and returns
// {update(pct), setLabel(text, indeterminate), remove()} to drive it.
function showUploadProgress(label) {
  const messages = document.getElementById('messages');
  const es = document.getElementById('empty-state');
  if (es) es.style.display = 'none';

  const wrap = document.createElement('div');
  wrap.className = 'upload-progress-wrap';
  wrap.innerHTML = `
    <div class="upload-progress-ring-box">
      <svg class="upload-progress-ring" width="32" height="32" viewBox="0 0 32 32">
        <circle class="ring-track" cx="16" cy="16" r="${RING_RADIUS}"></circle>
        <circle class="ring-fill" cx="16" cy="16" r="${RING_RADIUS}"
          stroke-dasharray="${RING_CIRC}" stroke-dashoffset="${RING_CIRC}"></circle>
      </svg>
      <div class="upload-progress-pct">0%</div>
    </div>
    <div class="upload-progress-info">
      <div class="upload-progress-name">${escHtml(label)}</div>
      <div class="upload-progress-sub">Uploading…</div>
    </div>
  `;
  messages.appendChild(wrap);
  scrollToBottom();

  const fillEl = wrap.querySelector('.ring-fill');
  const pctEl = wrap.querySelector('.upload-progress-pct');
  const subEl = wrap.querySelector('.upload-progress-sub');
  let spinTimer = null;

  return {
    update(pct) {
      clearInterval(spinTimer);
      spinTimer = null;
      const clamped = Math.max(0, Math.min(100, pct));
      fillEl.style.strokeDasharray = `${RING_CIRC}`;
      fillEl.style.strokeDashoffset = `${RING_CIRC * (1 - clamped / 100)}`;
      pctEl.textContent = `${clamped}%`;
      subEl.textContent = clamped >= 100 ? 'Processing…' : 'Uploading…';
    },
    setLabel(text, indeterminate) {
      subEl.textContent = text;
      if (indeterminate && !spinTimer) {
        // Small indeterminate spin so the ring doesn't look frozen while
        // the server does post-upload work (e.g. zip extraction) that
        // has no progress signal of its own.
        pctEl.textContent = '';
        let offset = 0;
        spinTimer = setInterval(() => {
          offset = (offset + RING_CIRC * 0.08) % RING_CIRC;
          fillEl.style.strokeDasharray = `${RING_CIRC * 0.25} ${RING_CIRC}`;
          fillEl.style.strokeDashoffset = `${-offset}`;
        }, 60);
      }
    },
    remove() {
      clearInterval(spinTimer);
      wrap.remove();
    },
  };
}

async function doUpload(file, repo, path) {
  addMessage('user', `📎 Uploading "${file.name}" → ${repo}/${path}`);

  isLoading = true;
  document.getElementById('sendBtn').disabled = true;

  const ring = showUploadProgress(file.name);
  scrollToBottom();

  try {
    const form = new FormData();
    form.append('file', file);
    form.append('repo', repo);
    form.append('path', path);
    form.append('message', `Upload ${path} via DevOps Agent`);

    const { status, data } = await xhrUploadWithProgress('/upload', form, ring.update);
    ring.remove();

    const cls = actionColorFor(data.action);
    addMessage('agent', data.reply, cls, null, data.action);
    history.push({ role: 'assistant', content: data.reply });
  } catch (err) {
    ring.remove();
    addMessage('agent', '❌ Upload fail ho gaya. Server se connect nahi ho paya.', 'error');
  } finally {
    isLoading = false;
    document.getElementById('sendBtn').disabled = false;
  }
}

// Step 3 (multi-file): upload one at a time — sequential, so GitHub's API
// isn't hit with a burst of concurrent PUTs, and a failure on one file
// doesn't stop the rest from going through. Ends with a summary line.
async function doUploadMany(files, repo, paths) {
  if (files.length === 1) {
    await doUpload(files[0], repo, paths[0]);
    return;
  }

  addMessage('user', `📎 Uploading ${files.length} files → ${repo}${paths[0].includes('/') ? '/' + paths[0].split('/').slice(0, -1).join('/') : ''}`);

  isLoading = true;
  document.getElementById('sendBtn').disabled = true;

  let okCount = 0;
  const failed = [];

  for (let i = 0; i < files.length; i++) {
    const ring = showUploadProgress(`${files[i].name} (${i + 1}/${files.length})`);
    scrollToBottom();
    try {
      const form = new FormData();
      form.append('file', files[i]);
      form.append('repo', repo);
      form.append('path', paths[i]);
      form.append('message', `Upload ${paths[i]} via DevOps Agent`);

      const { status, data } = await xhrUploadWithProgress('/upload', form, ring.update);
      ring.remove();

      if (status >= 200 && status < 300) {
        okCount++;
        addMessage('agent', data.reply, actionColorFor(data.action));
      } else {
        failed.push(files[i].name);
        addMessage('agent', data.reply, 'error');
      }
      history.push({ role: 'assistant', content: data.reply });
    } catch (err) {
      ring.remove();
      failed.push(files[i].name);
      addMessage('agent', `❌ "${files[i].name}" upload fail ho gaya. Server se connect nahi ho paya.`, 'error');
    }
  }

  isLoading = false;
  document.getElementById('sendBtn').disabled = false;

  const summary = failed.length === 0
    ? `✅ Saari ${okCount} files upload ho gayin!`
    : `⚠️ ${okCount}/${files.length} files upload hui. Fail hui: ${failed.join(', ')}`;
  addMessage('agent', summary, failed.length === 0 ? 'success' : 'warning');
}

// ══════════════════════════════════════════════════════════════════
// ZIP UPLOAD FLOW — same two-step (repo → destination folder) pattern
// as the regular file upload, but ends in a single /upload-zip POST
// instead of per-file /upload calls. The server extracts the zip and
// pushes everything as one commit.
// ══════════════════════════════════════════════════════════════════
function askZipUploadRepo(file) {
  const es = document.getElementById('empty-state');
  if (es) es.style.display = 'none';

  const messages = document.getElementById('messages');
  const wrap = document.createElement('div');
  wrap.className = 'msg-wrap agent';

  const label = document.createElement('div');
  label.className = 'msg-label';
  label.textContent = 'Agent';

  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble info';
  const sizeKb = (file.size / 1024).toFixed(1);
  bubble.innerHTML = `🗜️ <strong>${escHtml(file.name)}</strong> (${sizeKb} KB) select hui hai. Kis repo me extract karni hai?`;

  const form = document.createElement('div');
  form.className = 'prompt-form';

  const listId = 'zip-repo-list-' + Date.now();
  const datalist = document.createElement('datalist');
  datalist.id = listId;

  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'repo-name';
  input.value = lastUploadRepo;
  input.setAttribute('list', listId);
  input.autocomplete = 'off';

  getRepoNames().then(names => fillDatalist(datalist, names));

  const actions = document.createElement('div');
  actions.className = 'prompt-actions';

  const goBtn = document.createElement('button');
  goBtn.className = 'prompt-btn go';
  goBtn.textContent = 'Next →';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'prompt-btn cancel';
  cancelBtn.textContent = 'Cancel';

  const submit = () => {
    const repo = input.value.trim();
    if (!repo) { input.focus(); return; }
    goBtn.disabled = true;
    cancelBtn.disabled = true;
    input.disabled = true;
    lastUploadRepo = repo;
    askZipUploadPath(file, repo);
  };

  goBtn.onclick = submit;
  input.onkeydown = (e) => { if (e.key === 'Enter') submit(); };
  cancelBtn.onclick = () => {
    goBtn.disabled = true;
    cancelBtn.disabled = true;
    input.disabled = true;
    addMessage('agent', 'Theek hai, zip upload cancel kar diya.', '');
  };

  actions.appendChild(goBtn);
  actions.appendChild(cancelBtn);
  form.appendChild(input);
  form.appendChild(datalist);
  form.appendChild(actions);
  bubble.appendChild(form);

  wrap.appendChild(label);
  wrap.appendChild(bubble);
  messages.appendChild(wrap);
  scrollToBottom();
  input.focus();
}

function askZipUploadPath(file, repo) {
  const messages = document.getElementById('messages');
  const wrap = document.createElement('div');
  wrap.className = 'msg-wrap agent';

  const label = document.createElement('div');
  label.className = 'msg-label';
  label.textContent = 'Agent';

  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble info';
  bubble.innerHTML = `<strong>${escHtml(repo)}</strong> me kis folder me extract karni hai? Khaali chhodo root ke liye. Zip ke andar ki folder structure preserve rahegi.`;

  const form = document.createElement('div');
  form.className = 'prompt-form';

  const listId = 'zip-folder-list-' + Date.now();
  const datalist = document.createElement('datalist');
  datalist.id = listId;

  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'folder (optional)';
  input.value = lastUploadDir;
  input.setAttribute('list', listId);
  input.autocomplete = 'off';

  fetch(`/api/repo-folders?repo=${encodeURIComponent(repo)}`)
    .then(r => r.json())
    .then(data => fillDatalist(datalist, data.folders || []))
    .catch(() => {});

  const hint = document.createElement('div');
  hint.className = 'prompt-hint';
  hint.textContent = 'Zip extract hoke iske andar push hogi.';

  const actions = document.createElement('div');
  actions.className = 'prompt-actions';

  const goBtn = document.createElement('button');
  goBtn.className = 'prompt-btn go';
  goBtn.textContent = 'Extract & Upload';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'prompt-btn cancel';
  cancelBtn.textContent = 'Cancel';

  const submit = () => {
    goBtn.disabled = true;
    cancelBtn.disabled = true;
    input.disabled = true;
    const dir = input.value.trim().replace(/^\/+|\/+$/g, '');
    lastUploadDir = dir;
    doZipUpload(file, repo, dir);
  };

  goBtn.onclick = submit;
  input.onkeydown = (e) => { if (e.key === 'Enter') submit(); };
  cancelBtn.onclick = () => {
    goBtn.disabled = true;
    cancelBtn.disabled = true;
    input.disabled = true;
    addMessage('agent', 'Theek hai, zip upload cancel kar diya.', '');
  };

  actions.appendChild(goBtn);
  actions.appendChild(cancelBtn);
  form.appendChild(input);
  form.appendChild(datalist);
  form.appendChild(hint);
  form.appendChild(actions);
  bubble.appendChild(form);

  wrap.appendChild(label);
  wrap.appendChild(bubble);
  messages.appendChild(wrap);
  scrollToBottom();
  input.focus();
}

async function doZipUpload(file, repo, dir) {
  const dest = dir ? `${repo}/${dir}` : repo;
  addMessage('user', `🗜️ Extracting "${file.name}" → ${dest}`);

  isLoading = true;
  document.getElementById('sendBtn').disabled = true;

  const ring = showUploadProgress(file.name);
  scrollToBottom();

  try {
    const form = new FormData();
    form.append('file', file);
    form.append('repo', repo);
    form.append('path', dir);
    form.append('message', `Extract ${file.name} via DevOps Agent`);

    const { data } = await xhrUploadWithProgress('/upload-zip', form, (pct) => {
      // Upload itself is usually the fast part; once bytes are fully sent,
      // the server is still extracting the zip and pushing a commit, so
      // switch the label instead of leaving the ring pinned at 100%
      // looking stuck. Two-phase label (extract → push) instead of one
      // generic "Processing…" so it's clearer something is actually
      // happening during the part of the request with no progress signal.
      if (pct >= 100) {
        ring.setLabel('Zip extract kar raha hu…', true);
        setTimeout(() => ring.setLabel(`Files ${repo} me push kar raha hu…`, true), 1200);
      } else {
        ring.update(pct);
      }
    });
    ring.remove();

    const cls = actionColorFor(data.action);
    addMessage('agent', data.reply, cls, null, data.action);
    history.push({ role: 'assistant', content: data.reply });
  } catch (err) {
    ring.remove();
    addMessage('agent', '❌ Zip upload fail ho gaya. Server se connect nahi ho paya.', 'error');
  } finally {
    isLoading = false;
    document.getElementById('sendBtn').disabled = false;
  }
}

// ── MARKDOWN RENDERER (lightweight) ──
function renderMarkdown(text) {
  text = text.replace(/```([\s\S]*?)```/g, (_, code) => `<pre>${escHtml(code.trim())}</pre>`);
  text = text.replace(/`([^`]+)`/g, (_, code) => `<code>${escHtml(code)}</code>`);
  text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
  text = text.replace(/\n/g, '<br>');
  return text;
}

// ── ICON HELPERS ──
function iconFile() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;
}
function iconFolder() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>`;
}
function iconDl() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`;
}
function iconTrash() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6h14z"/></svg>`;
}
function iconZip() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M12 3v18M9 7h1M9 11h1M9 15h1"/></svg>`;
}

// ── BUILD FILE-LIST BUBBLE (for list_files action) ──
// Returns a DOM element with each file on its own row + download button,
// plus a delete button that routes through the same confirm-token flow
// as chat-typed delete commands. Files that are type=dir get a folder
// icon and no download/delete buttons (dir delete isn't a single API call).
// Expects agentData.items = [{type, path, name}] from the server.
function buildFileListBubble(repo, items) {
  const wrap = document.createElement('div');
  wrap.className = 'file-list-bubble';

  // Header line: repo name + "select" toggle + "download as zip".
  // Select-mode state lives on the wrap element itself (dataset flag)
  // rather than a module-level variable, since multiple file-list
  // bubbles can be open in the same chat history at once and each
  // needs its own independent select state.
  const hdr = document.createElement('div');
  hdr.className = 'file-list-hdr';

  const hdrText = document.createElement('div');
  const repoCode = document.createElement('code');
  repoCode.textContent = repo + '/';
  hdrText.appendChild(document.createTextNode('Files in '));
  hdrText.appendChild(repoCode);
  hdrText.appendChild(document.createTextNode(' :'));
  hdr.appendChild(hdrText);

  const hdrActions = document.createElement('div');
  hdrActions.className = 'file-list-hdr-actions';

  const selectBtn = document.createElement('button');
  selectBtn.className = 'file-list-select-btn';
  selectBtn.textContent = 'Select';
  hdrActions.appendChild(selectBtn);

  const zipBtn = document.createElement('a');
  zipBtn.className = 'repo-zip-btn';
  zipBtn.href = `/download-repo-zip?repo=${encodeURIComponent(repo)}`;
  zipBtn.innerHTML = iconZip() + ' .zip';
  zipBtn.title = `Download ${repo} as zip`;
  hdrActions.appendChild(zipBtn);

  hdr.appendChild(hdrActions);
  wrap.appendChild(hdr);

  // Bulk action bar — hidden until select-mode is on, then shows
  // selected-count + "select all" + "delete selected".
  const bulkBar = document.createElement('div');
  bulkBar.className = 'file-list-bulk-bar';
  const bulkCount = document.createElement('span');
  bulkCount.className = 'file-list-bulk-count';
  bulkCount.textContent = '0 selected';
  const bulkSelectAllBtn = document.createElement('button');
  bulkSelectAllBtn.className = 'file-list-bulk-selectall';
  bulkSelectAllBtn.textContent = 'Select all';
  const bulkDeleteBtn = document.createElement('button');
  bulkDeleteBtn.className = 'file-list-bulk-delete';
  bulkDeleteBtn.innerHTML = iconTrash() + ' Delete selected';
  bulkDeleteBtn.disabled = true;
  bulkBar.appendChild(bulkCount);
  bulkBar.appendChild(bulkSelectAllBtn);
  bulkBar.appendChild(bulkDeleteBtn);
  wrap.appendChild(bulkBar);

  const list = document.createElement('div');
  list.className = 'file-list';

  const checkboxes = []; // {checkbox, path} — only for file rows (dirs aren't selectable)

  function updateBulkBar() {
    const checked = checkboxes.filter(c => c.checkbox.checked);
    bulkCount.textContent = `${checked.length} selected`;
    bulkDeleteBtn.disabled = checked.length === 0;
    bulkSelectAllBtn.textContent = checked.length === checkboxes.length && checkboxes.length > 0 ? 'Deselect all' : 'Select all';
  }

  function setSelectMode(on) {
    wrap.classList.toggle('select-mode', on);
    selectBtn.textContent = on ? 'Cancel' : 'Select';
    if (!on) {
      checkboxes.forEach(c => { c.checkbox.checked = false; });
      updateBulkBar();
    }
  }

  selectBtn.onclick = () => setSelectMode(!wrap.classList.contains('select-mode'));

  bulkSelectAllBtn.onclick = () => {
    const allChecked = checkboxes.every(c => c.checkbox.checked) && checkboxes.length > 0;
    checkboxes.forEach(c => { c.checkbox.checked = !allChecked; });
    updateBulkBar();
  };

  bulkDeleteBtn.onclick = () => {
    const paths = checkboxes.filter(c => c.checkbox.checked).map(c => c.path);
    if (paths.length) requestBulkFileDelete(repo, paths, bulkDeleteBtn, () => setSelectMode(false));
  };

  items.forEach(item => {
    const row = document.createElement('div');
    row.className = 'file-row';

    if (item.type !== 'dir') {
      const checkboxWrap = document.createElement('label');
      checkboxWrap.className = 'file-row-checkbox';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.onchange = updateBulkBar;
      checkboxWrap.appendChild(checkbox);
      row.appendChild(checkboxWrap);
      checkboxes.push({ checkbox, path: item.path });
    }

    const nameEl = document.createElement('div');
    nameEl.className = 'file-row-name';
    nameEl.innerHTML = (item.type === 'dir' ? iconFolder() : iconFile()) + escHtml(item.path || item.name || '');
    row.appendChild(nameEl);

    if (item.type !== 'dir') {
      const rowActions = document.createElement('div');
      rowActions.className = 'file-row-actions';

      const readBtn = document.createElement('button');
      readBtn.className = 'file-read-btn';
      readBtn.innerHTML = iconEye();
      readBtn.title = 'Read ' + (item.path || '');
      readBtn.onclick = () => resendMessage(`read file ${item.path} from ${repo}`);
      rowActions.appendChild(readBtn);

      const editBtn = document.createElement('button');
      editBtn.className = 'file-edit-btn';
      editBtn.innerHTML = iconEdit();
      editBtn.title = 'Edit ' + (item.path || '');
      editBtn.onclick = () => openCodeEditor(repo, item.path);
      rowActions.appendChild(editBtn);

      const dlUrl = `/download?repo=${encodeURIComponent(repo)}&path=${encodeURIComponent(item.path)}`;
      const dlBtn = document.createElement('a');
      dlBtn.className = 'file-dl-btn';
      dlBtn.href = dlUrl;
      dlBtn.download = (item.path || '').split('/').pop();
      dlBtn.innerHTML = iconDl();
      dlBtn.title = 'Download ' + (item.path || '');
      rowActions.appendChild(dlBtn);

      const delBtn = document.createElement('button');
      delBtn.className = 'file-del-btn';
      delBtn.innerHTML = iconTrash();
      delBtn.title = 'Delete ' + (item.path || '');
      delBtn.onclick = () => requestFileRowDelete(repo, item.path, delBtn);
      rowActions.appendChild(delBtn);

      row.appendChild(rowActions);

      // ── SWIPE-TO-ACTION WRAP ──
      // Only files (not dirs) get swipe — dirs have no download/delete
      // action to swipe to anyway. Swipe right reveals + fires download,
      // swipe left reveals + fires delete (through the same confirm-token
      // flow as the trash-icon button, via requestFileRowDelete above).
      const swipeWrap = document.createElement('div');
      swipeWrap.className = 'file-row-swipe';

      const bgDl = document.createElement('div');
      bgDl.className = 'file-row-swipe-bg file-row-swipe-bg-dl';
      bgDl.innerHTML = iconDl() + '<span>Download</span>';

      const bgDel = document.createElement('div');
      bgDel.className = 'file-row-swipe-bg file-row-swipe-bg-del';
      bgDel.innerHTML = '<span>Delete</span>' + iconTrash();

      swipeWrap.appendChild(bgDl);
      swipeWrap.appendChild(bgDel);
      swipeWrap.appendChild(row);
      attachSwipeActions(swipeWrap, row, {
        onSwipeRight: () => dlBtn.click(),
        onSwipeLeft: () => requestFileRowDelete(repo, item.path, delBtn),
      });
      list.appendChild(swipeWrap);
      return;
    }

    list.appendChild(row);
  });

  wrap.appendChild(list);
  return wrap;
}

function iconEye() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
}

// ── BULK FILE DELETE — multi-select delete via /api/bulk-action ──
// Same two-phase confirm pattern as every other destructive action:
// first call returns confirm_required, the Yes tap replays with
// confirmed:true. Reuses the existing chat confirm-bubble UI by just
// posting a normal agent message with the confirm data attached —
// no separate confirm-dialog component needed for bulk ops.
async function requestBulkFileDelete(repo, paths, btnEl, onDone) {
  if (isLoading) return;
  btnEl.disabled = true;
  isLoading = true;
  const typing = document.getElementById('typing-indicator');
  setThinkingStatus('Files delete kar raha hu…');
  typing.classList.add('show');
  scrollToBottom();

  try {
    const res = await fetch('/api/bulk-action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ op: 'delete_files', repo, paths }),
    });
    const data = await res.json();
    typing.classList.remove('show');

    if (data.action === 'confirm_required') {
      addMessage('agent', data.reply, 'warning', {
        pending_command: data.pending_command,
        pending_value: data.pending_value,
        confirm_token: data.confirm_token,
        confirm_verb: data.confirm_verb,
        bulk_op: 'delete_files',
      });
    } else {
      addMessage('agent', data.reply, actionColorFor(data.action));
      history.push({ role: 'assistant', content: data.reply });
    }
    if (onDone) onDone();
  } catch (err) {
    typing.classList.remove('show');
    addMessage('agent', '❌ Server se connect nahi ho paya.', 'error');
  } finally {
    isLoading = false;
    btnEl.disabled = false;
  }
}

// ── SWIPE-TO-ACTION GESTURE HANDLER (mobile file list rows) ──
// Attaches touch handlers to `row` (the visible foreground element) inside
// `container` (the position:relative wrapper holding the background
// affordances). Tracks a horizontal drag via touch events, translates the
// row live as the finger moves, and fires the matching callback once the
// drag passes SWIPE_COMMIT_PX in either direction — otherwise the row
// snaps back to rest. Vertical scroll intent is detected early (first
// ~10px of movement) and yielded to so this never fights the page's
// normal vertical scrolling.
const SWIPE_COMMIT_PX = 72;
const SWIPE_MAX_PX = 96;

function attachSwipeActions(container, row, { onSwipeRight, onSwipeLeft }) {
  let startX = 0, startY = 0, currentX = 0, dragging = false, axisLocked = null;

  row.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    currentX = 0;
    axisLocked = null;
    dragging = false;
  }, { passive: true });

  row.addEventListener('touchmove', (e) => {
    if (e.touches.length !== 1) return;
    const dx = e.touches[0].clientX - startX;
    const dy = e.touches[0].clientY - startY;

    if (axisLocked === null) {
      if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return; // not enough movement yet to decide
      axisLocked = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      if (axisLocked === 'x') {
        dragging = true;
        container.classList.add('dragging');
      }
    }
    if (axisLocked !== 'x') return; // vertical drag — let the page scroll normally

    e.preventDefault(); // we own horizontal movement now
    currentX = Math.max(-SWIPE_MAX_PX, Math.min(SWIPE_MAX_PX, dx));
    row.style.transform = `translateX(${currentX}px)`;
  }, { passive: false });

  row.addEventListener('touchend', () => {
    if (!dragging) return;
    container.classList.remove('dragging');
    dragging = false;
    if (currentX >= SWIPE_COMMIT_PX) {
      onSwipeRight && onSwipeRight();
    } else if (currentX <= -SWIPE_COMMIT_PX) {
      onSwipeLeft && onSwipeLeft();
    }
    row.style.transform = 'translateX(0)';
    currentX = 0;
  });

  row.addEventListener('touchcancel', () => {
    container.classList.remove('dragging');
    dragging = false;
    row.style.transform = 'translateX(0)';
    currentX = 0;
  });
}

// ── DELETE BUTTON ON A FILE ROW (list_files bubble) ──
// Fires the exact same "delete file X from Y" sentence a user could type
// in chat, through the normal /chat endpoint — so it goes through the
// regex parser → DESTRUCTIVE_COMMANDS check → confirm-token flow exactly
// like a typed command would. The resulting confirm prompt (with its
// Haan/Cancel buttons) is rendered as a normal new agent message via the
// existing addMessage(..., confirmData) path — nothing about the
// confirmation plumbing itself is duplicated here.
async function requestFileRowDelete(repo, path, btnEl) {
  if (isLoading) return;
  btnEl.disabled = true;

  const msg = `delete file ${path} from ${repo}`;
  addMessage('user', msg);
  history.push({ role: 'user', content: msg });

  const typing = document.getElementById('typing-indicator');
  setThinkingStatus(guessStatusText(msg));
  typing.classList.add('show');
  scrollToBottom();
  isLoading = true;

  try {
    const res = await fetch('/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: msg, history: history.slice(0, -1) })
    });
    const data = await res.json();
    typing.classList.remove('show');

    if (data.action === 'confirm_required') {
      addMessage('agent', data.reply, 'warning', {
        pending_command: data.pending_command,
        pending_value: data.pending_value,
        confirm_token: data.confirm_token,
        confirm_verb: data.confirm_verb
      });
    } else {
      addMessage('agent', data.reply, actionColorFor(data.action));
      history.push({ role: 'assistant', content: data.reply });
    }
  } catch (err) {
    typing.classList.remove('show');
    addMessage('agent', '❌ Server se connect nahi ho paya. Page refresh karo.', 'error');
  } finally {
    isLoading = false;
    btnEl.disabled = false;
  }
}

// ══════════════════════════════════════════════════════════════════
// COMPACT ACTIVITY CARDS — list_repos / vercel_list / netlify_list /
// render_list. Replaces the old big text-block reply with a scannable
// grid of small tappable cards (icon, name, one-line meta, status
// badge). Each provider has slightly different fields, so a small
// per-kind adapter below normalizes them into one shape:
//   { icon, title, meta: [strings], status: 'live'|'building'|'error'|'neutral', statusLabel, url }
// before handing off to the shared card-grid renderer.
// ══════════════════════════════════════════════════════════════════

function timeAgoShort(iso) {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  const diff = Math.max(0, Date.now() - then);
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'abhi';
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  return `${months}mo`;
}

// Maps each provider's raw status vocabulary to one of the four badge
// states the CSS knows about. Unrecognized/missing values fall back to
// 'neutral' rather than guessing "live" — an unknown status is not the
// same claim as a confirmed-healthy one.
function normalizeActivityStatus(kind, raw) {
  const s = (raw || '').toString().toLowerCase();
  if (kind === 'repo') {
    return { state: 'neutral', label: null }; // repos don't have a live/build state
  }
  if (kind === 'vercel') {
    if (s === 'ready') return { state: 'live', label: 'Live' };
    if (s === 'building' || s === 'initializing' || s === 'queued') return { state: 'building', label: 'Building' };
    if (s === 'error') return { state: 'error', label: 'Error' };
    if (s === 'canceled') return { state: 'neutral', label: 'Canceled' };
    return { state: 'neutral', label: 'Unknown' };
  }
  if (kind === 'netlify') {
    if (s === 'ready' || s === 'current') return { state: 'live', label: 'Live' };
    if (s === 'building' || s === 'enqueued' || s === 'processing') return { state: 'building', label: 'Building' };
    if (s === 'error') return { state: 'error', label: 'Error' };
    return { state: 'neutral', label: 'Unknown' };
  }
  if (kind === 'render') {
    if (s === 'suspended') return { state: 'error', label: 'Suspended' };
    if (s === 'active') return { state: 'live', label: 'Active' };
    return { state: 'neutral', label: 'Unknown' };
  }
  return { state: 'neutral', label: null };
}

function activityIconFor(kind, item) {
  if (kind === 'repo') return item.fork ? '🍴' : '📁';
  if (kind === 'vercel') return '▲';
  if (kind === 'netlify') return '🌐';
  if (kind === 'render') {
    const typeIcons = { web_service: '🌐', static_site: '📦', private_service: '🔒',
                         background_worker: '⚙️', cron_job: '⏰', postgres: '🐘', redis: '🟥' };
    return typeIcons[item.type] || '🧩';
  }
  return '•';
}

function activityMetaFor(kind, item) {
  const meta = [];
  if (kind === 'repo') {
    meta.push(item.visibility || 'public');
    if (item.language) meta.push(item.language);
    const ago = timeAgoShort(item.updated_at);
    if (ago) meta.push(`updated ${ago}`);
  } else if (kind === 'vercel') {
    meta.push(item.framework || 'static');
  } else if (kind === 'netlify') {
    if (item.url) meta.push(item.url.replace(/^https?:\/\//, ''));
  } else if (kind === 'render') {
    meta.push(item.type || 'service');
  }
  return meta;
}

function activityUrlFor(kind, item, owner) {
  if (kind === 'repo') return item.url;
  if (kind === 'vercel') return item.url;
  if (kind === 'netlify') return item.url;
  if (kind === 'render') return item.url || null;
  return null;
}

// Builds the full bubble: header line ("Tere N repos:") + select toggle
// + bulk-action bar + card grid. `kind` is one of 'repo' | 'vercel' |
// 'netlify' | 'render'.
//
// Cards no longer navigate on tap — tapping opens the details sheet
// (openCardDetailsSheet) showing full meta with an explicit "Open live
// URL" action and a Delete button, so a stray tap never leaves the app.
// Render cards keep their special onCardTap behavior (env-var lookup)
// since they don't have a single obvious live URL the way repo/Vercel/
// Netlify do — that's passed straight through to the details sheet's
// "primary" button slot instead of a URL.
function buildActivityListBubble(kind, items, headerText, onCardTap) {
  const wrap = document.createElement('div');
  wrap.className = 'activity-list-bubble';

  const hdr = document.createElement('div');
  hdr.className = 'activity-list-hdr';
  const hdrText = document.createElement('span');
  hdrText.textContent = headerText;
  hdr.appendChild(hdrText);

  // Bulk select is only meaningful for repo and vercel kinds right now
  // (bulk_actions.py only has delete/visibility ops for those two) —
  // netlify/render keep the simple tap-to-details flow for now.
  const supportsBulk = kind === 'repo' || kind === 'vercel';
  let selectBtn = null;
  if (supportsBulk) {
    selectBtn = document.createElement('button');
    selectBtn.className = 'activity-list-select-btn';
    selectBtn.textContent = 'Select';
    hdr.appendChild(selectBtn);
  }
  wrap.appendChild(hdr);

  const bulkBar = document.createElement('div');
  bulkBar.className = 'activity-list-bulk-bar';
  const checkboxes = []; // {checkbox, item}

  let bulkCount, bulkSelectAllBtn, bulkPrivateBtn, bulkPublicBtn, bulkDeleteBtn;
  if (supportsBulk) {
    bulkCount = document.createElement('span');
    bulkCount.className = 'activity-list-bulk-count';
    bulkCount.textContent = '0 selected';
    bulkBar.appendChild(bulkCount);

    bulkSelectAllBtn = document.createElement('button');
    bulkSelectAllBtn.className = 'activity-list-bulk-selectall';
    bulkSelectAllBtn.textContent = 'Select all';
    bulkBar.appendChild(bulkSelectAllBtn);

    if (kind === 'repo') {
      bulkPrivateBtn = document.createElement('button');
      bulkPrivateBtn.className = 'activity-list-bulk-private';
      bulkPrivateBtn.textContent = '🔒 Private';
      bulkPrivateBtn.disabled = true;
      bulkBar.appendChild(bulkPrivateBtn);

      bulkPublicBtn = document.createElement('button');
      bulkPublicBtn.className = 'activity-list-bulk-public';
      bulkPublicBtn.textContent = '🌐 Public';
      bulkPublicBtn.disabled = true;
      bulkBar.appendChild(bulkPublicBtn);
    }

    bulkDeleteBtn = document.createElement('button');
    bulkDeleteBtn.className = 'activity-list-bulk-delete';
    bulkDeleteBtn.innerHTML = iconTrash() + ' Delete';
    bulkDeleteBtn.disabled = true;
    bulkBar.appendChild(bulkDeleteBtn);
  }
  wrap.appendChild(bulkBar);

  function updateBulkBar() {
    const checked = checkboxes.filter(c => c.checkbox.checked);
    bulkCount.textContent = `${checked.length} selected`;
    bulkDeleteBtn.disabled = checked.length === 0;
    if (bulkPrivateBtn) bulkPrivateBtn.disabled = checked.length === 0;
    if (bulkPublicBtn) bulkPublicBtn.disabled = checked.length === 0;
    bulkSelectAllBtn.textContent = checked.length === checkboxes.length && checkboxes.length > 0 ? 'Deselect all' : 'Select all';
  }

  function setSelectMode(on) {
    wrap.classList.toggle('select-mode', on);
    selectBtn.textContent = on ? 'Cancel' : 'Select';
    if (!on) {
      checkboxes.forEach(c => { c.checkbox.checked = false; });
      updateBulkBar();
    }
  }

  if (supportsBulk) {
    selectBtn.onclick = () => setSelectMode(!wrap.classList.contains('select-mode'));
    bulkSelectAllBtn.onclick = () => {
      const allChecked = checkboxes.every(c => c.checkbox.checked) && checkboxes.length > 0;
      checkboxes.forEach(c => { c.checkbox.checked = !allChecked; });
      updateBulkBar();
    };
    bulkDeleteBtn.onclick = () => {
      const names = checkboxes.filter(c => c.checkbox.checked).map(c => c.item.name);
      if (!names.length) return;
      if (kind === 'repo') requestBulkRepoDelete(names, bulkDeleteBtn, () => setSelectMode(false));
      else requestBulkVercelDelete(names, bulkDeleteBtn, () => setSelectMode(false));
    };
    if (bulkPrivateBtn) bulkPrivateBtn.onclick = () => {
      const names = checkboxes.filter(c => c.checkbox.checked).map(c => c.item.name);
      if (names.length) requestBulkRepoVisibility(names, true, bulkPrivateBtn);
    };
    if (bulkPublicBtn) bulkPublicBtn.onclick = () => {
      const names = checkboxes.filter(c => c.checkbox.checked).map(c => c.item.name);
      if (names.length) requestBulkRepoVisibility(names, false, bulkPublicBtn);
    };
  }

  const grid = document.createElement('div');
  grid.className = 'activity-grid';

  items.forEach(item => {
    const status = normalizeActivityStatus(kind, item.status);
    const url = activityUrlFor(kind, item);

    const card = document.createElement('div');
    card.className = 'activity-card';
    card.onclick = (e) => {
      // A tap on the checkbox itself shouldn't also open the details
      // sheet — let the checkbox's own change handler run instead.
      if (e.target.closest('.activity-card-checkbox')) return;
      openCardDetailsSheet(kind, item, url, onCardTap);
    };

    if (supportsBulk) {
      const checkboxWrap = document.createElement('label');
      checkboxWrap.className = 'activity-card-checkbox';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.onchange = updateBulkBar;
      checkboxWrap.appendChild(checkbox);
      card.appendChild(checkboxWrap);
      checkboxes.push({ checkbox, item });
    }

    const icon = document.createElement('div');
    icon.className = 'activity-card-icon';
    icon.textContent = activityIconFor(kind, item);
    card.appendChild(icon);

    const main = document.createElement('div');
    main.className = 'activity-card-main';

    const title = document.createElement('div');
    title.className = 'activity-card-title';
    title.textContent = item.name || 'unnamed';
    main.appendChild(title);

    const meta = activityMetaFor(kind, item);
    if (meta.length) {
      const subEl = document.createElement('div');
      subEl.className = 'activity-card-sub';
      meta.forEach((m, i) => {
        if (i > 0) {
          const sep = document.createElement('span');
          sep.className = 'dot-sep';
          sep.textContent = '·';
          subEl.appendChild(sep);
        }
        const span = document.createElement('span');
        span.textContent = m;
        subEl.appendChild(span);
      });
      main.appendChild(subEl);
    }
    card.appendChild(main);

    if (status.label) {
      const statusEl = document.createElement('div');
      statusEl.className = `activity-status ${status.state}`;
      const dot = document.createElement('span');
      dot.className = 'status-dot-sm';
      statusEl.appendChild(dot);
      const label = document.createElement('span');
      label.textContent = status.label;
      statusEl.appendChild(label);
      card.appendChild(statusEl);
    } else if (kind === 'repo' && typeof item.stars === 'number') {
      // Repos don't have a live/build state, so show stars instead —
      // still gives a useful at-a-glance signal in the same badge slot.
      const starsEl = document.createElement('div');
      starsEl.className = 'activity-status neutral';
      starsEl.textContent = `⭐ ${item.stars}`;
      card.appendChild(starsEl);
    }

    const chevron = document.createElement('svg');
    chevron.className = 'activity-card-chevron';
    chevron.setAttribute('viewBox', '0 0 24 24');
    chevron.setAttribute('fill', 'none');
    chevron.setAttribute('stroke', 'currentColor');
    chevron.setAttribute('stroke-width', '2');
    chevron.setAttribute('stroke-linecap', 'round');
    chevron.setAttribute('stroke-linejoin', 'round');
    chevron.innerHTML = '<path d="M9 18l6-6-6-6"/>';
    card.appendChild(chevron);

    grid.appendChild(card);
  });

  wrap.appendChild(grid);
  return wrap;
}

// ── CARD DETAILS SHEET ──
// Opened on tap for any repo/vercel/netlify/render card. Shows the full
// meta the compact card doesn't have room for, an explicit "Open live
// URL" button (nothing happens on tap without this — no more accidental
// navigations), and Delete gated through the same confirm flow as
// everywhere else in the app.
function openCardDetailsSheet(kind, item, url, onCardTap) {
  const overlay = document.getElementById('card-details-overlay');
  document.getElementById('card-details-icon').textContent = activityIconFor(kind, item);
  document.getElementById('card-details-title').textContent = item.name || 'unnamed';

  const kindLabel = { repo: 'GitHub repo', vercel: 'Vercel project', netlify: 'Netlify site', render: 'Render service' }[kind] || kind;
  document.getElementById('card-details-sub').textContent = kindLabel;

  const metaEl = document.getElementById('card-details-meta');
  metaEl.innerHTML = '';
  const rows = cardDetailsMetaRows(kind, item);
  rows.forEach(([k, v]) => {
    if (!v) return;
    const row = document.createElement('div');
    row.className = 'card-details-meta-row';
    const kEl = document.createElement('span');
    kEl.className = 'card-details-meta-key';
    kEl.textContent = k;
    const vEl = document.createElement('span');
    vEl.className = 'card-details-meta-val';
    vEl.textContent = v;
    row.appendChild(kEl);
    row.appendChild(vEl);
    metaEl.appendChild(row);
  });

  const openBtn = document.getElementById('card-details-open-btn');
  if (url) {
    openBtn.href = url;
    openBtn.classList.remove('hidden');
    openBtn.onclick = null;
  } else if (onCardTap) {
    // Render services without a direct URL fall back to their existing
    // special action (env-var lookup via chat) instead of a link.
    openBtn.removeAttribute('href');
    openBtn.textContent = 'View env vars';
    openBtn.classList.remove('hidden');
    openBtn.onclick = (e) => { e.preventDefault(); closeCardDetailsSheet(); onCardTap(item); };
  } else {
    openBtn.classList.add('hidden');
  }
  if (url) openBtn.textContent = 'Open live URL';

  const deleteBtn = document.getElementById('card-details-delete-btn');
  deleteBtn.disabled = false;
  deleteBtn.textContent = 'Delete';
  deleteBtn.onclick = () => requestCardDelete(kind, item, deleteBtn);

  overlay.classList.add('show');
}

function closeCardDetailsSheet() {
  document.getElementById('card-details-overlay').classList.remove('show');
}

function cardDetailsMetaRows(kind, item) {
  if (kind === 'repo') {
    return [
      ['Visibility', item.visibility || (item.private ? 'private' : 'public')],
      ['Language', item.language],
      ['Stars', typeof item.stars === 'number' ? String(item.stars) : null],
      ['Updated', timeAgoShort(item.updated_at) ? `${timeAgoShort(item.updated_at)} ago` : null],
      ['URL', item.url],
    ];
  }
  if (kind === 'vercel') {
    return [
      ['Framework', item.framework || 'static'],
      ['Status', item.status],
      ['URL', item.url],
    ];
  }
  if (kind === 'netlify') {
    return [
      ['Status', item.status],
      ['URL', item.url],
    ];
  }
  if (kind === 'render') {
    return [
      ['Type', item.type],
      ['Status', item.status],
      ['URL', item.url],
    ];
  }
  return [];
}

// Single-card delete from the details sheet — same natural-language +
// confirm-token flow as requestFileRowDelete, just phrased per kind.
async function requestCardDelete(kind, item, btnEl) {
  if (isLoading) return;
  btnEl.disabled = true;
  btnEl.textContent = 'Deleting…';

  const msgByKind = {
    repo: `delete repo ${item.name}`,
    vercel: `delete vercel project ${item.name}`,
    netlify: `delete netlify site ${item.name}`,
    render: `delete render service ${item.id || item.name}`,
  };
  const msg = msgByKind[kind];
  if (!msg) { btnEl.disabled = false; return; }

  addMessage('user', msg);
  history.push({ role: 'user', content: msg });
  const typing = document.getElementById('typing-indicator');
  setThinkingStatus(guessStatusText(msg));
  typing.classList.add('show');
  scrollToBottom();
  isLoading = true;

  try {
    const res = await fetch('/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: msg, history: history.slice(0, -1) })
    });
    const data = await res.json();
    typing.classList.remove('show');
    closeCardDetailsSheet();

    if (data.action === 'confirm_required') {
      addMessage('agent', data.reply, 'warning', {
        pending_command: data.pending_command,
        pending_value: data.pending_value,
        confirm_token: data.confirm_token,
        confirm_verb: data.confirm_verb
      });
    } else {
      addMessage('agent', data.reply, actionColorFor(data.action));
      history.push({ role: 'assistant', content: data.reply });
    }
  } catch (err) {
    typing.classList.remove('show');
    closeCardDetailsSheet();
    addMessage('agent', '❌ Server se connect nahi ho paya. Page refresh karo.', 'error');
  } finally {
    isLoading = false;
    btnEl.disabled = false;
  }
}

// ── BULK REPO / VERCEL ACTIONS — via /api/bulk-action ──
async function requestBulkRepoDelete(repos, btnEl, onDone) {
  if (isLoading) return;
  btnEl.disabled = true;
  isLoading = true;
  const typing = document.getElementById('typing-indicator');
  setThinkingStatus(`${repos.length} repo${repos.length !== 1 ? 's' : ''} delete kar raha hu…`);
  typing.classList.add('show');
  scrollToBottom();
  try {
    const res = await fetch('/api/bulk-action', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
      body: JSON.stringify({ op: 'delete_repos', repos }),
    });
    const data = await res.json();
    typing.classList.remove('show');
    if (data.action === 'confirm_required') {
      addMessage('agent', data.reply, 'warning', {
        pending_command: data.pending_command, pending_value: data.pending_value,
        confirm_token: data.confirm_token, confirm_verb: data.confirm_verb, bulk_op: 'delete_repos',
      });
    } else {
      addMessage('agent', data.reply, actionColorFor(data.action));
      history.push({ role: 'assistant', content: data.reply });
    }
    if (onDone) onDone();
  } catch (err) {
    typing.classList.remove('show');
    addMessage('agent', '❌ Server se connect nahi ho paya.', 'error');
  } finally {
    isLoading = false;
    btnEl.disabled = false;
  }
}

async function requestBulkVercelDelete(projects, btnEl, onDone) {
  if (isLoading) return;
  btnEl.disabled = true;
  isLoading = true;
  const typing = document.getElementById('typing-indicator');
  setThinkingStatus(`${projects.length} Vercel project${projects.length !== 1 ? 's' : ''} delete kar raha hu…`);
  typing.classList.add('show');
  scrollToBottom();
  try {
    const res = await fetch('/api/bulk-action', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
      body: JSON.stringify({ op: 'delete_vercel_projects', projects }),
    });
    const data = await res.json();
    typing.classList.remove('show');
    if (data.action === 'confirm_required') {
      addMessage('agent', data.reply, 'warning', {
        pending_command: data.pending_command, pending_value: data.pending_value,
        confirm_token: data.confirm_token, confirm_verb: data.confirm_verb, bulk_op: 'delete_vercel_projects',
      });
    } else {
      addMessage('agent', data.reply, actionColorFor(data.action));
      history.push({ role: 'assistant', content: data.reply });
    }
    if (onDone) onDone();
  } catch (err) {
    typing.classList.remove('show');
    addMessage('agent', '❌ Server se connect nahi ho paya.', 'error');
  } finally {
    isLoading = false;
    btnEl.disabled = false;
  }
}

// Not destructive (reversible) — runs immediately, no confirm step,
// same as the backend route treats it.
async function requestBulkRepoVisibility(repos, makePrivate, btnEl) {
  if (isLoading) return;
  btnEl.disabled = true;
  isLoading = true;
  const typing = document.getElementById('typing-indicator');
  setThinkingStatus(`${repos.length} repo${repos.length !== 1 ? 's' : ''} ${makePrivate ? 'private' : 'public'} kar raha hu…`);
  typing.classList.add('show');
  scrollToBottom();
  try {
    const res = await fetch('/api/bulk-action', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
      body: JSON.stringify({ op: 'set_repo_visibility', repos, private: makePrivate }),
    });
    const data = await res.json();
    typing.classList.remove('show');
    addMessage('agent', data.reply, actionColorFor(data.action));
    history.push({ role: 'assistant', content: data.reply });
  } catch (err) {
    typing.classList.remove('show');
    addMessage('agent', '❌ Server se connect nahi ho paya.', 'error');
  } finally {
    isLoading = false;
    btnEl.disabled = false;
  }
}

// ── RICH BUBBLE DISPATCH ──
// Single source of truth for "does this message need a rich DOM widget
// instead of a plain markdown bubble, and if so which one" — used both
// right after a live /chat response comes back AND when replaying saved
// history on page load/session-switch. Previously the live path built
// these widgets inline (see git history) while the reload path only ever
// called renderMarkdown() on entry.content, so file-list/activity cards
// looked right live and silently degraded to plain text after a refresh
// (the structured items/repos/projects arrays were never saved, only the
// human-readable reply string was). Centralizing it here means both paths
// automatically stay in sync — fix a bubble once, it's fixed everywhere.
//
// `entry` shape (superset of what saveChatEntry stores): {action, reply,
// repo, path, items, repos, projects, sites, services}. Returns a DOM
// node to append into the bubble, or null if this action has no rich
// widget (caller should fall back to renderMarkdown(entry.reply/content)).
const ACTIVITY_LIST_CONFIG = {
  list_repos:   { kind: 'repo',    itemsKey: 'repos',    badge: 'github' },
  vercel_list:  { kind: 'vercel',  itemsKey: 'projects', badge: 'vercel' },
  netlify_list: { kind: 'netlify', itemsKey: 'sites',    badge: 'netlify' },
  render_list:  { kind: 'render',  itemsKey: 'services', badge: 'render' },
};

function richBubbleBadgeFor(entry) {
  if (entry.action === 'list_files' || entry.action === 'read_file') return 'github';
  const cfg = ACTIVITY_LIST_CONFIG[entry.action];
  return cfg ? cfg.badge : null;
}

function buildRichBubbleNode(entry) {
  const replyText = entry.reply != null ? entry.reply : entry.content;

  if (entry.action === 'list_files' && entry.items && entry.repo) {
    return buildFileListBubble(entry.repo, entry.items);
  }

  if (entry.action === 'read_file' && entry.repo && entry.path) {
    // entry.fileContent is the RAW file text (no markdown fence, no "📄
    // path (N bytes):" prefix) saved alongside the reply specifically
    // for this — entry.reply/content is the human-readable wrapped
    // version meant for older/AI-narrated clients. The preview/full-
    // screen viewer needs the raw text so line-splitting and syntax
    // highlighting operate on actual file content, not fence markers.
    const rawContent = entry.fileContent != null ? entry.fileContent : replyText;
    return buildReadFileBubble(entry.repo, entry.path, rawContent);
  }

  const activityCfg = ACTIVITY_LIST_CONFIG[entry.action];
  if (activityCfg && Array.isArray(entry[activityCfg.itemsKey]) && entry[activityCfg.itemsKey].length) {
    const items = entry[activityCfg.itemsKey];
    const headerText = (replyText || '').split('\n')[0];
    const onCardTap = activityCfg.kind === 'render'
      ? (item) => resendMessage(`get env for ${item.id} render`)
      : null;
    return buildActivityListBubble(activityCfg.kind, items, headerText, onCardTap);
  }

  return null;
}

// ── BUILD READ-FILE BUBBLE with a capped preview + full-screen view ──
// Previously this rendered the ENTIRE file content inline via
// renderMarkdown, so a large file turned the chat bubble into a
// page-length wall of text — the only way to see all of it was
// scrolling the whole page. Now the inline bubble shows a capped,
// horizontally+vertically scrollable preview (READ_PREVIEW_MAX_LINES
// lines) in its own bordered box, with a "View full screen" button
// that opens the same overlay the editor uses, in read-only mode, for
// the complete file — full-screen and independently scrollable so the
// rest of the chat page never has to move.
const READ_PREVIEW_MAX_LINES = 25;

function buildReadFileBubble(repo, filePath, content) {
  const wrap = document.createElement('div');

  const allLines = content.split('\n');
  const isTruncated = allLines.length > READ_PREVIEW_MAX_LINES;
  const previewText = isTruncated ? allLines.slice(0, READ_PREVIEW_MAX_LINES).join('\n') : content;

  const codeBox = document.createElement('pre');
  codeBox.className = 'read-file-preview';
  const codeEl = document.createElement('code');
  codeEl.innerHTML = previewText.split('\n').map(l => highlightLine(l, detectEditorLang(filePath))).join('\n');
  codeBox.appendChild(codeEl);
  wrap.appendChild(codeBox);

  if (isTruncated) {
    const moreNote = document.createElement('div');
    moreNote.className = 'read-file-more-note';
    moreNote.textContent = `… ${allLines.length - READ_PREVIEW_MAX_LINES} more lines — pura file dekhne ke liye full screen kholo.`;
    wrap.appendChild(moreNote);
  }

  const actionsRow = document.createElement('div');
  actionsRow.className = 'read-file-actions';

  const fullScreenBtn = document.createElement('button');
  fullScreenBtn.className = 'read-fullscreen-btn';
  fullScreenBtn.innerHTML = iconExpand() + ' Full screen';
  fullScreenBtn.title = 'View full file';
  fullScreenBtn.onclick = () => openCodeEditor(repo, filePath, { readOnly: true });
  actionsRow.appendChild(fullScreenBtn);

  const dlUrl = `/download?repo=${encodeURIComponent(repo)}&path=${encodeURIComponent(filePath)}`;
  const fileName = filePath.split('/').pop();
  const dlBtn = document.createElement('a');
  dlBtn.className = 'read-dl-btn';
  dlBtn.href = dlUrl;
  dlBtn.download = fileName;
  dlBtn.innerHTML = iconDl() + ' Download';
  dlBtn.title = 'Download ' + filePath;
  actionsRow.appendChild(dlBtn);

  const editBtn = document.createElement('button');
  editBtn.className = 'read-edit-btn';
  editBtn.innerHTML = iconEdit() + ' Edit';
  editBtn.title = 'Edit ' + filePath;
  editBtn.onclick = () => openCodeEditor(repo, filePath);
  actionsRow.appendChild(editBtn);

  wrap.appendChild(actionsRow);

  return wrap;
}

function iconExpand() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>`;
}

function iconEdit() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;
}

// ══════════════════════════════════════════════════════════════════
// INLINE CODE EDITOR / DIFF WIDGET
//
// Flow: openCodeEditor(repo, path) -> fetch current content+sha from
// /api/file-source -> textarea editor with a synced line-number gutter
// -> "Review changes" builds a line-level diff against the original and
// swaps to the diff pane -> "Commit" (relabeled save button in diff mode)
// posts to /api/file-source, which re-checks the sha server-side and
// either saves or returns a 409 conflict the UI surfaces inline.
// ══════════════════════════════════════════════════════════════════
let editorState = null; // { repo, path, originalContent, sha, mode }

async function openCodeEditor(repo, path, opts = {}) {
  const readOnly = !!opts.readOnly;
  const overlay = document.getElementById('code-editor-overlay');
  const textarea = document.getElementById('editor-textarea');
  const statusLeft = document.getElementById('editor-status-left');
  const saveBtn = document.getElementById('editor-save-btn');
  const conflictNote = document.getElementById('editor-conflict-note');

  document.getElementById('editor-path-label').textContent = path;
  document.getElementById('editor-repo-label').textContent = repo;
  textarea.value = '';
  statusLeft.textContent = 'Loading…';
  conflictNote.classList.remove('show');
  saveBtn.disabled = true;
  saveBtn.textContent = readOnly ? 'Edit this file' : 'Review changes';
  setEditorMode('editing');
  overlay.classList.add('show');
  overlay.classList.toggle('view-only', readOnly);
  textarea.readOnly = readOnly;

  try {
    const res = await fetch(`/api/file-source?repo=${encodeURIComponent(repo)}&path=${encodeURIComponent(path)}`, {
      credentials: 'same-origin',
    });
    const data = await res.json();
    if (!res.ok) {
      statusLeft.textContent = data.reply || 'File load nahi hui.';
      return;
    }
    editorState = { repo, path, originalContent: data.content, sha: data.sha, mode: 'editing', lang: detectEditorLang(path), readOnly };
    textarea.value = data.content;
    renderEditorGutter();
    renderEditorHighlight();
    const lineCount = data.content.split('\n').length;
    statusLeft.textContent = readOnly ? `${lineCount} lines · view only` : `${lineCount} lines`;
    saveBtn.disabled = false;
  } catch (e) {
    statusLeft.textContent = '❌ Server se connect nahi ho paya.';
  }
}

// Flips an open read-only viewer into an editable session in place —
// no re-fetch needed, the content/sha are already loaded. Used by the
// save button's click handler when editorState.readOnly is true (see
// initCodeEditorHandlers), so "Edit this file" is a one-tap switch
// rather than closing the viewer and reopening the editor from scratch.
function switchEditorToEditable() {
  if (!editorState) return;
  editorState.readOnly = false;
  document.getElementById('editor-textarea').readOnly = false;
  document.getElementById('code-editor-overlay').classList.remove('view-only');
  document.getElementById('editor-save-btn').textContent = 'Review changes';
  document.getElementById('editor-status-left').textContent =
    document.getElementById('editor-status-left').textContent.replace(' · view only', '');
}

function closeCodeEditor() {
  document.getElementById('code-editor-overlay').classList.remove('show');
  editorState = null;
}

function setEditorMode(mode) {
  const editPane = document.getElementById('editor-edit-pane');
  const diffPane = document.getElementById('editor-diff-pane');
  const saveBtn = document.getElementById('editor-save-btn');
  if (mode === 'editing') {
    editPane.style.display = 'flex';
    diffPane.classList.remove('show');
    saveBtn.textContent = (editorState && editorState.readOnly) ? 'Edit this file' : 'Review changes';
  } else {
    editPane.style.display = 'none';
    diffPane.classList.add('show');
    saveBtn.textContent = 'Commit change';
  }
  if (editorState) editorState.mode = mode;
}

// Keeps the line-number gutter in sync with the textarea's line count and
// scroll position — re-rendered on input and scroll rather than using a
// contenteditable overlay, which is simpler and avoids caret/IME bugs.
function renderEditorGutter() {
  const textarea = document.getElementById('editor-textarea');
  const gutter = document.getElementById('editor-gutter');
  const lineCount = textarea.value.split('\n').length;
  let html = '';
  for (let i = 1; i <= lineCount; i++) html += `<div class="editor-gutter-line">${i}</div>`;
  gutter.innerHTML = html;
  gutter.scrollTop = textarea.scrollTop;
}

// ══════════════════════════════════════════════════════════════════
// SYNTAX HIGHLIGHTING — lightweight regex tokenizer, no external lib.
// Covers the common surface (keywords, strings, comments, numbers,
// function-call names, HTML/JSX tags+attributes) across the language
// family this app's users actually edit (JS/TS/Python/HTML/CSS/JSON/
// YAML/shell) well enough to be genuinely useful, without pulling in
// a real tokenizer+grammar engine for a single textarea overlay.
// Deliberately NOT trying to be a correct parser (no nested-string-
// interpolation handling, no multi-line-comment state machine across
// re-renders) — good-enough coloring that fails safe: a token pattern
// that doesn't match just stays plain-colored text, never breaks
// rendering or throws.
// ══════════════════════════════════════════════════════════════════
function detectEditorLang(path) {
  const ext = (path.split('.').pop() || '').toLowerCase();
  const map = {
    js: 'js', jsx: 'js', mjs: 'js', cjs: 'js', ts: 'js', tsx: 'js',
    py: 'py', html: 'html', htm: 'html', css: 'css', scss: 'css',
    json: 'json', yml: 'yaml', yaml: 'yaml',
    sh: 'shell', bash: 'shell',
    md: 'markdown',
  };
  return map[ext] || 'generic';
}

const EDITOR_KEYWORDS = {
  js: ['const','let','var','function','return','if','else','for','while','do','switch','case','break','continue',
       'class','extends','new','this','super','import','export','default','from','as','async','await','try',
       'catch','finally','throw','typeof','instanceof','in','of','yield','static','get','set','null','undefined',
       'true','false','void','delete'],
  py: ['def','class','return','if','elif','else','for','while','break','continue','pass','import','from','as',
       'try','except','finally','raise','with','lambda','yield','global','nonlocal','assert','del','is','in',
       'not','and','or','None','True','False','async','await','self'],
  yaml: ['true','false','null'],
  shell: ['if','then','else','elif','fi','for','while','do','done','case','esac','function','return','export','local'],
};

// Tokenizes one line at a time (comments/strings don't span lines in
// this simplified model — the one accuracy tradeoff of the "no state
// machine" choice above) and returns highlighted HTML for that line.
function highlightLine(line, lang) {
  if (lang === 'generic' || !line) return escHtml(line);

  if (lang === 'html') return highlightMarkupLine(line);
  if (lang === 'markdown') return escHtml(line); // prose — not worth tokenizing

  const kw = EDITOR_KEYWORDS[lang] || [];
  const kwRe = kw.length ? new RegExp(`\\b(?<keyword>${kw.join('|')})\\b`) : null;

  // Single combined regex per language, using NAMED capture groups so the
  // class for a match is a direct lookup (groups.<name>) rather than
  // guessing from a numeric index that shifts per-language — that
  // index-guessing was the root cause of the JSON string-value
  // mis-coloring bug (a plain string and a "key:" string used different
  // group slots per language, and the class-assignment cascade below
  // didn't account for that).
  let pattern;
  if (lang === 'py') {
    pattern = /(?<comment>#.*$)|(?<string>"""[\s\S]*?"""|'''[\s\S]*?'''|"[^"\\]*(?:\\.[^"\\]*)*"|'[^'\\]*(?:\\.[^'\\]*)*')|(?<number>\b\d+\.?\d*\b)|(?<function>\b[a-zA-Z_]\w*(?=\())/;
  } else if (lang === 'js') {
    pattern = /(?<comment>\/\/.*$)|(?<string>`[^`]*`|"[^"\\]*(?:\\.[^"\\]*)*"|'[^'\\]*(?:\\.[^'\\]*)*')|(?<number>\b\d+\.?\d*\b)|(?<function>\b[a-zA-Z_$]\w*(?=\())/;
  } else if (lang === 'css') {
    pattern = /(?<comment>\/\*.*?\*\/)|(?<string>"[^"\\]*(?:\\.[^"\\]*)*"|'[^'\\]*(?:\\.[^'\\]*)*')|(?<number>\b\d+\.?\d*(?:px|em|rem|%|s|ms)?\b)|(?<tag>[.#][a-zA-Z_-][\w-]*)/;
  } else if (lang === 'json') {
    pattern = /(?<property>"[^"\\]*(?:\\.[^"\\]*)*"(?=\s*:))|(?<string>"[^"\\]*(?:\\.[^"\\]*)*")|(?<number>\b(?:true|false|null|-?\d+\.?\d*)\b)/;
  } else if (lang === 'yaml') {
    pattern = /(?<comment>#.*$)|(?<property>^\s*[\w.-]+(?=\s*:))|(?<string>"[^"\\]*(?:\\.[^"\\]*)*"|'[^'\\]*(?:\\.[^'\\]*)*')/;
  } else if (lang === 'shell') {
    pattern = /(?<comment>#.*$)|(?<string>"[^"\\]*(?:\\.[^"\\]*)*"|'[^'\\]*(?:\\.[^'\\]*)*')|(?<property>\$\w+|\$\{[^}]*\})/;
  } else {
    pattern = kwRe;
  }

  const CLASS_BY_GROUP = {
    comment: 'tok-comment', string: 'tok-string', number: 'tok-number',
    function: 'tok-function', tag: 'tok-tag', property: 'tok-property', keyword: 'tok-keyword',
  };

  let out = '';
  let rest = line;
  let guard = 0;
  while (rest.length && guard++ < 2000) {
    const m = pattern ? rest.match(pattern) : null;
    const kwM = kwRe ? rest.match(kwRe) : null;
    // Pick whichever matches earliest in the remaining string; on a tie
    // the language-specific pattern (comment/string/number/etc.) wins
    // over a bare keyword match, since e.g. "class" inside a string
    // shouldn't be colored as a keyword.
    let use = null;
    if (m && kwM) use = m.index <= kwM.index ? m : kwM;
    else use = m || kwM;

    if (!use) { out += escHtml(rest); break; }

    if (use.index > 0) out += escHtml(rest.slice(0, use.index));

    const token = use[0];
    const groupName = use.groups ? Object.keys(use.groups).find(k => use.groups[k] !== undefined) : null;
    const cls = CLASS_BY_GROUP[groupName] || 'tok-punct';

    out += `<span class="${cls}">${escHtml(token)}</span>`;
    rest = rest.slice(use.index + token.length);
  }
  if (guard >= 2000) out += escHtml(rest); // pathological line — bail to plain text rather than hang
  return out;
}

function highlightMarkupLine(line) {
  // Single-pass tokenizer rather than chained .replace() calls — the
  // previous chained-replace version ran the attribute/string passes
  // over text that already contained <span> markup from the tag pass,
  // so later replacements matched inside earlier ones' output and
  // corrupted it (e.g. an attr-name regex matching "class" inside
  // class="tok-tag"). One combined regex avoids that entirely since
  // each character of the original line is only ever considered once.
  const pattern = /(?<tag><\/?[a-zA-Z][\w-]*)|(?<attr>\b[a-zA-Z-][\w-]*(?==))|(?<string>"[^"]*"|'[^']*')|(?<punct>[<>=\/])/;
  const CLASS_BY_GROUP = { tag: 'tok-tag', attr: 'tok-attr', string: 'tok-string', punct: 'tok-tag' };

  let out = '';
  let rest = line;
  let guard = 0;
  while (rest.length && guard++ < 2000) {
    const m = rest.match(pattern);
    if (!m) { out += escHtml(rest); break; }
    if (m.index > 0) out += escHtml(rest.slice(0, m.index));
    const token = m[0];
    const groupName = m.groups ? Object.keys(m.groups).find(k => m.groups[k] !== undefined) : null;
    const cls = CLASS_BY_GROUP[groupName];
    out += cls ? `<span class="${cls}">${escHtml(token)}</span>` : escHtml(token);
    rest = rest.slice(m.index + token.length);
  }
  if (guard >= 2000) out += escHtml(rest);
  return out;
}


function renderEditorHighlight() {
  if (!editorState) return;
  const textarea = document.getElementById('editor-textarea');
  const codeEl = document.getElementById('editor-highlight-code');
  const lines = textarea.value.split('\n');
  // Rebuilding all lines on every keystroke is fine at the file sizes
  // this editor targets (a few thousand lines, see MAX_EDITOR_FILE_BYTES
  // server-side) — a real editor would diff just the changed line, but
  // that optimization isn't worth the complexity here.
  codeEl.innerHTML = lines.map(l => highlightLine(l, editorState.lang)).join('\n');
}

function syncHighlightScroll() {
  const textarea = document.getElementById('editor-textarea');
  const highlight = document.getElementById('editor-highlight');
  const gutter = document.getElementById('editor-gutter');
  highlight.scrollTop = textarea.scrollTop;
  highlight.scrollLeft = textarea.scrollLeft;
  gutter.scrollTop = textarea.scrollTop;
}

// ── LINE-LEVEL DIFF (LCS-based) ──
// Good enough for typical source files (hundreds to a few thousand
// lines) without pulling in a diff library. Returns an array of
// {type: 'ctx'|'add'|'del', text} in display order.
function computeLineDiff(oldText, newText) {
  const a = oldText.split('\n');
  const b = newText.split('\n');
  const n = a.length, m = b.length;

  // LCS table (classic DP) — fine at this scale; for pathological huge
  // files this could be slow, so cap it defensively.
  if (n * m > 4_000_000) {
    return [{ type: 'note', text: 'File bahut badi hai line-by-line diff ke liye — seedha commit karo, ya download karke local diff dekho.' }];
  }

  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const result = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      result.push({ type: 'ctx', text: a[i] });
      i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      result.push({ type: 'del', text: a[i] });
      i++;
    } else {
      result.push({ type: 'add', text: b[j] });
      j++;
    }
  }
  while (i < n) { result.push({ type: 'del', text: a[i] }); i++; }
  while (j < m) { result.push({ type: 'add', text: b[j] }); j++; }
  return result;
}

function renderDiffPane() {
  const scroll = document.getElementById('editor-diff-scroll');
  const summary = document.getElementById('editor-diff-summary');
  const textarea = document.getElementById('editor-textarea');
  const diff = computeLineDiff(editorState.originalContent, textarea.value);

  if (diff.length === 1 && diff[0].type === 'note') {
    scroll.innerHTML = `<div class="diff-empty-note">${escHtml(diff[0].text)}</div>`;
    summary.textContent = '';
    return;
  }

  const added = diff.filter(d => d.type === 'add').length;
  const removed = diff.filter(d => d.type === 'del').length;
  if (added === 0 && removed === 0) {
    scroll.innerHTML = `<div class="diff-empty-note">Koi change nahi hai.</div>`;
    summary.textContent = 'No changes';
    return;
  }
  summary.innerHTML = `<span class="plus">+${added}</span> &nbsp; <span class="minus">-${removed}</span> &nbsp; changed lines`;

  // Context-collapse: unchanged runs longer than 6 lines only show the
  // first/last 3, so a one-line edit in a 2000-line file doesn't render
  // the whole file. Small unchanged runs stay fully visible for readability.
  const CONTEXT_EDGE = 3;
  const CONTEXT_COLLAPSE_THRESHOLD = 8;
  let html = '';
  let ctxRun = [];

  function flushCtxRun() {
    if (ctxRun.length === 0) return;
    if (ctxRun.length <= CONTEXT_COLLAPSE_THRESHOLD) {
      for (const line of ctxRun) html += diffLineHtml('ctx', line);
    } else {
      for (const line of ctxRun.slice(0, CONTEXT_EDGE)) html += diffLineHtml('ctx', line);
      html += `<div class="diff-line diff-line-ctx"><span class="diff-line-marker"> </span>… ${ctxRun.length - CONTEXT_EDGE * 2} unchanged lines …</div>`;
      for (const line of ctxRun.slice(-CONTEXT_EDGE)) html += diffLineHtml('ctx', line);
    }
    ctxRun = [];
  }

  for (const d of diff) {
    if (d.type === 'ctx') {
      ctxRun.push(d.text);
    } else {
      flushCtxRun();
      html += diffLineHtml(d.type, d.text);
    }
  }
  flushCtxRun();
  scroll.innerHTML = html;
}

function diffLineHtml(type, text) {
  const cls = type === 'add' ? 'diff-line-add' : type === 'del' ? 'diff-line-del' : 'diff-line-ctx';
  const marker = type === 'add' ? '+' : type === 'del' ? '−' : ' ';
  return `<div class="diff-line ${cls}"><span class="diff-line-marker">${marker}</span>${escHtml(text) || '&nbsp;'}</div>`;
}

async function commitEditorChange() {
  const saveBtn = document.getElementById('editor-save-btn');
  const statusLeft = document.getElementById('editor-status-left');
  const conflictNote = document.getElementById('editor-conflict-note');
  const textarea = document.getElementById('editor-textarea');

  saveBtn.disabled = true;
  saveBtn.classList.add('saving');
  saveBtn.textContent = 'Committing…';
  conflictNote.classList.remove('show');

  try {
    const res = await fetch('/api/file-source', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({
        repo: editorState.repo,
        path: editorState.path,
        content: textarea.value,
        sha: editorState.sha,
        message: `Edit ${editorState.path} via inline editor`,
      }),
    });
    const data = await res.json();

    if (res.status === 409) {
      // Conflict — someone/something changed the file since we opened it.
      conflictNote.classList.add('show');
      statusLeft.textContent = data.reply || 'Conflict.';
      saveBtn.disabled = false;
      saveBtn.classList.remove('saving');
      saveBtn.textContent = 'Commit change';
      return;
    }
    if (!res.ok) {
      statusLeft.textContent = data.reply || 'Save nahi hui.';
      saveBtn.disabled = false;
      saveBtn.classList.remove('saving');
      saveBtn.textContent = 'Commit change';
      return;
    }

    // Success — reflect it in chat history same as any other file-write
    // action, then close the editor.
    addMessage('agent', data.reply, 'success', null, data.action);
    history.push({ role: 'assistant', content: data.reply });
    closeCodeEditor();
  } catch (e) {
    statusLeft.textContent = '❌ Server se connect nahi ho paya.';
    saveBtn.disabled = false;
    saveBtn.classList.remove('saving');
    saveBtn.textContent = 'Commit change';
  }
}

function initCodeEditorHandlers() {
  const textarea = document.getElementById('editor-textarea');
  const gutter = document.getElementById('editor-gutter');
  const saveBtn = document.getElementById('editor-save-btn');
  const closeBtn = document.getElementById('editor-close-btn');

  textarea.addEventListener('input', () => { renderEditorGutter(); renderEditorHighlight(); });
  textarea.addEventListener('scroll', syncHighlightScroll);
  // Tab inserts two spaces instead of moving focus — expected editor
  // behavior, and without this a mobile keyboard's Tab key (if present)
  // would just jump focus away from the textarea.
  textarea.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    e.preventDefault();
    const start = textarea.selectionStart, end = textarea.selectionEnd;
    textarea.value = textarea.value.slice(0, start) + '  ' + textarea.value.slice(end);
    textarea.selectionStart = textarea.selectionEnd = start + 2;
    renderEditorGutter();
    renderEditorHighlight();
  });

  saveBtn.addEventListener('click', () => {
    if (!editorState) return;
    if (editorState.readOnly) {
      switchEditorToEditable();
      return;
    }
    if (editorState.mode === 'editing') {
      renderDiffPane();
      setEditorMode('diffing');
    } else {
      commitEditorChange();
    }
  });

  closeBtn.addEventListener('click', () => {
    if (editorState && editorState.mode === 'diffing') {
      // Back out of the diff view to keep editing, rather than closing —
      // closing entirely still needs a second tap, which also guards
      // against an accidental discard of unsaved edits.
      setEditorMode('editing');
      return;
    }
    closeCodeEditor();
  });
}
document.addEventListener('DOMContentLoaded', initCodeEditorHandlers);

function initCardDetailsSheetHandlers() {
  document.getElementById('card-details-close-btn').addEventListener('click', closeCardDetailsSheet);
  document.getElementById('card-details-backdrop').addEventListener('click', closeCardDetailsSheet);
}
document.addEventListener('DOMContentLoaded', initCardDetailsSheetHandlers);

function escHtml(t) {
  return t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── ADD MESSAGE ──
// Pure DOM rendering — no persistence, no confirm buttons. Used both for
// live messages and for replaying saved history on page load.
function formatTimestamp(ts) {
  const d = new Date(ts || Date.now());
  let h = d.getHours();
  const m = d.getMinutes().toString().padStart(2, '0');
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${m} ${ampm}`;
}

const DIVIDER_GAP_MS = 5 * 60 * 1000; // 5 minutes
let lastRenderedTs = null; // tracks the timestamp of the last message actually painted to #messages

function isSameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function formatDividerLabel(ts) {
  const d = new Date(ts);
  const now = new Date();
  const timeStr = formatTimestamp(ts);
  if (isSameDay(d, now)) return timeStr;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (isSameDay(d, yesterday)) return `Kal · ${timeStr}`;
  const dateStr = d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  return `${dateStr} · ${timeStr}`;
}

// Inserts a "── 5:32 PM ──" style divider into #messages if the gap since
// the last rendered message is 5+ minutes (or this is the first message
// in the view). Called right before a new message is painted.
function maybeInsertDivider(ts) {
  const messages = document.getElementById('messages');
  if (lastRenderedTs !== null && (ts - lastRenderedTs) < DIVIDER_GAP_MS) return;
  const divider = document.createElement('div');
  divider.className = 'time-divider';
  const label = document.createElement('span');
  label.textContent = formatDividerLabel(ts);
  divider.appendChild(label);
  messages.appendChild(divider);
}

function resetDividerTracking() {
  lastRenderedTs = null;
}

// Shared label builder (role name + timestamp) used by renderMessage and
// every one-off interactive bubble (env forms, confirm prompts, etc.) so
// the timestamp styling stays consistent everywhere a bubble appears.
function makeMsgLabel(role, timestamp = null) {
  const label = document.createElement('div');
  label.className = 'msg-label';
  const roleSpan = document.createElement('span');
  roleSpan.textContent = role === 'user' ? 'You' : 'Agent';
  const timeSpan = document.createElement('span');
  timeSpan.className = 'msg-timestamp';
  timeSpan.textContent = formatTimestamp(timestamp);
  label.appendChild(roleSpan);
  label.appendChild(timeSpan);
  return label;
}

function renderMessage(role, content, actionClass = '', timestamp = null, action = null) {
  const es = document.getElementById('empty-state');
  if (es) es.style.display = 'none';

  const messages = document.getElementById('messages');
  const ts = timestamp || Date.now();
  maybeInsertDivider(ts);
  lastRenderedTs = ts;

  const wrap = document.createElement('div');
  wrap.className = `msg-wrap ${role}`;

  const label = makeMsgLabel(role, ts);

  // Provider badge (GitHub / Vercel / Netlify / Render icon + name) appended
  // to the label row when this reply came from a known provider action —
  // lets the user recognize the source at a glance without reading the
  // whole bubble. Only meaningful for agent messages; silently no-ops for
  // user messages or unmapped actions (see providerBadgeFor above).
  if (role === 'agent') {
    const badgeKey = providerBadgeFor(action);
    if (badgeKey) {
      const badge = document.createElement('span');
      badge.className = 'provider-badge';
      badge.innerHTML = providerBadgeHtml(badgeKey);
      label.appendChild(badge);
    }
  }

  const bubble = document.createElement('div');
  bubble.className = `msg-bubble ${actionClass}`;
  bubble.innerHTML = role === 'user' ? escHtml(content) : renderMarkdown(content);

  wrap.appendChild(label);
  wrap.appendChild(bubble);
  messages.appendChild(wrap);
  return { wrap, bubble };
}

function addMessage(role, content, actionClass = '', confirmData = null, action = null) {
  const ts = Date.now();
  const { wrap, bubble } = renderMessage(role, content, actionClass, ts, action);

  // Confirm-action buttons are intentionally NOT saved to localStorage —
  // see the note above SESSIONS_KEY. They only ever exist live.
  if (confirmData) {
    const actions = document.createElement('div');
    actions.className = 'confirm-actions';

    // Server tells us which verb this confirmation is actually for
    // (confirm_verb: 'delete' | 'rollback', see build_confirmation in
    // server.py) — previously this button always said "Delete" even for
    // non-destructive-but-still-consequential actions like
    // VERCEL_ROLLBACK, which is misleading about what's about to happen.
    const isRollback = confirmData.confirm_verb === 'rollback';

    const yesBtn = document.createElement('button');
    yesBtn.className = 'confirm-btn danger';
    yesBtn.textContent = isRollback ? 'Haan, Rollback Karo' : 'Haan, Delete Karo';
    yesBtn.onclick = () => runConfirmedAction(confirmData, yesBtn, noBtn);

    const noBtn = document.createElement('button');
    noBtn.className = 'confirm-btn cancel';
    noBtn.textContent = 'Cancel';
    noBtn.onclick = () => {
      yesBtn.disabled = true;
      noBtn.disabled = true;
      addMessage('agent', isRollback ? 'Theek hai, cancel kar diya. Rollback nahi hua.' : 'Theek hai, cancel kar diya. Kuch delete nahi hua.', '');
    };

    actions.appendChild(yesBtn);
    actions.appendChild(noBtn);
    bubble.appendChild(actions);
  } else {
    // Only persist messages that aren't a live confirm-prompt — the prompt
    // text itself ("Pakka delete karna hai?") is fine to keep, just not
    // the still-clickable buttons.
    saveChatEntry({ role, content, actionClass, ts, action });
    addMessageActions(wrap, bubble, role, content, actionClass, () => resendMessage(content));
  }

  scrollToBottom();
}

// ── COPY / RETRY buttons under a message ──
// `retryFn` is only meaningful for user messages (re-sends the same text);
// agent messages only get a copy button.
// Clipboard write with a fallback for contexts where navigator.clipboard
// isn't available (older in-app webviews, non-HTTPS local testing, etc.)
// — uses a hidden textarea + document.execCommand as a last resort so the
// Copy button still works there instead of silently failing.
async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) { /* fall through to legacy path */ }
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch (e) {
    return false;
  }
}

function addMessageActions(wrap, bubble, role, plainText, actionClass, retryFn) {
  const actions = document.createElement('div');
  actions.className = 'msg-actions';

  const copyBtn = document.createElement('button');
  copyBtn.className = 'msg-action-btn copy';
  copyBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg> Copy`;
  copyBtn.onclick = async () => {
    await copyText(plainText);
    vibrate(8);
    copyBtn.classList.add('copied');
    copyBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg> Copied`;
    setTimeout(() => {
      copyBtn.classList.remove('copied');
      copyBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg> Copy`;
    }, 1500);
  };
  actions.appendChild(copyBtn);

  if (role === 'user' && retryFn) {
    const retryBtn = document.createElement('button');
    retryBtn.className = 'msg-action-btn retry';
    retryBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 4v6h6M23 20v-6h-6"/><path d="M20.49 9A9 9 0 005.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 013.51 15"/></svg> Retry`;
    retryBtn.onclick = () => { vibrate(10); retryFn(); };
    actions.appendChild(retryBtn);
  } else if (role === 'agent' && actionClass === 'error' && retryFn) {
    const retryBtn = document.createElement('button');
    retryBtn.className = 'msg-action-btn retry';
    retryBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 4v6h6M23 20v-6h-6"/><path d="M20.49 9A9 9 0 005.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 013.51 15"/></svg> Retry`;
    retryBtn.onclick = () => { vibrate(10); retryFn(); };
    actions.appendChild(retryBtn);
  }

  wrap.appendChild(actions);
}

// Re-sends a previously-sent user message through the normal pipeline.
function resendMessage(text) {
  const input = document.getElementById('userInput');
  input.value = text;
  sendMsg();
}

function vibrate(pattern) {
  try {
    if (appSettings.haptics !== false && navigator.vibrate) navigator.vibrate(pattern);
  } catch (e) { /* not supported — silently ignore */ }
}

const CONFIRM_ACTION_STATUS = {
  DELETE_REPO: 'Repo delete kar raha hu…',
  DELETE_FILE: 'File delete kar raha hu…',
  VERCEL_DELETE_PROJECT: 'Vercel project delete kar raha hu…',
  NETLIFY_DELETE_SITE: 'Netlify site delete kar raha hu…',
  RENDER_DELETE_SERVICE: 'Render service delete kar raha hu…',
  VERCEL_ROLLBACK: 'Vercel deployment rollback kar raha hu…',
  BULK_DELETE_FILES: 'Files delete kar raha hu…',
  BULK_DELETE_REPOS: 'Repos delete kar raha hu…',
  BULK_DELETE_VERCEL_PROJECTS: 'Vercel projects delete kar raha hu…',
};

// ── CONFIRMED DESTRUCTIVE ACTION ──
async function runConfirmedAction(confirmData, yesBtn, noBtn) {
  yesBtn.disabled = true;
  noBtn.disabled = true;
  yesBtn.textContent = 'Delete ho raha hai...';

  const typing = document.getElementById('typing-indicator');
  setThinkingStatus(CONFIRM_ACTION_STATUS[confirmData.pending_command] || 'Delete kar raha hu…');
  typing.classList.add('show');
  scrollToBottom();

  // Bulk ops (multi-select delete etc.) were built and confirmed via
  // /api/bulk-action, not /chat — the confirm token itself works the
  // same way either endpoint, but the confirmed-replay call has to hit
  // the endpoint that knows the op (delete_files/delete_repos/etc.),
  // since /chat's replay path only recognizes single-item commands.
  const endpoint = confirmData.bulk_op ? '/api/bulk-action' : '/chat';
  const payload = confirmData.bulk_op
    ? { op: confirmData.bulk_op, confirmed: true, pending_command: confirmData.pending_command,
        pending_value: confirmData.pending_value, confirm_token: confirmData.confirm_token }
    : { confirmed: true, pending_command: confirmData.pending_command,
        pending_value: confirmData.pending_value, confirm_token: confirmData.confirm_token };

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    typing.classList.remove('show');

    const cls = actionColorFor(data.action);
    addMessage('agent', data.reply, cls, null, data.action);
    history.push({ role: 'assistant', content: data.reply });
  } catch (err) {
    typing.classList.remove('show');
    addMessage('agent', '❌ Server se connect nahi ho paya. Page refresh karo.', 'error');
  }
}

// ── PROVIDER ICONS ──
// Real brand SVG marks (replacing the old emoji placeholders),
// used both in the Connected Apps drawer rows and in the small provider
// badges appended to agent message labels below.
const PROVIDER_ICONS = {
  github: '<svg viewBox="0 0 16 16" fill="#1B1F23" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M8 0C3.58 0 0 3.58 0 8C0 11.54 2.29 14.53 5.47 15.59C5.87 15.66 6.02 15.42 6.02 15.21C6.02 15.02 6.01 14.39 6.01 13.72C4 14.09 3.48 13.23 3.32 12.78C3.23 12.55 2.84 11.84 2.5 11.65C2.22 11.5 1.82 11.13 2.49 11.12C3.12 11.11 3.57 11.7 3.72 11.94C4.44 13.15 5.59 12.81 6.05 12.6C6.12 12.08 6.33 11.73 6.56 11.53C4.78 11.33 2.92 10.64 2.92 7.58C2.92 6.71 3.23 5.99 3.74 5.43C3.66 5.23 3.38 4.41 3.82 3.31C3.82 3.31 4.49 3.1 6.02 4.13C6.66 3.95 7.34 3.86 8.02 3.86C8.7 3.86 9.38 3.95 10.02 4.13C11.55 3.09 12.22 3.31 12.22 3.31C12.66 4.41 12.38 5.23 12.3 5.43C12.81 5.99 13.12 6.7 13.12 7.58C13.12 10.65 11.25 11.33 9.47 11.53C9.76 11.78 10.01 12.26 10.01 13.01C10.01 14.08 10 14.94 10 15.21C10 15.42 10.15 15.67 10.55 15.59C13.71 14.53 16 11.53 16 8C16 3.58 12.42 0 8 0Z"/></svg>',
  vercel: '<svg viewBox="0 0 256 222" fill="#000000" xmlns="http://www.w3.org/2000/svg"><polygon points="128 0 256 221.705 0 221.705"/></svg>',
  netlify: '<svg viewBox="0 0 554 554" xmlns="http://www.w3.org/2000/svg"><path d="M0 0 C182.82 0 365.64 0 554 0 C554 182.82 554 365.64 554 554 C371.18 554 188.36 554 0 554 C0 371.18 0 188.36 0 0 Z" fill="#FEFEFE"/><path d="M0 0 C0.67 -0.005 1.35 -0.009 2.04 -0.014 C4.31 -0.026 6.57 -0.017 8.83 -0.007 C10.46 -0.011 12.08 -0.017 13.7 -0.023 C18.11 -0.037 22.51 -0.032 26.92 -0.022 C31.53 -0.014 36.13 -0.021 40.74 -0.026 C48.48 -0.032 56.22 -0.024 63.95 -0.01 C72.9 0.006 81.86 0.001 90.81 -0.016 C98.49 -0.029 106.17 -0.031 113.84 -0.023 C118.43 -0.019 123.02 -0.018 127.61 -0.028 C131.93 -0.037 136.24 -0.031 140.55 -0.013 C142.14 -0.009 143.73 -0.01 145.31 -0.017 C147.47 -0.025 149.63 -0.015 151.79 0 C153 0.001 154.21 0.002 155.46 0.003 C158.4 0.381 158.4 0.381 160.28 1.784 C161.7 3.822 161.78 5.057 161.78 7.529 C161.79 8.36 161.8 9.191 161.81 10.047 C161.8 11.388 161.8 11.388 161.79 12.756 C161.8 14.137 161.8 14.137 161.8 15.546 C161.8 17.493 161.8 19.44 161.79 21.387 C161.77 24.37 161.79 27.351 161.81 30.334 C161.8 32.225 161.8 34.115 161.79 36.006 C161.8 36.9 161.81 37.794 161.81 38.714 C161.8 39.961 161.8 39.961 161.78 41.233 C161.78 41.963 161.78 42.693 161.78 43.446 C161.26 46.065 160.54 46.787 158.4 48.381 C155.46 48.758 155.46 48.758 151.79 48.762 C151.12 48.767 150.44 48.771 149.75 48.776 C147.48 48.788 145.22 48.779 142.96 48.769 C141.33 48.773 139.71 48.779 138.09 48.785 C133.69 48.799 129.28 48.793 124.87 48.784 C120.26 48.776 115.66 48.783 111.05 48.788 C103.31 48.794 95.58 48.786 87.84 48.772 C78.89 48.756 69.93 48.761 60.98 48.778 C53.3 48.791 45.63 48.793 37.95 48.785 C33.36 48.781 28.77 48.78 24.18 48.79 C19.86 48.798 15.55 48.793 11.24 48.775 C9.65 48.771 8.07 48.772 6.48 48.779 C4.32 48.787 2.16 48.777 0 48.762 C-1.21 48.761 -2.42 48.76 -3.67 48.758 C-6.6 48.381 -6.6 48.381 -8.49 46.978 C-9.91 44.94 -9.98 43.705 -9.99 41.233 C-10 40.402 -10.01 39.571 -10.02 38.714 C-10.02 37.821 -10.01 36.927 -10 36.006 C-10.01 35.085 -10.01 34.164 -10.01 33.215 C-10.01 31.269 -10.01 29.322 -10 27.375 C-9.98 24.392 -10 21.411 -10.01 18.428 C-10.01 16.537 -10.01 14.647 -10 12.756 C-10.01 11.862 -10.02 10.968 -10.02 10.047 C-10.01 9.216 -10 8.386 -9.99 7.529 C-9.99 6.799 -9.99 6.069 -9.99 5.316 C-8.91 -0.141 -4.81 0.004 0 0 Z" fill="#05BDBA" transform="translate(382.6,252.6)"/><path d="M0 0 C0.67 -0.005 1.35 -0.009 2.04 -0.014 C4.31 -0.026 6.57 -0.017 8.83 -0.007 C10.46 -0.011 12.08 -0.017 13.7 -0.023 C18.11 -0.037 22.51 -0.032 26.92 -0.022 C31.53 -0.014 36.13 -0.021 40.74 -0.026 C48.48 -0.032 56.22 -0.024 63.95 -0.01 C72.9 0.006 81.86 0.001 90.81 -0.016 C98.49 -0.029 106.17 -0.031 113.84 -0.023 C118.43 -0.019 123.02 -0.018 127.61 -0.028 C131.93 -0.037 136.24 -0.031 140.55 -0.013 C142.14 -0.009 143.73 -0.01 145.31 -0.017 C147.47 -0.025 149.63 -0.015 151.79 0 C153 0.001 154.21 0.002 155.46 0.003 C158.4 0.381 158.4 0.381 160.28 1.784 C161.7 3.822 161.78 5.057 161.78 7.529 C161.79 8.36 161.8 9.191 161.81 10.047 C161.8 11.388 161.8 11.388 161.79 12.756 C161.8 14.137 161.8 14.137 161.8 15.546 C161.8 17.493 161.8 19.44 161.79 21.387 C161.77 24.37 161.79 27.351 161.81 30.334 C161.8 32.225 161.8 34.115 161.79 36.006 C161.8 36.9 161.81 37.794 161.81 38.714 C161.8 39.961 161.8 39.961 161.78 41.233 C161.78 41.963 161.78 42.693 161.78 43.446 C161.26 46.065 160.54 46.787 158.4 48.381 C155.46 48.758 155.46 48.758 151.79 48.762 C151.12 48.767 150.44 48.771 149.75 48.776 C147.48 48.788 145.22 48.779 142.96 48.769 C141.33 48.773 139.71 48.779 138.09 48.785 C133.69 48.799 129.28 48.793 124.87 48.784 C120.26 48.776 115.66 48.783 111.05 48.788 C103.31 48.794 95.58 48.786 87.84 48.772 C78.89 48.756 69.93 48.761 60.98 48.778 C53.3 48.791 45.63 48.793 37.95 48.785 C33.36 48.781 28.77 48.78 24.18 48.79 C19.86 48.798 15.55 48.793 11.24 48.775 C9.65 48.771 8.07 48.772 6.48 48.779 C4.32 48.787 2.16 48.777 0 48.762 C-1.21 48.761 -2.42 48.76 -3.67 48.758 C-6.6 48.381 -6.6 48.381 -8.49 46.978 C-9.91 44.94 -9.98 43.705 -9.99 41.233 C-10 40.402 -10.01 39.571 -10.02 38.714 C-10.02 37.821 -10.01 36.927 -10 36.006 C-10.01 35.085 -10.01 34.164 -10.01 33.215 C-10.01 31.269 -10.01 29.322 -10 27.375 C-9.98 24.392 -10 21.411 -10.01 18.428 C-10.01 16.537 -10.01 14.647 -10 12.756 C-10.01 11.862 -10.02 10.968 -10.02 10.047 C-10.01 9.216 -10 8.386 -9.99 7.529 C-9.99 6.799 -9.99 6.069 -9.99 5.316 C-8.91 -0.141 -4.81 0.004 0 0 Z" fill="#05BDBA" transform="translate(19.6,252.6)"/><path d="M0 0 C0.83 -0.009 1.66 -0.019 2.52 -0.029 C3.41 -0.023 4.31 -0.017 5.23 -0.01 C6.15 -0.013 7.07 -0.016 8.02 -0.019 C9.96 -0.021 11.91 -0.015 13.86 -0.003 C16.84 0.013 19.82 -0.003 22.8 -0.022 C24.7 -0.02 26.59 -0.016 28.48 -0.01 C29.37 -0.016 30.26 -0.022 31.19 -0.029 C32.43 -0.014 32.43 -0.014 33.7 0 C34.8 0.004 34.8 0.004 35.92 0.007 C38.48 0.512 39.25 1.338 40.85 3.388 C41.23 5.686 41.23 5.686 41.23 8.436 C41.25 10.001 41.25 10.001 41.26 11.597 C41.25 12.741 41.25 13.885 41.24 15.064 C41.25 16.269 41.25 17.474 41.26 18.716 C41.27 22.022 41.26 25.327 41.25 28.633 C41.25 32.091 41.25 35.549 41.26 39.007 C41.26 44.814 41.26 50.621 41.24 56.428 C41.23 63.144 41.23 69.86 41.25 76.576 C41.26 82.34 41.26 88.104 41.26 93.868 C41.25 97.311 41.25 100.755 41.26 104.198 C41.27 108.037 41.26 111.874 41.24 115.712 C41.25 116.856 41.25 118 41.26 119.179 C41.25 120.222 41.24 121.265 41.23 122.34 C41.23 123.248 41.23 124.156 41.23 125.091 C40.78 127.84 40.05 128.726 37.85 130.388 C35.92 130.769 35.92 130.769 33.7 130.776 C32.46 130.791 32.46 130.791 31.19 130.805 C30.29 130.799 29.4 130.793 28.48 130.787 C27.1 130.791 27.1 130.791 25.69 130.795 C23.74 130.797 21.79 130.792 19.85 130.779 C16.86 130.763 13.88 130.779 10.9 130.798 C9.01 130.796 7.12 130.793 5.23 130.787 C4.33 130.793 3.44 130.799 2.52 130.805 C1.69 130.796 0.86 130.786 0 130.776 C-0.73 130.774 -1.46 130.772 -2.21 130.769 C-4.78 130.264 -5.54 129.438 -7.15 127.388 C-7.53 125.091 -7.53 125.091 -7.53 122.34 C-7.54 121.297 -7.55 120.254 -7.56 119.179 C-7.55 118.035 -7.54 116.891 -7.54 115.712 C-7.54 114.507 -7.55 113.302 -7.55 112.061 C-7.56 108.755 -7.56 105.449 -7.55 102.144 C-7.54 98.686 -7.55 95.228 -7.56 91.77 C-7.56 85.963 -7.55 80.155 -7.54 74.348 C-7.52 67.632 -7.53 60.916 -7.55 54.2 C-7.56 48.436 -7.56 42.673 -7.55 36.909 C-7.55 33.465 -7.55 30.022 -7.56 26.578 C-7.57 22.74 -7.55 18.902 -7.54 15.064 C-7.54 13.92 -7.55 12.776 -7.56 11.597 C-7.55 10.554 -7.54 9.511 -7.53 8.436 C-7.53 7.529 -7.53 6.621 -7.53 5.686 C-6.79 1.216 -4.25 0.014 0 0 Z" fill="#06BDBA" transform="translate(260.15,372.61)"/><path d="M0 0 C4.34 -0.074 8.68 -0.129 13.02 -0.165 C14.5 -0.18 15.98 -0.2 17.45 -0.226 C19.58 -0.263 21.7 -0.28 23.83 -0.293 C25.74 -0.317 25.74 -0.317 27.7 -0.341 C31.27 0.028 32.6 0.371 35 3 C38.9 11.588 39.28 22.51 36.24 31.419 C31.38 41.534 21.87 49.718 13.88 57.438 C13.37 57.925 12.87 58.413 12.35 58.916 C8.95 62.223 5.49 65.469 1.99 68.684 C1.08 69.526 0.17 70.368 -0.76 71.236 C-1.63 71.998 -2.49 72.76 -3.37 73.545 C-4.12 74.215 -4.87 74.885 -5.65 75.576 C-8.67 77.404 -10.52 77.442 -14 77 C-15.78 75.977 -15.78 75.977 -17.25 74.525 C-17.81 73.984 -18.37 73.442 -18.95 72.885 C-19.53 72.291 -20.11 71.698 -20.71 71.086 C-21.32 70.479 -21.94 69.871 -22.57 69.246 C-23.86 67.96 -25.14 66.667 -26.42 65.367 C-28.37 63.381 -30.35 61.43 -32.34 59.48 C-33.59 58.226 -34.84 56.969 -36.09 55.711 C-36.98 54.839 -36.98 54.839 -37.88 53.949 C-38.7 53.109 -38.7 53.109 -39.52 52.251 C-40.24 51.525 -40.24 51.525 -40.98 50.785 C-42.54 48.052 -42.39 46.089 -42 43 C-40.45 40.735 -40.45 40.735 -38.25 38.587 C-37.43 37.773 -36.62 36.959 -35.77 36.12 C-34.88 35.261 -33.99 34.401 -33.07 33.516 C-32.16 32.619 -31.25 31.722 -30.32 30.798 C-27.9 28.42 -25.48 26.057 -23.05 23.699 C-19.63 20.367 -16.23 17.011 -12.82 13.659 C-11.01 11.876 -9.19 10.098 -7.36 8.324 C-6.13 7.122 -6.13 7.122 -4.88 5.896 C-3.79 4.837 -3.79 4.837 -2.68 3.757 C-0.92 2.092 -0.92 2.092 0 0 Z" fill="#06BDBA" transform="translate(180,339)"/><path d="M0 0 C5.9 1.389 9.46 5.153 13.81 9.227 C14.75 10.111 15.7 10.994 16.67 11.904 C18.67 13.787 20.65 15.689 22.62 17.599 C24.62 19.528 26.65 21.402 28.73 23.241 C47 39.418 47 39.418 48.17 51.89 C49.26 70.389 49.26 70.389 45.03 76.188 C37.99 81.326 25.07 80.055 16.62 78.841 C5.61 76.606 -2.16 66.408 -9.27 58.351 C-11.14 56.276 -13.07 54.274 -15.02 52.27 C-17.35 49.86 -19.64 47.415 -21.93 44.966 C-22.78 44.061 -23.62 43.157 -24.49 42.225 C-27.76 38.548 -30.02 35.991 -31.16 31.157 C-29.97 26.716 -27.86 24.447 -24.62 21.286 C-24.04 20.697 -23.46 20.107 -22.86 19.5 C-21.62 18.262 -20.38 17.033 -19.13 15.812 C-17.22 13.944 -15.36 12.041 -13.49 10.132 C-12.29 8.931 -11.08 7.732 -9.87 6.536 C-9.32 5.967 -8.76 5.399 -8.19 4.813 C-5.48 2.208 -3.69 0.985 0 0 Z" fill="#06BDBA" transform="translate(168.28,137.12)"/></svg>',
  render: '<svg viewBox="0 0 554 554" xmlns="http://www.w3.org/2000/svg"><path d="M0 0 C182.82 0 365.64 0 554 0 C554 182.82 554 365.64 554 554 C371.18 554 188.36 554 0 554 C0 371.18 0 188.36 0 0 Z" fill="#000000"/><path d="M0 0 C42.57 0 85.14 0 129 0 C129 182.82 129 365.64 129 554 C37.59 554 -53.82 554 -148 554 C-148.1 517.84 -148.21 481.69 -148.31 444.44 C-148.36 433.04 -148.4 421.64 -148.45 409.89 C-148.47 395.93 -148.47 395.93 -148.48 389.38 C-148.48 384.83 -148.5 380.28 -148.53 375.72 C-148.56 369.9 -148.57 364.08 -148.57 358.26 C-148.57 356.13 -148.58 354 -148.6 351.87 C-148.79 330.16 -143.68 313.43 -128.33 297.27 C-111.19 280.56 -93.48 276.56 -70.33 276.56 C-68.32 276.55 -66.31 276.53 -64.3 276.52 C-59.02 276.48 -53.75 276.46 -48.47 276.45 C-40.05 276.42 -31.62 276.38 -23.2 276.33 C-20.28 276.31 -17.36 276.31 -14.44 276.3 C25.01 276.15 59.8 262.77 88 235 C88.9 234.13 89.8 233.27 90.73 232.38 C115.72 206.96 127.57 170.56 127.42 135.47 C127.19 125.02 125.51 115.12 123 105 C122.82 104.24 122.64 103.49 122.45 102.7 C117.57 82.83 107.3 64.49 94 49 C93.28 48.16 92.56 47.31 91.81 46.44 C73.21 25.22 48.33 10.65 20.94 4.31 C20.02 4.1 19.09 3.88 18.14 3.66 C12.11 2.32 6.16 1.47 0 1 C0 0.67 0 0.34 0 0 Z" fill="#FEFEFE" transform="translate(425,0)"/><path d="M0 0 C132.99 0 265.98 0 403 0 C403 0.33 403 0.66 403 1 C401.91 1.16 400.82 1.32 399.7 1.48 C369.66 6.04 343.05 16.49 321 38 C319.84 38.93 318.68 39.84 317.5 40.75 C295.15 59.84 283.46 91.53 279.13 119.63 C274.61 148.32 264.08 175.4 247 199 C246.58 199.59 246.16 200.17 245.73 200.77 C224.81 229.64 194.93 254.21 161 266 C160.27 266.26 159.53 266.51 158.78 266.77 C115.12 281.67 63.91 282.35 21.85 261.96 C18.99 260.52 16.13 259.07 13.31 257.54 C9.74 255.65 7.07 254.44 3 255 C1.36 256.64 1.87 258.51 1.86 260.78 C1.86 261.82 1.85 262.86 1.84 263.93 C1.84 265.09 1.84 266.24 1.84 267.43 C1.84 268.65 1.83 269.87 1.83 271.12 C1.81 274.52 1.81 277.91 1.8 281.31 C1.79 284.97 1.78 288.62 1.76 292.28 C1.74 298.62 1.72 304.96 1.71 311.29 C1.69 320.46 1.66 329.62 1.63 338.79 C1.58 353.66 1.54 368.53 1.5 383.39 C1.46 397.84 1.42 412.29 1.37 426.74 C1.37 427.63 1.37 428.52 1.36 429.43 C1.35 433.9 1.34 438.36 1.32 442.82 C1.21 479.88 1.1 516.94 1 554 C0.67 554 0.34 554 0 554 C0 371.18 0 188.36 0 0 Z" fill="#FEFEFE" transform="translate(0,0)"/></svg>',
};

// ── PROVIDER BADGE ──
// Maps an action string to a small icon + name tag (e.g. GitHub / Vercel
// mark) so a result is recognizable at a glance without reading the whole
// bubble — same icons already used elsewhere (Connected Apps rows).
const PROVIDER_BADGES = {
  create_repo: 'github', delete_repo: 'github',
  create_file: 'github', update_file: 'github', delete_file: 'github',
  list_repos: 'github', list_files: 'github', read_file: 'github', repo_info: 'github',
  vercel_list: 'vercel', vercel_import: 'vercel', vercel_deploy: 'vercel',
  vercel_deploy_pending: 'vercel', vercel_delete_project: 'vercel',
  vercel_env: 'vercel', vercel_env_set: 'vercel',
  netlify_list: 'netlify', netlify_site_info: 'netlify', netlify_delete_site: 'netlify',
  netlify_env: 'netlify', netlify_env_set: 'netlify',
  render_list: 'render', render_delete_service: 'render',
  render_env: 'render', render_env_update: 'render', render_deploy: 'render',
};
const PROVIDER_NAMES = { github: 'GitHub', vercel: 'Vercel', netlify: 'Netlify', render: 'Render' };
// Builds the small pill HTML (icon + name) for a provider key, used by
// both the hardcoded spots and the config-driven ones.
function providerBadgeHtml(key) {
  if (!key || !PROVIDER_ICONS[key]) return '';
  return `<span class="provider-badge-icon">${PROVIDER_ICONS[key]}</span>${PROVIDER_NAMES[key]}`;
}

// ══════════════════════════════════════════════════════════════════
// TASK-AWARE LOADING STATUS
// The typing indicator used to always say "Sochte hue..." regardless of
// what was actually happening, which felt like a black box even for
// simple, fast commands. This guesses a short, specific status phrase
// from the outgoing message text — same intent vocabulary as
// PROVIDER_BADGES/actionColorFor above — and swaps it into the
// #think-text span. It's a client-side guess (not fed by the server's
// actual regex parser), so it's deliberately generic enough to stay
// truthful even if the guess is imprecise: "Repo dhoondh raha hu" is
// accurate whether the backend resolves it via regex or the AI fallback.
// Falls back to the original "Sochte hue..." for anything unmatched
// (free-form/AI-fallback requests, where there's no fast local guess).
// ══════════════════════════════════════════════════════════════════
const STATUS_PATTERNS = [
  { re: /\bdelete\b.*\brepo|\brepo\b.*\b(delete|uda|hata)/i, text: 'Repo delete kar raha hu…' },
  { re: /\b(create|bana|naya)\b.*\brepo/i, text: 'Naya repo bana raha hu…' },
  { re: /\blist\b.*\brepo|\bsare\b.*\brepo|\bmere\b.*\brepo/i, text: 'Repos fetch kar raha hu…' },
  { re: /\binfo\b.*\brepo|\brepo\b.*\binfo/i, text: 'Repo details laa raha hu…' },
  { re: /\blist\b.*\bfiles?\b|\bfiles?\b.*\bin\b/i, text: 'Files list kar raha hu…' },
  { re: /\bread\b.*\bfile|\bpadh/i, text: 'File padh raha hu…' },
  { re: /\bdelete\b.*\bfile|\bfile\b.*\b(delete|uda|hata)/i, text: 'File delete kar raha hu…' },
  { re: /\b(edit|update|badal)\b.*\bfile/i, text: 'File update kar raha hu…' },
  { re: /\b(create|bana|naya)\b.*\bfile/i, text: 'File bana raha hu…' },
  { re: /\bimport\b.*\bvercel|\bvercel\b.*\bimport/i, text: 'Vercel pe import kar raha hu…' },
  { re: /\bdeploy\b.*\bvercel/i, text: 'Vercel pe deploy kar raha hu…' },
  { re: /\bdelete\b.*\bvercel/i, text: 'Vercel project delete kar raha hu…' },
  { re: /\bvercel\b.*\benv|\benv\b.*\bvercel/i, text: 'Vercel env vars check kar raha hu…' },
  { re: /\blist\b.*\bvercel/i, text: 'Vercel projects fetch kar raha hu…' },
  { re: /\bnetlify\b.*\bsite|\bsite\b.*\bnetlify/i, text: 'Netlify se baat kar raha hu…' },
  { re: /\bnetlify/i, text: 'Netlify se baat kar raha hu…' },
  { re: /\bdeploy\b.*\brender|\brender\b.*\bdeploy/i, text: 'Render deploy trigger kar raha hu…' },
  { re: /\brender\b.*\bdelete|\bdelete\b.*\brender/i, text: 'Render service delete kar raha hu…' },
  { re: /\brender/i, text: 'Render se baat kar raha hu…' },
];

function guessStatusText(userMessage) {
  const msg = (userMessage || '').toLowerCase();
  for (const p of STATUS_PATTERNS) {
    if (p.re.test(msg)) return p.text;
  }
  return 'Sochte hue…';
}

function setThinkingStatus(text) {
  const el = document.getElementById('think-text');
  if (el) el.textContent = text || 'Sochte hue…';
}

function providerBadgeFor(action) {
  return PROVIDER_BADGES[action] || null;
}

function actionColorFor(action) {
  const actionColors = {
    create_repo: 'success', delete_repo: 'success',
    create_file: 'success', update_file: 'success', delete_file: 'success',
    list_repos: 'info', list_files: 'info', read_file: 'info', repo_info: 'info',
    vercel_list: 'info', vercel_import: 'success', vercel_deploy: 'success',
    vercel_deploy_pending: 'warning', vercel_delete_project: 'success',
    vercel_env: 'info', vercel_env_set: 'success',
    vercel_rollback: 'success', vercel_deployments: 'info',
    netlify_list: 'info', netlify_site_info: 'info', netlify_delete_site: 'success',
    netlify_env: 'info', netlify_env_set: 'success',
    render_list: 'info', render_delete_service: 'success',
    render_env: 'info', render_env_update: 'success', render_deploy: 'success',
    confirm_required: 'warning', auth_required: 'warning',
    vercel_auth_required: 'warning', netlify_auth_required: 'warning', render_auth_required: 'warning',
    error: 'error', warning: 'warning', message: ''
  };
  return actionColors[action] || '';
}

function scrollToBottom(force) {
  const area = document.getElementById('scroll-area');
  // Respect the "auto-scroll" setting for automatic calls (e.g. after every
  // new message), but always honor an explicit user tap on the FAB itself.
  if (!force && appSettings.autoscroll === false) return;
  requestAnimationFrame(() => {
    area.scrollTop = area.scrollHeight;
    updateScrollFab();
  });
}

function updateScrollFab() {
  const area = document.getElementById('scroll-area');
  const fab = document.getElementById('scroll-fab');
  if (!area || !fab) return;
  const distanceFromBottom = area.scrollHeight - area.scrollTop - area.clientHeight;
  const shouldShow = distanceFromBottom > 240;
  fab.classList.toggle('show', shouldShow);
  if (!shouldShow) fab.classList.remove('has-new');
}

document.addEventListener('DOMContentLoaded', () => {
  const area = document.getElementById('scroll-area');
  if (area) area.addEventListener('scroll', updateScrollFab);
  initDragDrop();
});

// ══════════════════════════════════════════════════════════════════
// FULL-SCREEN DRAG & DROP
// Listens on the whole document so a file can be dropped anywhere in
// the app, not just a specific target. dragenter/dragleave use a
// counter because those events fire on every child element the
// cursor crosses — without it the overlay flickers on/off as the
// pointer moves over nested elements during a drag.
// A single dropped .zip routes to the zip pipeline (matches the clip
// menu's "Upload zip" behavior); anything else (one or more files,
// or a dropped folder via webkitGetAsEntry) goes through the regular
// multi-file upload pipeline.
// ══════════════════════════════════════════════════════════════════
let dragCounter = 0;

function initDragDrop() {
  const overlay = document.getElementById('dropzone-overlay');
  if (!overlay) return;

  document.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
    e.preventDefault();
    dragCounter++;
    overlay.classList.add('show');
  });

  document.addEventListener('dragover', (e) => {
    if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
    e.preventDefault();
  });

  document.addEventListener('dragleave', (e) => {
    if (!e.dataTransfer) return;
    dragCounter = Math.max(0, dragCounter - 1);
    if (dragCounter === 0) overlay.classList.remove('show');
  });

  document.addEventListener('drop', async (e) => {
    if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
    e.preventDefault();
    dragCounter = 0;
    overlay.classList.remove('show');

    const files = await filesFromDataTransfer(e.dataTransfer);
    if (!files.length) return;

    if (files.length === 1 && /\.zip$/i.test(files[0].name)) {
      askZipUploadRepo(files[0]);
    } else {
      askUploadRepo(files);
    }
  });

  // Dropping outside the window entirely (e.g. onto another app) never
  // fires 'drop' on our document — reset the counter/overlay on
  // window blur as a safety net so it can't get stuck open.
  window.addEventListener('blur', () => { dragCounter = 0; overlay.classList.remove('show'); });
}

// Resolves dropped items to a flat File[] list, walking folders
// recursively via the (Chromium/WebKit) FileSystem entry API when
// available so a dropped folder behaves like the folder picker
// (relativePath preserved for nested-path uploads). Falls back to
// dataTransfer.files directly on browsers without entry support.
function filesFromDataTransfer(dataTransfer) {
  const items = dataTransfer.items;
  if (!items || !items.length || !items[0].webkitGetAsEntry) {
    return Promise.resolve(Array.from(dataTransfer.files || []));
  }

  const entries = Array.from(items)
    .map(it => it.webkitGetAsEntry && it.webkitGetAsEntry())
    .filter(Boolean);
  if (!entries.length) return Promise.resolve(Array.from(dataTransfer.files || []));

  const out = [];
  function readEntry(entry, prefix) {
    return new Promise((resolve) => {
      if (entry.isFile) {
        entry.file(file => {
          if (prefix) {
            try { Object.defineProperty(file, 'webkitRelativePath', { value: prefix + file.name }); } catch (_) {}
          }
          out.push(file);
          resolve();
        }, () => resolve());
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        const readBatch = () => {
          reader.readEntries(async (children) => {
            if (!children.length) { resolve(); return; }
            await Promise.all(children.map(c => readEntry(c, prefix + entry.name + '/')));
            readBatch(); // readEntries may not return everything in one call
          }, () => resolve());
        };
        readBatch();
      } else {
        resolve();
      }
    });
  }

  return Promise.all(entries.map(en => readEntry(en, ''))).then(() => out);
}

// ── SEND ──
async function sendMsg() {
  if (isLoading) return;

  const input = document.getElementById('userInput');
  const msg = input.value.trim();
  if (!msg) return;

  // Mobile keyboards only reopen on a real user gesture — calling
  // .focus() after an `await` (i.e. once the response comes back) is a
  // *programmatic* focus with no gesture behind it, so most mobile
  // browsers move the cursor back into the field but keep the keyboard
  // hidden, forcing a manual tap to type again. Remembering whether the
  // field was actually focused (keyboard likely open) at send-time lets
  // the `finally` block below skip the no-op refocus when it wouldn't
  // bring the keyboard back anyway, and keeps it for desktop/hardware-
  // keyboard users where refocusing is still the right call.
  const wasInputFocused = document.activeElement === input;

  isLoading = true;
  userCancelled = false;
  input.value = '';
  autoResize(input);
  hideSuggestions();
  setSendBtnState(true);

  addMessage('user', msg);
  history.push({ role: 'user', content: msg });

  const typing = document.getElementById('typing-indicator');
  setThinkingStatus(guessStatusText(msg));
  typing.classList.add('show');
  scrollToBottom();

  const controller = new AbortController();
  activeController = controller;

  try {
    const res = await fetch('/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: msg, history: history.slice(0, -1) }),
      signal: controller.signal
    });

    const data = await res.json();
    typing.classList.remove('show');

    if (data.action === 'confirm_required') {
      addMessage('agent', data.reply, 'warning', {
        pending_command: data.pending_command,
        pending_value: data.pending_value,
        confirm_token: data.confirm_token,
        confirm_verb: data.confirm_verb
      });
      return;
    }

    // ── RICH BUBBLES: list_files / read_file / list_repos / vercel_list /
    // netlify_list / render_list → structured DOM widgets instead of a
    // plain text block. buildRichBubbleNode() (single source of truth,
    // shared with the page-load restore path) decides whether this action
    // has a widget; falls through to the normal text bubble below if not,
    // or if the underlying array is missing/empty (server already sends a
    // friendly "koi X nahi mila" reply for the empty case).
    {
      const richNode = buildRichBubbleNode(data);
      if (richNode) {
        const es = document.getElementById('empty-state');
        if (es) es.style.display = 'none';
        const messages = document.getElementById('messages');
        const wrap = document.createElement('div');
        wrap.className = 'msg-wrap agent';
        const label = document.createElement('div');
        label.className = 'msg-label';
        label.textContent = 'Agent';
        const badgeKey = richBubbleBadgeFor(data);
        if (badgeKey) {
          const badge = document.createElement('span');
          badge.className = 'provider-badge';
          badge.innerHTML = providerBadgeHtml(badgeKey);
          label.appendChild(badge);
        }
        const bubble = document.createElement('div');
        bubble.className = 'msg-bubble info';
        bubble.appendChild(richNode);
        wrap.appendChild(label);
        wrap.appendChild(bubble);
        messages.appendChild(wrap);
        // Persist the full structured payload (items/repos/projects/etc),
        // not just the plain-text reply — this is what makes the card
        // survive a page refresh instead of degrading to a text bubble.
        saveChatEntry({
          role: 'agent', content: data.reply, actionClass: 'info', ts: Date.now(),
          action: data.action, repo: data.repo, path: data.path,
          items: data.items, repos: data.repos, projects: data.projects,
          sites: data.sites, services: data.services,
          // read_file's raw (unwrapped, un-fenced) file text — needed so
          // the preview/full-screen viewer can re-render correctly after
          // a page refresh instead of falling back to the markdown-fenced
          // `reply` string, which would show fence markers as if they
          // were file content.
          fileContent: data.action === 'read_file' ? data.content : undefined,
        });
        history.push({ role: 'assistant', content: data.reply });
        scrollToBottom();
        return;
      }
    }

    // ── AUTH: session expired / not connected mid-conversation ──
    if (data.action === 'auth_required') {
      addMessage('agent', data.reply, 'warning');
      showLoginGate();
      return;
    }

    // ── VERCEL AUTH: not connected, or token expired/revoked ──
    if (data.action === 'vercel_auth_required') {
      addMessage('agent', data.reply, 'warning');
      showVercelModal();
      return;
    }

    // ── NETLIFY AUTH: not connected, or token expired/revoked ──
    if (data.action === 'netlify_auth_required') {
      addMessage('agent', data.reply, 'warning');
      showNetlifyModal();
      return;
    }

    // ── RENDER AUTH: not connected, or token expired/revoked ──
    if (data.action === 'render_auth_required') {
      addMessage('agent', data.reply, 'warning');
      showRenderModal();
      return;
    }

    // ── LIVE DEPLOY TERMINAL: Vercel deploy triggered → slide-up build
    // logs instead of just a text bubble. Still posts the normal chat
    // bubble too (so the reply is in history/scrollback either way), then
    // opens the terminal on top of it. 'vercel_deploy_pending' means the
    // 25s synchronous poll on the server timed out while still BUILDING —
    // the terminal keeps polling client-side past that point.
    if ((data.action === 'vercel_deploy' || data.action === 'vercel_deploy_pending') && data.deployment_id) {
      const cls = actionColorFor(data.action);
      addMessage('agent', data.reply, cls, null, data.action);
      history.push({ role: 'assistant', content: data.reply });
      openDeployTerminal(data.deployment_id, data.project_name || '');
      return;
    }

    const cls = actionColorFor(data.action);
    addMessage('agent', data.reply, cls, null, data.action);
    history.push({ role: 'assistant', content: data.reply });

  } catch (err) {
    typing.classList.remove('show');
    if (userCancelled || err.name === 'AbortError') {
      addMessage('agent', '⏹️ Rok diya. Kuch aur poochna hai?', '');
    } else {
      addMessage('agent', '❌ Server se connect nahi ho paya. Page refresh karo.', 'error');
    }
  } finally {
    isLoading = false;
    userCancelled = false;
    activeController = null;
    setSendBtnState(false);
    // See the comment above wasInputFocused: only refocus if the field
    // was genuinely focused (soft keyboard open) when send happened, and
    // do it on the next frame — still not a "real" gesture, but this at
    // least avoids yanking focus back onto a field the user had already
    // moved away from (e.g. tapped a confirm button, opened the drawer)
    // while the request was in flight, which was its own small bug.
    if (wasInputFocused) {
      requestAnimationFrame(() => input.focus());
    }
  }
}

function setSendBtnState(loading) {
  const btn = document.getElementById('sendBtn');
  const sendIcon = document.getElementById('sendIcon');
  const stopIcon = document.getElementById('stopIcon');
  btn.disabled = false; // stays clickable in both states — click means Stop while loading
  btn.classList.toggle('stopping', loading);
  btn.title = loading ? 'Rokne ke liye tap karo' : 'Bhejo';
  sendIcon.style.display = loading ? 'none' : 'block';
  stopIcon.style.display = loading ? 'block' : 'none';
}

function handleSendBtnClick() {
  vibrate(10);
  if (isLoading) {
    stopActiveRequest();
  } else {
    sendMsg();
  }
}

function stopActiveRequest() {
  if (activeController) {
    userCancelled = true;
    activeController.abort();
  }
}

// ── CLEAR CHAT ──
function confirmClearChat() {
  // If the user has turned off "confirm before clearing" in Settings, just
  // clear the active session instantly instead of showing the prompt.
  if (appSettings.confirmClear === false) {
    clearSavedChat();
    renderActiveChatIntoView();
    return;
  }

  const messages = document.getElementById('messages');
  const wrap = document.createElement('div');
  wrap.className = 'msg-wrap agent';

  const label = document.createElement('div');
  label.className = 'msg-label';
  label.textContent = 'Agent';

  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble warning';
  bubble.innerHTML = 'Is chat ki history clear kar du? Ye sirf is device se hatega, GitHub/Vercel/Netlify pe kuch nahi hoga.';

  const actions = document.createElement('div');
  actions.className = 'confirm-actions';

  const yesBtn = document.createElement('button');
  yesBtn.className = 'confirm-btn danger';
  yesBtn.textContent = 'Haan, Clear Karo';
  yesBtn.onclick = () => {
    clearSavedChat();
    renderActiveChatIntoView();
  };

  const noBtn = document.createElement('button');
  noBtn.className = 'confirm-btn cancel';
  noBtn.textContent = 'Cancel';
  noBtn.onclick = () => {
    yesBtn.disabled = true;
    noBtn.disabled = true;
  };

  actions.appendChild(yesBtn);
  actions.appendChild(noBtn);
  bubble.appendChild(actions);
  wrap.appendChild(label);
  wrap.appendChild(bubble);
  messages.appendChild(wrap);
  scrollToBottom();
}

// ══════════════════════════════════════════════════════════════════
// HAMBURGER DRAWER — open/close, populated with chat history (above),
// connected apps, and settings (below).
// ══════════════════════════════════════════════════════════════════
function openDrawer() {
  vibrate(8);
  document.getElementById('drawer').classList.add('show');
  document.getElementById('drawer-overlay').classList.add('show');
  renderDrawerProfile();
  renderChatHistoryList();
  renderAppsList();
}

function closeDrawer() {
  document.getElementById('drawer').classList.remove('show');
  document.getElementById('drawer-overlay').classList.remove('show');
}

// ══════════════════════════════════════════════════════════════════
// LIVE DEPLOY TERMINAL
// Slide-up drawer that polls /api/vercel/deploy-events every ~2.5s while
// a Vercel deployment is in progress, instead of leaving the chat stuck
// on "Sochte hue...". Opened automatically whenever a /chat response
// comes back with action 'vercel_deploy' or 'vercel_deploy_pending' and
// a deployment_id. Manual close (X button or overlay tap) just hides the
// panel and stops polling — it doesn't cancel the actual Vercel build.
// ══════════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════════
// INLINE DEPLOY LOG CARD
// Used to be a fixed slide-up drawer covering most of the screen; now
// it's a normal rich agent-message card appended straight into the chat
// thread (same insertion pattern as buildRichBubbleNode's other cards),
// so a live Vercel build shows up like any other agent response instead
// of taking over the screen. Only used for the 'vercel_deploy_pending'
// case (server's own 25s synchronous poll timed out while still
// building) — a deploy that already finished synchronously just gets
// its normal text/success bubble, no card needed.
// ══════════════════════════════════════════════════════════════════
let deployTerminalPollTimer = null;
let deployTerminalSince = 0;
let deployTerminalActive = false;
let deployTerminalConsecutiveErrors = 0;
let deployTerminalPollCount = 0;

// Safety caps so a bad deployment_id (e.g. one that 404s forever) or a
// persistent network failure can't leave this polling silently forever
// in the background: a fixed number of consecutive network-error retries
// (with linear backoff), and a hard ceiling on total polls regardless of
// state (covers "state never leaves UNKNOWN" — that's also not in
// VERCEL_TERMINAL_STATES so `done` would never naturally become true).
const DEPLOY_POLL_MAX_CONSECUTIVE_ERRORS = 5;
const DEPLOY_POLL_MAX_TOTAL_POLLS = 240; // ~ safety ceiling regardless of interval/backoff

// Heuristic for coloring a log line as an error in the card — Vercel's
// build output doesn't tag lines with a severity, so this matches on the
// same keywords a developer would visually scan for in a real terminal.
const DEPLOY_ERROR_LINE_RE = /\b(error|failed|exception|traceback|fatal|cannot find module|enoent|npm err!)\b/i;

// Holds references to the currently-live card's elements so the poll
// loop (a single global loop, same as before — only one deploy is
// tracked live at a time) can update them without re-querying the DOM
// by ID every tick. Only one card is ever "live" at once: opening a new
// one clears the previous poll loop first (same guard as before).
let liveDeployCard = null;

function buildDeployLogCard(deploymentId, projectName) {
  const card = document.createElement('div');
  card.className = 'deploy-log-card';

  const header = document.createElement('div');
  header.className = 'deploy-log-header';
  const dot = document.createElement('div');
  dot.className = 'deploy-log-dot';
  const title = document.createElement('div');
  title.className = 'deploy-log-title';
  title.textContent = 'Deploying' + (projectName ? ` — ${projectName}` : '');
  const sub = document.createElement('div');
  sub.className = 'deploy-log-title-sub';
  sub.textContent = 'Vercel · live build logs';
  title.appendChild(sub);
  header.appendChild(dot);
  header.appendChild(title);

  const body = document.createElement('div');
  body.className = 'deploy-log-body';
  body.innerHTML = '<div class="deploy-log-empty">Connecting to Vercel…</div>';

  const aiBlock = document.createElement('div');
  aiBlock.className = 'deploy-log-ai';
  const aiHead = document.createElement('div');
  aiHead.className = 'deploy-log-ai-head';
  aiHead.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l2.4 7.2H22l-6 4.6 2.3 7.2-6.3-4.6-6.3 4.6 2.3-7.2-6-4.6h7.6z"/></svg> AI ne error dekha';
  const aiBody = document.createElement('div');
  aiBody.className = 'deploy-log-ai-body';
  aiBody.innerHTML = '<span class="deploy-log-ai-loading">Analyze ho raha hai…</span>';
  aiBlock.appendChild(aiHead);
  aiBlock.appendChild(aiBody);

  const footer = document.createElement('div');
  footer.className = 'deploy-log-footer';
  const status = document.createElement('div');
  status.className = 'deploy-log-status';
  status.textContent = 'Build chal raha hai…';
  const link = document.createElement('a');
  link.className = 'deploy-log-link';
  link.href = '#';
  link.target = '_blank';
  link.rel = 'noopener';
  link.style.display = 'none';
  link.textContent = 'Live URL kholo →';
  footer.appendChild(status);
  footer.appendChild(link);

  card.appendChild(header);
  card.appendChild(body);
  card.appendChild(aiBlock);
  card.appendChild(footer);

  return { card, dot, body, aiBlock, aiBody, status, link };
}

function openDeployTerminal(deploymentId, projectName) {
  // A previous deployment's poll loop may still have a pending setTimeout
  // if this is called again before that one reached a terminal state
  // (e.g. user redeploys while the last card was still live). Without
  // this, the old timer fires later with the OLD deploymentId still in
  // its closure and both loops write into the same card DOM concurrently.
  // Clearing it here guarantees only one loop is ever in flight.
  if (deployTerminalPollTimer) {
    clearTimeout(deployTerminalPollTimer);
    deployTerminalPollTimer = null;
  }

  deployTerminalActive = true;
  deployTerminalSince = 0;
  deployTerminalConsecutiveErrors = 0;
  deployTerminalPollCount = 0;
  errorAnalysisRequested = false;

  const refs = buildDeployLogCard(deploymentId, projectName);
  liveDeployCard = refs;

  const es = document.getElementById('empty-state');
  if (es) es.style.display = 'none';
  const messages = document.getElementById('messages');
  const wrap = document.createElement('div');
  wrap.className = 'msg-wrap agent';
  const label = document.createElement('div');
  label.className = 'msg-label';
  label.textContent = 'Agent';
  const badge = document.createElement('span');
  badge.className = 'provider-badge';
  badge.innerHTML = providerBadgeHtml('vercel');
  label.appendChild(badge);
  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble info';
  bubble.appendChild(refs.card);
  wrap.appendChild(label);
  wrap.appendChild(bubble);
  messages.appendChild(wrap);
  scrollToBottom();
  vibrate(8);

  pollDeployEvents(deploymentId);
}

// Ends the poll loop and shows a clear "give up" state, instead of the
// loop just silently stopping — a stuck "Building…" card with polling
// quietly dead in the background (or, before this fix, quietly running
// forever) is worse than a message that says "we're not sure, check
// Vercel directly."
function stopDeployPollingWithMessage(text) {
  deployTerminalActive = false;
  if (deployTerminalPollTimer) {
    clearTimeout(deployTerminalPollTimer);
    deployTerminalPollTimer = null;
  }
  if (liveDeployCard) {
    liveDeployCard.card.classList.add('state-error');
    liveDeployCard.status.textContent = text;
    liveDeployCard.status.className = 'deploy-log-status is-error';
  }
  appendDeployLogLine(text, true);
}

async function pollDeployEvents(deploymentId) {
  if (!deployTerminalActive || !liveDeployCard) return;

  deployTerminalPollCount++;
  if (deployTerminalPollCount > DEPLOY_POLL_MAX_TOTAL_POLLS) {
    stopDeployPollingWithMessage('⏱️ Bahut der ho gayi status confirm karne me. Vercel dashboard pe seedha check karo.');
    return;
  }

  const { card, body, status, link } = liveDeployCard;

  try {
    const url = `/api/vercel/deploy-events?deployment_id=${encodeURIComponent(deploymentId)}&since=${deployTerminalSince}`;
    const res = await fetch(url);

    if (res.status === 401) {
      appendDeployLogLine('Session/Vercel connection expired.', true);
      status.textContent = 'Connection expired';
      status.className = 'deploy-log-status is-error';
      card.classList.add('state-error');
      deployTerminalActive = false;
      return;
    }

    if (!res.ok) {
      // Non-401 HTTP error (500, etc.) — treat like a network hiccup:
      // retry with the same backoff/cap as a thrown fetch error, rather
      // than trying to read a body that may not be the expected shape.
      throw new Error(`HTTP ${res.status}`);
    }

    const data = await res.json();
    deployTerminalConsecutiveErrors = 0; // reset on any successful, well-formed response

    const emptyPlaceholder = body.querySelector('.deploy-log-empty');
    if (emptyPlaceholder && data.lines && data.lines.length) emptyPlaceholder.remove();

    (data.lines || []).forEach(line => appendDeployLogLine(line, DEPLOY_ERROR_LINE_RE.test(line)));
    if (typeof data.since === 'number') deployTerminalSince = data.since;

    if (data.state === 'READY') {
      card.classList.add('state-ready');
      status.textContent = '✓ Deployment live';
      status.className = 'deploy-log-status is-ready';
      if (data.live_url) {
        link.href = data.live_url;
        link.style.display = '';
      }
    } else if (data.state === 'ERROR' || data.state === 'CANCELED') {
      card.classList.add('state-error');
      status.textContent = data.error_message || 'Build fail ho gaya';
      status.className = 'deploy-log-status is-error';
      if (data.error_message) appendDeployLogLine(data.error_message, true);
      if (data.state === 'ERROR') requestErrorAnalysis(data.error_message);
    } else {
      status.textContent = `Building… (${data.state || 'BUILDING'})`;
    }

    if (data.done) {
      deployTerminalPollTimer = null;
      // A fast build can reach a terminal state (READY/ERROR/CANCELED)
      // without ever streaming a single build-log line — Vercel's events
      // API can lag behind or simply have nothing to report for a build
      // that finished in a couple seconds. Without this, "Connecting to
      // Vercel…" was left sitting in the log body forever even though the
      // footer above it already said "Deployment live", which read as
      // stuck/broken. If nothing ever arrived, swap the placeholder for a
      // clear final line instead of leaving stale connecting-text behind.
      const stillEmpty = body.querySelector('.deploy-log-empty');
      if (stillEmpty) {
        stillEmpty.textContent = data.state === 'READY'
          ? 'Build itni jaldi complete hui ki koi log line stream nahi hui.'
          : 'Koi build log nahi mili.';
      }
      return; // terminal state reached — stop polling, leave card as-is in the thread
    }
  } catch (err) {
    deployTerminalConsecutiveErrors++;
    if (deployTerminalConsecutiveErrors >= DEPLOY_POLL_MAX_CONSECUTIVE_ERRORS) {
      stopDeployPollingWithMessage('❌ Log stream se baar-baar connect nahi ho paya. Ruk gaya — Vercel dashboard pe check karo.');
      return;
    }
    appendDeployLogLine(`Log stream se connect nahi ho paya, retry ho raha hai… (${deployTerminalConsecutiveErrors}/${DEPLOY_POLL_MAX_CONSECUTIVE_ERRORS})`, false);
  }

  // Linear backoff on consecutive network errors (2.5s → 5s → 7.5s...)
  // instead of hammering a struggling connection/endpoint every 2.5s
  // regardless of how many attempts have already failed.
  const interval = 2500 + (deployTerminalConsecutiveErrors * 2500);
  deployTerminalPollTimer = setTimeout(() => pollDeployEvents(deploymentId), interval);
}

// AI error troubleshooting — fires once per failed deployment. Collects the
// error-highlighted lines currently in the log DOM (cheap, avoids a second
// server round-trip to re-fetch them) and sends them + the error_message to
// the backend for a short diagnosis, rendered in the card's AI block.
let errorAnalysisRequested = false;

function requestErrorAnalysis(errorMessage) {
  if (errorAnalysisRequested || !liveDeployCard) return;
  errorAnalysisRequested = true;

  const { body, aiBlock, aiBody } = liveDeployCard;
  aiBlock.classList.add('show');
  aiBody.innerHTML = '<span class="deploy-log-ai-loading">Analyze ho raha hai…</span>';

  const allLines = Array.from(body.querySelectorAll('.deploy-log-line')).map(el => el.textContent);

  fetch('/api/vercel/analyze-error', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lines: allLines, error_message: errorMessage || '' }),
  })
    .then(res => res.json())
    .then(data => {
      if (data.suggestion) {
        aiBody.textContent = data.suggestion;
      } else {
        aiBlock.classList.remove('show');
      }
    })
    .catch(() => { aiBlock.classList.remove('show'); });
}

function appendDeployLogLine(text, isError) {
  if (!liveDeployCard) return;
  const body = liveDeployCard.body;
  const line = document.createElement('div');
  line.className = 'deploy-log-line' + (isError ? ' is-error' : '');
  line.textContent = text;
  if (isError) {
    // Tap an error line to copy the exact stack-trace text — quicker than
    // trying to select monospace text by hand on a small screen.
    line.title = 'Tap to copy';
    line.onclick = () => {
      navigator.clipboard?.writeText(text).catch(() => {});
      vibrate(6);
    };
  }
  const wasNearBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 60;
  body.appendChild(line);
  if (wasNearBottom) body.scrollTop = body.scrollHeight;
  // The card lives inside the normal chat scroll area now (it didn't
  // before, as a fixed overlay) — keep the thread scrolled down as log
  // lines stream in, same as any other growing agent message would.
  scrollToBottom();
}

function renderDrawerProfile() {
  const avatarEl = document.getElementById('drawer-avatar');
  const nameEl = document.getElementById('drawer-name');
  const subEl = document.getElementById('drawer-sub');
  if (!authedUser) {
    avatarEl.textContent = '?';
    nameEl.textContent = 'Not connected';
    subEl.textContent = '';
    return;
  }
  if (authedUser.avatar_url) {
    avatarEl.innerHTML = `<img src="${escHtml(authedUser.avatar_url)}" alt="" />`;
  } else {
    avatarEl.textContent = (authedUser.login || '?').charAt(0).toUpperCase();
  }
  nameEl.textContent = '@' + authedUser.login;
  const connectedCount = 1 + (authedUser.vercelConnected ? 1 : 0) + (authedUser.netlifyConnected ? 1 : 0) + (authedUser.renderConnected ? 1 : 0);
  subEl.textContent = `${connectedCount} app${connectedCount === 1 ? '' : 's'} connected`;
}

// ── CONNECTED APPS LIST ──
// Adapted for our per-user OAuth/token model: this reflects authedUser's
// REAL connection state (from /api/me), with working Connect/Disconnect
// buttons wired to the same flows as the header user-menu — it's just a
// second, more discoverable place to reach them. GitHub is always-on
// (it's required to be logged in at all), so it has no toggle.
function renderAppsList() {
  const list = document.getElementById('apps-list');
  if (!list) return;
  list.innerHTML = '';

  const apps = [
    {
      key: 'github', name: 'GitHub', icon: PROVIDER_ICONS.github,
      connected: !!authedUser,
      sub: authedUser ? `@${authedUser.login}` : 'Not connected',
      alwaysOn: true,
    },
    {
      key: 'vercel', name: 'Vercel', icon: PROVIDER_ICONS.vercel,
      connected: !!(authedUser && authedUser.vercelConnected),
      sub: authedUser && authedUser.vercelConnected ? `@${authedUser.vercelUsername || 'connected'}` : 'Not connected',
      onConnect: () => { closeDrawer(); showVercelModal(); },
      onDisconnect: () => { closeDrawer(); confirmDisconnectVercel(); },
    },
    {
      key: 'netlify', name: 'Netlify', icon: PROVIDER_ICONS.netlify,
      connected: !!(authedUser && authedUser.netlifyConnected),
      sub: authedUser && authedUser.netlifyConnected ? (authedUser.netlifyEmail || 'connected') : 'Not connected',
      onConnect: () => { closeDrawer(); showNetlifyModal(); },
      onDisconnect: () => { closeDrawer(); confirmDisconnectNetlify(); },
    },
    {
      key: 'render', name: 'Render', icon: PROVIDER_ICONS.render,
      connected: !!(authedUser && authedUser.renderConnected),
      sub: authedUser && authedUser.renderConnected ? (authedUser.renderEmail || 'connected') : 'Not connected',
      onConnect: () => { closeDrawer(); showRenderModal(); },
      onDisconnect: () => { closeDrawer(); confirmDisconnectRender(); },
    },
  ];

  apps.forEach(app => {
    const row = document.createElement('div');
    row.className = 'app-row';

    const icon = document.createElement('div');
    icon.className = 'app-icon';
    icon.innerHTML = app.icon;

    const info = document.createElement('div');
    info.className = 'app-info';
    const name = document.createElement('div');
    name.className = 'app-name';
    name.textContent = app.name;
    const status = document.createElement('div');
    status.className = 'app-status ' + (app.connected ? 'on' : 'off');
    status.textContent = app.sub;
    info.appendChild(name);
    info.appendChild(status);

    row.appendChild(icon);
    row.appendChild(info);

    if (app.alwaysOn) {
      const badge = document.createElement('button');
      badge.className = 'app-action-btn always-on';
      badge.textContent = '✓';
      badge.disabled = true;
      row.appendChild(badge);
    } else {
      // Toggle ON → opens the connect modal (same flow as before — still
      // requires pasting/validating a real token server-side, the toggle
      // is just a friendlier affordance than a text button).
      // Toggle OFF while connected → routes through the existing confirm
      // dialog (confirmDisconnectVercel/Netlify/Render), which still asks
      // "are you sure?" before actually clearing anything. If the user
      // cancels there, the toggle snaps back to ON to reflect that nothing
      // changed.
      const toggle = document.createElement('div');
      toggle.className = 'toggle-switch' + (app.connected ? ' on' : '');
      toggle.innerHTML = '<div class="knob"></div>';
      toggle.onclick = () => {
        vibrate(8);
        if (app.connected) {
          toggle.classList.remove('on'); // optimistic; confirm flow re-adds it back if cancelled
          app.onDisconnect();
        } else {
          app.onConnect();
        }
      };
      row.appendChild(toggle);
    }

    list.appendChild(row);
  });
}

// ── SETTINGS PANEL ──
const SETTINGS_LIST = [
  { key: 'haptics', name: 'Haptics', sub: 'Vibration on taps and actions' },
  { key: 'autoscroll', name: 'Auto-scroll', sub: 'Jump to latest message automatically' },
  { key: 'confirmClear', name: 'Confirm before clearing', sub: 'Ask before clearing a chat\'s history' },
  { key: 'amoled', name: 'True black (AMOLED)', sub: 'Pitch-black theme — saves battery on OLED screens' },
];

function toggleSettingsPanel() {
  const btn = document.getElementById('settings-toggle-btn');
  const list = document.getElementById('settings-list');
  const isOpen = list.classList.contains('settings-open');
  if (isOpen) {
    list.classList.remove('settings-open');
    list.classList.add('settings-collapsed');
    btn.classList.remove('open');
  } else {
    renderSettingsList();
    list.classList.remove('settings-collapsed');
    list.classList.add('settings-open');
    btn.classList.add('open');
  }
}

function renderSettingsList() {
  const list = document.getElementById('settings-list');
  const inner = document.createElement('div');
  inner.className = 'settings-inner';

  SETTINGS_LIST.forEach(s => {
    const row = document.createElement('div');
    row.className = 'setting-row';

    const info = document.createElement('div');
    info.className = 'setting-info';
    const name = document.createElement('div');
    name.className = 'setting-name';
    name.textContent = s.name;
    const sub = document.createElement('div');
    sub.className = 'setting-sub';
    sub.textContent = s.sub;
    info.appendChild(name);
    info.appendChild(sub);

    const toggle = document.createElement('div');
    // Most settings here default to true (so "not explicitly false" reads
    // as on). amoled defaults to false, so it needs the opposite check —
    // otherwise a fresh/never-set value would incorrectly render as "on".
    const isOn = DEFAULT_SETTINGS[s.key] === false ? appSettings[s.key] === true : appSettings[s.key] !== false;
    toggle.className = 'toggle-switch' + (isOn ? ' on' : '');
    toggle.innerHTML = '<div class="knob"></div>';
    toggle.onclick = () => {
      appSettings[s.key] = !toggle.classList.contains('on');
      saveAppSettings();
      vibrate(8);
      toggle.classList.toggle('on');
      if (s.key === 'amoled') applyTheme();
    };

    row.appendChild(info);
    row.appendChild(toggle);
    inner.appendChild(row);
  });

  list.innerHTML = '';
  list.appendChild(inner);
}

// ══════════════════════════════════════════════════════════════════
// HEX LOADER — reusable canvas hexagon+orbiting-packets animation.
// Used in four places: the typing indicator (start/stop driven by
// #typing-indicator.show), the header brand mark, the empty-state
// emblem, and the login-gate emblem (the latter three run continuously
// as the app's idle mark, replacing the old static star icon).
// ══════════════════════════════════════════════════════════════════
function createHexLoader(canvasId, opts = {}) {
  const canvas = document.getElementById(canvasId);
  if (!canvas || !canvas.getContext) return null;
  const ctx = canvas.getContext('2d');

  const cssSize = opts.size || 30;
  const hexRadius = cssSize * (opts.hexRadiusRatio || 0.217);
  const orbitRadius = cssSize * (opts.orbitRadiusRatio || 0.417);
  const nodeCount = 3;
  const speed = opts.speed || 1;

  const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  canvas.width = cssSize * dpr;
  canvas.height = cssSize * dpr;
  ctx.scale(dpr, dpr);

  const cx = cssSize / 2, cy = cssSize / 2;
  const accent = opts.color || '#36d1ff';
  const accentRGB = opts.colorRGB || '54,209,255';
  const accentDim = `rgba(${accentRGB},0.28)`;

  function hexPoints(r, rotation = 0) {
    const pts = [];
    for (let i = 0; i < 6; i++) {
      const a = rotation + (Math.PI / 3) * i - Math.PI / 2;
      pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
    return pts;
  }

  function drawHex(r, rotation, strokeStyle, lineWidth, fillStyle) {
    const pts = hexPoints(r, rotation);
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    ctx.closePath();
    if (fillStyle) { ctx.fillStyle = fillStyle; ctx.fill(); }
    if (strokeStyle) { ctx.strokeStyle = strokeStyle; ctx.lineWidth = lineWidth; ctx.stroke(); }
  }

  let rafId = null;
  let running = false;
  const startTime = { t: 0 };

  function frame(now) {
    if (!running) return;
    if (!startTime.t) startTime.t = now;
    const elapsed = ((now - startTime.t) / 1000) * speed;

    ctx.clearRect(0, 0, cssSize, cssSize);

    const slowRot = elapsed * 0.35;
    drawHex(hexRadius, slowRot, accentDim, Math.max(1, cssSize * 0.037), null);

    const breathe = 0.55 + 0.45 * Math.sin(elapsed * 2.4);
    ctx.save();
    ctx.shadowColor = accent;
    ctx.shadowBlur = (6 + breathe * 6) * (cssSize / 30);
    drawHex(hexRadius * 0.42, -slowRot * 1.3, null, 0, `rgba(${accentRGB},${0.35 + breathe * 0.35})`);
    ctx.restore();

    const cycleLen = 1.35;
    for (let i = 0; i < nodeCount; i++) {
      const angle = (Math.PI * 2 / nodeCount) * i - Math.PI / 2 + slowRot;
      const phase = ((elapsed / cycleLen) + i / nodeCount) % 1;
      const travel = phase * phase * (3 - 2 * phase);
      const r = orbitRadius * (1 - travel * 0.82);
      const px = cx + r * Math.cos(angle);
      const py = cy + r * Math.sin(angle);
      const alpha = phase < 0.85 ? 1 : (1 - phase) / 0.15;
      const size = (cssSize / 30) * (1.6 - travel * 0.6);

      ctx.beginPath();
      ctx.arc(px, py, Math.max(size, 0.4), 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${accentRGB},${Math.max(alpha, 0) * 0.9})`;
      ctx.shadowColor = accent;
      ctx.shadowBlur = 4 * (cssSize / 30);
      ctx.fill();

      const orbitX = cx + orbitRadius * Math.cos(angle);
      const orbitY = cy + orbitRadius * Math.sin(angle);
      ctx.beginPath();
      ctx.moveTo(orbitX, orbitY);
      ctx.lineTo(px, py);
      ctx.strokeStyle = `rgba(${accentRGB},${Math.max(alpha, 0) * 0.18})`;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    ctx.shadowBlur = 0;

    rafId = requestAnimationFrame(frame);
  }

  function start() {
    if (running) return;
    running = true;
    startTime.t = 0;
    rafId = requestAnimationFrame(frame);
  }
  function stop() {
    running = false;
    if (rafId) cancelAnimationFrame(rafId);
    ctx.clearRect(0, 0, cssSize, cssSize);
  }

  return { start, stop };
}

// Typing indicator: start/stop driven by #typing-indicator.show.
(function initThinkLoader() {
  const loader = createHexLoader('think-canvas', { size: 30 });
  if (!loader) return;

  const indicator = document.getElementById('typing-indicator');
  const observer = new MutationObserver(() => {
    if (indicator.classList.contains('show')) loader.start(); else loader.stop();
  });
  observer.observe(indicator, { attributes: true, attributeFilter: ['class'] });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) loader.stop();
    else if (indicator.classList.contains('show')) loader.start();
  });

  if (indicator.classList.contains('show')) loader.start();
})();

// Header brand mark: a plain static hexagon outline — no animation, no
// orbiting nodes. Just a small themed mark next to the "DevOps Agent"
// title, drawn once.
function drawStaticHexMark(canvasId, size) {
  const canvas = document.getElementById(canvasId);
  if (!canvas || !canvas.getContext) return;
  const ctx = canvas.getContext('2d');
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  canvas.width = size * dpr;
  canvas.height = size * dpr;
  ctx.scale(dpr, dpr);

  const cx = size / 2, cy = size / 2;
  const r = size * 0.42;
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i - Math.PI / 2;
    const x = cx + r * Math.cos(a), y = cy + r * Math.sin(a);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.strokeStyle = '#36d1ff';
  ctx.lineWidth = Math.max(1.4, size * 0.06);
  ctx.stroke();
}

// Empty-state emblem + login-gate emblem: these run continuously as the
// app's idle mark (not a loading state), pausing only when the tab is
// backgrounded to save battery. The header brand mark stays a plain
// static hexagon (drawn above) — no looping animation there.
(function initBrandLoaders() {
  drawStaticHexMark('brand-canvas', 20);

  const loaders = [
    createHexLoader('emblem-canvas', { size: 56, speed: 0.85 }),
    createHexLoader('login-emblem-canvas', { size: 30, speed: 0.85 }),
  ].filter(Boolean);
  if (!loaders.length) return;

  loaders.forEach(l => l.start());
  document.addEventListener('visibilitychange', () => {
    loaders.forEach(l => document.hidden ? l.stop() : l.start());
  });
})();

// ── RESTORE ON LOAD ──
restoreChatOnLoad();
checkAuth();
