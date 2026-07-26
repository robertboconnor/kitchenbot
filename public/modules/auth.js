// The signed-out shell: the household lookup, the PIN form, first-run bootstrap, and switching the
// page between "logged out" and "the app".
//
// It never re-hydrates the app itself. A successful sign-in (or a /me that already resolves)
// announces REHYDRATE_APP and the composition root in app.js decides what that means — which is
// what lets God Mode's "exit impersonation" reuse exactly the same path.

import { EVENTS, emit } from './events.js';
import { setActiveTab } from './navigation.js';

// DOM handles, bound by initAuth() once the document exists.
let loginArea = null;
let appArea = null;
let loginHouseholdKeyInput = null;
let loginFindHouseholdButton = null;
let loginNameSelect = null;
let loginPasswordInput = null;
let loginButton = null;
let loginAuthForm = null;
let loginStatus = null;
let headerEl = null;

let lastResolvedKey = null;
let blurFindTimeout = null;

export function showApp() {
  loginArea.style.display = 'none';
  appArea.style.display = 'flex';
  appArea.style.flexDirection = 'column';
  headerEl.classList.remove('hide-tabs');
}

function showBootstrapForm() {
  const bf = document.getElementById('bootstrap-form');
  const lf = document.getElementById('login-form');
  const blk = document.getElementById('bootstrap-blocked');
  if (blk) blk.style.display = 'none';
  if (bf) bf.classList.add('bootstrap-form-visible');
  if (lf) lf.classList.remove('login-form-visible');
}

function showBootstrapBlocked() {
  const bf = document.getElementById('bootstrap-form');
  const lf = document.getElementById('login-form');
  const blk = document.getElementById('bootstrap-blocked');
  if (bf) bf.classList.remove('bootstrap-form-visible');
  if (lf) lf.classList.remove('login-form-visible');
  if (blk) blk.style.display = 'block';
}

function showLoginFormOnly() {
  const bf = document.getElementById('bootstrap-form');
  const lf = document.getElementById('login-form');
  const blk = document.getElementById('bootstrap-blocked');
  if (blk) blk.style.display = 'none';
  if (bf) bf.classList.remove('bootstrap-form-visible');
  if (lf) lf.classList.add('login-form-visible');
}

export function showLogin() {
  loginArea.style.display = 'block';
  appArea.style.display = 'none';
  headerEl.classList.add('hide-tabs');
  showLoginFormOnly();
  setActiveTab('chat');
}

function clearHouseholdLookup() {
  lastResolvedKey = null;
  const resolvedEl = document.getElementById('login-household-resolved');
  if (resolvedEl) resolvedEl.style.display = 'none';
  loginNameSelect.innerHTML = '';
  const ph = document.createElement('option');
  ph.value = '';
  ph.textContent = '— Select user —';
  ph.disabled = true;
  ph.selected = true;
  loginNameSelect.appendChild(ph);
  loginNameSelect.disabled = true;
  loginPasswordInput.value = '';
  loginButton.disabled = true;
  loginStatus.textContent = '';
}

function updateLoginEnabled() {
  const canTry =
    lastResolvedKey != null &&
    loginNameSelect.value &&
    loginPasswordInput.value.trim().length > 0;
  loginButton.disabled = !canTry;
}

async function findHousehold() {
  const key = loginHouseholdKeyInput.value.trim();
  if (!key) {
    loginStatus.textContent = 'Enter a household key.';
    clearHouseholdLookup();
    return;
  }
  loginStatus.textContent = 'Looking up…';
  try {
    const r = await fetch('/login/household?' + new URLSearchParams({ key }));
    if (r.status === 404) {
      clearHouseholdLookup();
      loginStatus.textContent = 'No household found for that key.';
      return;
    }
    if (!r.ok) {
      clearHouseholdLookup();
      loginStatus.textContent = 'Could not look up household.';
      return;
    }
    const data = await r.json();
    lastResolvedKey = data.household.key;
    const nameEl = document.getElementById('login-household-name');
    if (nameEl) nameEl.textContent = data.household.name;
    const resolvedEl = document.getElementById('login-household-resolved');
    if (resolvedEl) resolvedEl.style.display = 'block';
    loginNameSelect.innerHTML = '';
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = '— Select user —';
    placeholder.disabled = true;
    placeholder.selected = true;
    loginNameSelect.appendChild(placeholder);
    for (const u of data.users) {
      const opt = document.createElement('option');
      opt.value = u.displayName;
      opt.textContent = u.displayName;
      loginNameSelect.appendChild(opt);
    }
    loginNameSelect.disabled = false;
    loginStatus.textContent = '';
    updateLoginEnabled();
  } catch (e) {
    clearHouseholdLookup();
    loginStatus.textContent = 'Lookup failed.';
  }
}

async function performLogin() {
  const householdKey = lastResolvedKey;
  const displayName = loginNameSelect.value;
  const pin = loginPasswordInput.value;

  if (!householdKey) {
    loginStatus.textContent = 'Find your household first.';
    return;
  }
  if (!displayName) {
    loginStatus.textContent = 'Select a user.';
    return;
  }
  if (!pin) {
    loginStatus.textContent = 'PIN is required.';
    return;
  }

  loginStatus.textContent = 'Logging in...';

  try {
    const response = await fetch('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ householdKey, displayName, pin })
    });

    if (!response.ok) {
      loginStatus.textContent = 'Invalid user or PIN.';
      return;
    }

    let data = {};
    try {
      data = await response.json();
    } catch (e) {}

    loginPasswordInput.value = '';
    loginStatus.textContent = '';
    try {
      const meR = await fetch('/me');
      if (meR.ok) {
        const meData = await meR.json();
        emit(EVENTS.REHYDRATE_APP, { me: meData, options: { forceChatTab: true, resetSessionView: true } });
        return;
      }
    } catch (e) {}
    // /me failed but the login itself succeeded: go on with what the login response told us.
    const resolvedName = data.displayName ?? data.name ?? displayName;
    emit(EVENTS.REHYDRATE_APP, {
      me: {
        name: resolvedName,
        householdId: data.householdId,
        userId: data.userId,
        chatColors: {},
        isImpersonating: false,
        impersonationReadOnly: false,
      },
      options: { forceChatTab: true, resetSessionView: true },
    });
  } catch (error) {
    loginStatus.textContent = 'Login failed.';
  }
}

export async function checkAuth() {
  try {
    const bs = await fetch('/bootstrap/status');
    if (!bs.ok) {
      loginArea.style.display = 'block';
      appArea.style.display = 'none';
      headerEl.classList.add('hide-tabs');
      showLoginFormOnly();
      return;
    }
    const bsData = await bs.json();
    if (bsData.needsBootstrap) {
      loginArea.style.display = 'block';
      appArea.style.display = 'none';
      headerEl.classList.add('hide-tabs');
      if (bsData.allowPublicBootstrap === false) {
        showBootstrapBlocked();
      } else {
        showBootstrapForm();
      }
      return;
    }

    showLoginFormOnly();
    const response = await fetch('/me');
    if (!response.ok) {
      showLogin();
      return;
    }
    const data = await response.json();
    emit(EVENTS.REHYDRATE_APP, { me: data, options: { forceChatTab: true, resetSessionView: true } });
  } catch (error) {
    showLogin();
  }
}

/** Bind DOM handles, wire the login and bootstrap forms, and show the signed-out shell. */
export function initAuth() {
  loginArea = document.getElementById('login-area');
  appArea = document.getElementById('app');
  loginHouseholdKeyInput = document.getElementById('login-household-key');
  loginFindHouseholdButton = document.getElementById('login-find-household');
  loginNameSelect = document.getElementById('login-name');
  loginPasswordInput = document.getElementById('login-password');
  loginButton = document.getElementById('login-button');
  loginAuthForm = document.getElementById('login-auth-form');
  loginStatus = document.getElementById('login-status');
  headerEl = document.getElementById('header');

  loginHouseholdKeyInput.addEventListener('input', () => {
    const v = loginHouseholdKeyInput.value.trim().toLowerCase();
    if (lastResolvedKey != null && v !== lastResolvedKey) {
      clearHouseholdLookup();
    }
  });

  loginHouseholdKeyInput.addEventListener('blur', () => {
    blurFindTimeout = setTimeout(() => {
      blurFindTimeout = null;
      if (loginHouseholdKeyInput.value.trim()) {
        findHousehold();
      }
    }, 250);
  });

  loginFindHouseholdButton.addEventListener('mousedown', (e) => {
    if (blurFindTimeout) {
      clearTimeout(blurFindTimeout);
      blurFindTimeout = null;
    }
  });

  loginFindHouseholdButton.addEventListener('click', () => {
    findHousehold();
  });

  loginNameSelect.addEventListener('change', updateLoginEnabled);
  loginPasswordInput.addEventListener('input', updateLoginEnabled);

  if (loginAuthForm) {
    loginAuthForm.addEventListener('submit', (e) => {
      e.preventDefault();
      if (loginButton.disabled) return;
      void performLogin();
    });
  }

  document.getElementById('bootstrap-submit').addEventListener('click', async () => {
    const householdName = document.getElementById('bootstrap-household-name').value.trim();
    const householdKey = document.getElementById('bootstrap-household-key').value.trim();
    const ownerDisplayName = document.getElementById('bootstrap-owner-display-name').value.trim();
    const pin = document.getElementById('bootstrap-pin').value;
    const bootstrapStatusEl = document.getElementById('bootstrap-status');
    if (!householdName || !householdKey || !ownerDisplayName || !pin) {
      bootstrapStatusEl.textContent = 'All fields are required.';
      return;
    }
    bootstrapStatusEl.textContent = 'Creating…';
    try {
      const r = await fetch('/bootstrap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ householdName, householdKey, ownerDisplayName, pin }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        bootstrapStatusEl.textContent = data.error || 'Bootstrap failed.';
        return;
      }
      document.getElementById('bootstrap-pin').value = '';
      bootstrapStatusEl.textContent = '';
      showLoginFormOnly();
      loginHouseholdKeyInput.value = data.householdKey || householdKey;
      await findHousehold();
    } catch (e) {
      bootstrapStatusEl.textContent = 'Something went wrong.';
    }
  });

  try {
    showLoginFormOnly();
  } catch (e) {
    console.error('Startup login shell render failed:', e);
  }
}
