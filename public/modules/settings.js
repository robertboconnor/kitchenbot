// Settings: the sub-view switcher and the panels behind it (my household, family food
// profiles, household defaults, members).
//
// Owns which sub-view is showing. Loads itself when navigation announces the Settings tab rather
// than being called by it.

import { EVENTS, emit, on } from './events.js';
import {
  applyGodModeFromMe,
  loadGlobalAdminView,
  refreshOwnerAnthropicUsageReport,
  refreshOwnerAnthropicUsageView,
} from './admin.js';
import {
  CHAT_COLOR_OPTIONS,
  getAssistantName,
  getNameColors,
  getRawMe,
  isOwner,
  isReadOnly,
  mapServerReadOnlyErrorMessage,
  normalizeDisplayNameKey,
  setAssistantName,
  setNameColors,
} from './session.js';

let currentSettingsSubView = 'my';

const SETTINGS_SUBVIEWS = {
  my: { view: 'settings-view-my', btn: 'settings-subtab-my-btn', gated: false },
  family: { view: 'settings-view-family', btn: 'settings-subtab-family-btn', gated: false },
  household: { view: 'settings-view-household', btn: 'settings-subtab-household-btn', gated: false },
  usage: { view: 'settings-view-usage', btn: 'settings-subtab-usage-btn', gated: false },
  admin: { view: 'settings-view-admin', btn: 'settings-subtab-admin-btn', gated: true },
};

// DOM handles, bound by initSettings() once the document exists. Declared here rather than
// resolved per call so the moved code below reads exactly as it did in app.js.
let settingsPanel = null;
let settingsAddSubmit = null;
let settingsAnthropicOwnerKeySave = null;
let settingsSubtabMyBtn = null;
let settingsSubtabUsageBtn = null;
let settingsSubtabAdminBtn = null;
let settingsSubtabHouseholdBtn = null;
let settingsSubtabFamilyBtn = null;
let defaultsSaveButton = null;

export function rebuildDisplayNameToColorFromSettingsUsers(users) {
  const colors = {};
  for (const u of users || []) {
    const nk = normalizeDisplayNameKey(u.displayName);
    if (nk) colors[nk] = u.chatColor || 'blue';
  }
  setNameColors(colors);
}

export function clearHouseholdDefaultsUiMessage() {
  const el = document.getElementById('my-settings-defaults-msg');
  clearSettingsUiMessage(el);
}

export function setSettingsUiMessage(el, text, { sticky = false } = {}) {
  if (!el) return;
  el.textContent = text || '';
  el.dataset.sticky = sticky && text ? 'true' : 'false';
}

export function clearSettingsUiMessage(el, { force = false } = {}) {
  if (!el) return;
  if (!force && el.dataset.sticky === 'true') return;
  el.textContent = '';
  el.dataset.sticky = 'false';
}

export function clearStickySettingsMessages() {
  clearSettingsUiMessage(document.getElementById('my-settings-defaults-msg'), { force: true });
  clearSettingsUiMessage(document.getElementById('my-settings-msg'), { force: true });
  clearSettingsUiMessage(document.getElementById('settings-anthropic-owner-key-msg'), { force: true });
}

export async function loadHouseholdDefaultsEditor() {
  const portionsEl = document.getElementById('my-settings-defaults-portions');
  const styleEl = document.getElementById('my-settings-defaults-style');
  const assistantNameEl = document.getElementById('my-settings-defaults-assistant-name');
  const assistantToneEl = document.getElementById('my-settings-defaults-assistant-tone');
  const msgEl = document.getElementById('my-settings-defaults-msg');
  if (!portionsEl || !styleEl || !assistantNameEl || !assistantToneEl || !isOwner()) return;
  try {
    const r = await fetch('/settings/household/defaults');
    if (!r.ok) {
      if (msgEl) msgEl.textContent = 'Could not load KitchenBot settings.';
      return;
    }
    const data = await r.json();
    const defaults = data.defaults || {};
    portionsEl.value =
      defaults.defaultDinnerPortions == null || !Number.isFinite(Number(defaults.defaultDinnerPortions))
        ? ''
        : String(Number(defaults.defaultDinnerPortions));
    styleEl.value = defaults.weeknightCookingStyle || 'normal';
    assistantNameEl.value = defaults.assistantName || 'KitchenBot';
    assistantToneEl.value = normalizeToneValue(defaults.assistantTone);
    setAssistantName(defaults.assistantName);
    clearSettingsUiMessage(msgEl);
  } catch (e) {
    setSettingsUiMessage(msgEl, 'Load failed.');
  }
}

export async function loadMyHouseholdView() {
  const msgEl = document.getElementById('my-settings-msg');
  const idEl = document.getElementById('my-settings-hh-id');
  const nameEl = document.getElementById('my-settings-hh-name');
  const keyEl = document.getElementById('my-settings-hh-key');
  const listEl = document.getElementById('my-settings-users-list');
  if (!listEl || !idEl || !nameEl || !keyEl) return;
  try {
    const r = await fetch('/settings/household');
    if (!r.ok) {
      if (msgEl) msgEl.textContent = 'Could not load settings.';
      return;
    }
    const data = await r.json();
    // owner/member distinction removed — every member can manage household settings
    setAssistantName(
      (data.defaults && typeof data.defaults.assistantName === 'string' && data.defaults.assistantName.trim()) ||
        getAssistantName()
    );
    idEl.textContent = String(data.household.id ?? '');
    nameEl.textContent = data.household.name;
    keyEl.textContent = data.household.key;
    rebuildDisplayNameToColorFromSettingsUsers(data.users);
    if (true) {
      try {
        emit(EVENTS.CHAT_RELOAD, {});
      } catch (e) {}
    }
    listEl.innerHTML = '';
    for (const u of data.users) {
      const row = document.createElement('div');
      row.className = 'settings-user-row';
      const label = document.createElement('span');
      label.className = 'settings-user-name';
      label.textContent = u.displayName;
      const pinCol = document.createElement('div');
      pinCol.className = 'settings-user-row-role-col';
      const pinRow = document.createElement('div');
      pinRow.className = 'settings-user-inline-controls';
      const pinLbl = document.createElement('span');
      pinLbl.textContent = 'PIN';
      const pinIn = document.createElement('input');
      pinIn.type = 'password';
      pinIn.placeholder = 'new PIN';
      pinIn.autocomplete = 'new-password';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = 'Update PIN';
      const pinFeedback = document.createElement('div');
      pinFeedback.className = 'settings-user-row-role-feedback';
      pinFeedback.setAttribute('aria-live', 'polite');
      let pinSaving = false;
      function syncPinButton() {
        if (pinSaving) return;
        btn.disabled = pinIn.value.trim() === '';
      }
      syncPinButton();
      pinIn.addEventListener('input', () => {
        pinFeedback.textContent = '';
        syncPinButton();
      });
      btn.addEventListener('click', async () => {
        if (pinSaving) return;
        const pin = pinIn.value.trim();
        if (!pin) {
          pinFeedback.textContent = 'Enter a PIN.';
          pinFeedback.style.color = 'var(--text-soft)';
          return;
        }
        pinSaving = true;
        btn.disabled = true;
        pinIn.disabled = true;
        btn.textContent = 'Saving...';
        pinFeedback.textContent = '';
        try {
          const rr = await fetch('/settings/household/users/' + u.id + '/pin', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pin }),
          });
          const errBody = await rr.json().catch(() => ({}));
          if (rr.ok) {
            pinIn.value = '';
            pinFeedback.textContent = 'PIN updated';
            pinFeedback.style.color = 'var(--accent-strong)';
            row.classList.add('settings-user-row-role-flash');
            setTimeout(() => row.classList.remove('settings-user-row-role-flash'), 2000);
          } else {
            pinFeedback.textContent =
              mapServerReadOnlyErrorMessage(errBody.error) || 'Failed to update PIN';
            pinFeedback.style.color = '#b91c1c';
          }
        } catch (e) {
          pinFeedback.textContent = 'Request failed';
          pinFeedback.style.color = '#b91c1c';
        } finally {
          pinSaving = false;
          pinIn.disabled = false;
          btn.textContent = 'Update PIN';
          syncPinButton();
        }
      });
      pinRow.appendChild(pinLbl);
      pinRow.appendChild(pinIn);
      pinRow.appendChild(btn);
      pinCol.appendChild(pinRow);
      pinCol.appendChild(pinFeedback);
      row.appendChild(label);
      // owner/member distinction removed — no per-user Role selector
      row.appendChild(pinCol);
      const prefGrid = document.createElement('div');
      prefGrid.className = 'settings-user-pref-grid';
      const colorCol = document.createElement('div');
      colorCol.className = 'settings-user-row-role-col';
      const colorWrap = document.createElement('div');
      colorWrap.className = 'settings-user-inline-controls';
      const colorLbl = document.createElement('span');
      colorLbl.textContent = 'Chat color';
      const colorSel = document.createElement('select');
      colorSel.setAttribute('aria-label', 'Chat color for ' + u.displayName);
      CHAT_COLOR_OPTIONS.forEach((opt) => {
        const o = document.createElement('option');
        o.value = opt.key;
        o.textContent = opt.label;
        colorSel.appendChild(o);
      });
      colorSel.value = u.chatColor || 'blue';
      let prevChatColor = colorSel.value;
      const colorFeedback = document.createElement('div');
      colorFeedback.className = 'settings-user-row-role-feedback';
      colorFeedback.setAttribute('aria-live', 'polite');
      let chatColorSaving = false;
      colorSel.addEventListener('change', async () => {
        if (chatColorSaving) return;
        const attempted = colorSel.value;
        chatColorSaving = true;
        colorSel.disabled = true;
        colorFeedback.textContent = 'Saving...';
        colorFeedback.style.color = 'var(--text-soft)';
        try {
          const rr = await fetch('/settings/household/users/' + u.id + '/chat-color', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chatColor: attempted }),
          });
          const errBody = await rr.json().catch(() => ({}));
          if (rr.ok) {
            setNameColors({ ...getNameColors(), [normalizeDisplayNameKey(u.displayName)]: attempted });
            prevChatColor = attempted;
            colorSel.value = attempted;
            colorFeedback.textContent = 'Chat color updated';
            colorFeedback.style.color = 'var(--accent-strong)';
            row.classList.add('settings-user-row-role-flash');
            setTimeout(() => row.classList.remove('settings-user-row-role-flash'), 2000);
            emit(EVENTS.CHAT_RELOAD, {});
          } else {
            colorSel.value = prevChatColor;
            colorFeedback.textContent =
              mapServerReadOnlyErrorMessage(errBody.error) || 'Failed to update chat color';
            colorFeedback.style.color = '#b91c1c';
          }
        } catch (e) {
          colorSel.value = prevChatColor;
          colorFeedback.textContent = 'Request failed';
          colorFeedback.style.color = '#b91c1c';
        } finally {
          chatColorSaving = false;
          colorSel.disabled = false;
        }
      });
      colorWrap.appendChild(colorLbl);
      colorWrap.appendChild(colorSel);
      colorCol.appendChild(colorWrap);
      colorCol.appendChild(colorFeedback);
      prefGrid.appendChild(colorCol);
      row.appendChild(prefGrid);
      listEl.appendChild(row);
    }
    if (msgEl) msgEl.textContent = '';
    await loadHouseholdDefaultsEditor();
  } catch (e) {
    if (msgEl) msgEl.textContent = 'Load failed.';
  }
}

export async function loadSettingsPanel() {
  await loadMyHouseholdView(); // sets isCurrentUserOwner from /settings/household
  await refreshOwnerAnthropicUsageView();
  const isGa = await loadAnthropicSection();
  // Owner/member distinction removed (2026-07-23): My preferences, Food profiles,
  // Household, and Usage are for EVERY household member. Only God Mode is gated (to the
  // first bootstrapped user / global admin).
  const householdBtn = document.getElementById('settings-subtab-household-btn');
  if (householdBtn) householdBtn.style.display = 'inline-block';
  const usageBtn = document.getElementById('settings-subtab-usage-btn');
  if (usageBtn) usageBtn.style.display = 'inline-block';
  const subAdminBtn = document.getElementById('settings-subtab-admin-btn');
  if (subAdminBtn) subAdminBtn.style.display = isGa ? 'inline-block' : 'none';
  if (currentSettingsSubView === 'admin' && !isGa) {
    currentSettingsSubView = 'my';
  }
  if (isGa) {
    await loadGlobalAdminView();
  }
  showSettingsSubView(currentSettingsSubView);
  if (getRawMe()) applyGodModeFromMe(getRawMe());
}

export function showSettingsSubView(view) {
  if (!SETTINGS_SUBVIEWS[view]) view = 'my';
  // A gated view whose tab is hidden (not owner/admin) falls back to My preferences.
  const reqBtn = document.getElementById(SETTINGS_SUBVIEWS[view].btn);
  if (SETTINGS_SUBVIEWS[view].gated && reqBtn && reqBtn.style.display === 'none') view = 'my';
  currentSettingsSubView = view;
  for (const key of Object.keys(SETTINGS_SUBVIEWS)) {
    const conf = SETTINGS_SUBVIEWS[key];
    const v = document.getElementById(conf.view);
    const b = document.getElementById(conf.btn);
    if (v) v.style.display = key === view ? 'block' : 'none';
    if (b) b.classList.toggle('settings-subtab-active', key === view);
  }
  if (view === 'family') loadFamilyProfiles();
}

export async function loadFamilyProfiles() {
  const listEl = document.getElementById('family-profiles-list');
  const emptyEl = document.getElementById('family-profiles-empty');
  if (!listEl) return;
  let profiles = [];
  try {
    const r = await fetch('/family/profiles', { credentials: 'same-origin' });
    if (r.ok) profiles = (await r.json()).profiles || [];
  } catch (e) {
    /* leave empty */
  }
  listEl.innerHTML = '';
  const anyData = profiles.some(
    (p) => p.acceptedFoods.length || p.rejectedFoods.length || p.allergies.length || p.notes.length
  );
  if (emptyEl) {
    emptyEl.style.display = profiles.length === 0 || !anyData ? 'block' : 'none';
    emptyEl.textContent =
      profiles.length === 0
        ? 'No household members yet.'
        : 'No food notes yet — add likes, dislikes, or allergies below, or just tell KitchenBot in chat.';
  }
  const readOnly = !!isReadOnly();
  const postJson = (url, body) =>
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    });
  for (const p of profiles) {
    const card = document.createElement('section');
    card.className = 'settings-card';
    const h = document.createElement('h3');
    h.textContent = p.person;
    h.style.marginTop = '0';
    card.appendChild(h);
    const group = (label, field, values, tone) => {
      const wrap = document.createElement('div');
      wrap.style.cssText = 'margin:8px 0;';
      const lab = document.createElement('div');
      lab.textContent = label;
      lab.style.cssText =
        'font-size:12px;font-weight:700;color:var(--text-soft);text-transform:uppercase;letter-spacing:.03em;margin-bottom:4px;';
      wrap.appendChild(lab);
      const chips = document.createElement('div');
      chips.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;';
      if (!values.length) {
        const none = document.createElement('span');
        none.textContent = '—';
        none.style.color = 'var(--text-soft)';
        chips.appendChild(none);
      }
      for (const v of values) {
        const chip = document.createElement('span');
        chip.style.cssText =
          // Fixed rounded-RECTANGLE radius, not a 999px pill: a pill radius makes a value
          // that wraps to multiple lines (a long "won't eat", or a Notes line) bleed past
          // the over-curved corners. Also top-align the × so it sits at the first line.
          'display:inline-flex;align-items:flex-start;gap:5px;padding:4px 9px;border-radius:10px;font-size:13px;border:1px solid var(--border-subtle);' +
          (tone === 'allergy' ? 'background:#fef2f2;color:#b91c1c;border-color:#fecaca;' : 'background:var(--card-bg-2);color:var(--text);');
        chip.appendChild(document.createTextNode(v));
        if (!readOnly) {
          const x = document.createElement('button');
          x.type = 'button';
          x.textContent = '×';
          x.title = 'Remove';
          x.style.cssText = 'border:none;background:none;cursor:pointer;font-size:15px;line-height:1;color:inherit;padding:0;';
          x.addEventListener('click', async () => {
            await postJson('/family/profiles/remove', { person: p.person, field, value: v });
            loadFamilyProfiles();
          });
          chip.appendChild(x);
        }
        chips.appendChild(chip);
      }
      wrap.appendChild(chips);
      return wrap;
    };
    card.appendChild(group('Allergies', 'allergies', p.allergies, 'allergy'));
    card.appendChild(group('Likes', 'acceptedFoods', p.acceptedFoods));
    card.appendChild(group("Won't eat", 'rejectedFoods', p.rejectedFoods));
    if (p.notes && p.notes.length) card.appendChild(group('Notes', 'notes', p.notes));
    if (!readOnly) {
      const addRow = document.createElement('div');
      addRow.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-top:10px;';
      const sel = document.createElement('select');
      sel.style.cssText = 'padding:6px 8px;border-radius:8px;border:1px solid var(--border-subtle);font-size:13px;';
      [
        ['acceptedFoods', 'Likes'],
        ['rejectedFoods', "Won't eat"],
        ['allergies', 'Allergy'],
        ['notes', 'Note'],
      ].forEach(([val, txt]) => {
        const o = document.createElement('option');
        o.value = val;
        o.textContent = txt;
        sel.appendChild(o);
      });
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.placeholder = 'Add a food or note…';
      inp.style.cssText = 'flex:1;min-width:140px;padding:6px 10px;border-radius:8px;border:1px solid var(--border-subtle);font-size:13px;';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = 'Add';
      const submit = async () => {
        const value = inp.value.trim();
        if (!value) return;
        await postJson('/family/profiles/add', { person: p.person, field: sel.value, value });
        inp.value = '';
        loadFamilyProfiles();
      };
      btn.addEventListener('click', submit);
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          submit();
        }
      });
      addRow.appendChild(sel);
      addRow.appendChild(inp);
      addRow.appendChild(btn);
      card.appendChild(addRow);
    }
    listEl.appendChild(card);
  }
}

/** Bind DOM handles and wire this feature's own listeners. Called once at startup. */
export function initSettings() {
  settingsPanel = document.getElementById('settings-panel');
  settingsAddSubmit = document.getElementById('settings-add-submit');
  settingsAnthropicOwnerKeySave = document.getElementById('settings-anthropic-owner-key-save');
  settingsSubtabMyBtn = document.getElementById('settings-subtab-my-btn');
  settingsSubtabUsageBtn = document.getElementById('settings-subtab-usage-btn');
  settingsSubtabAdminBtn = document.getElementById('settings-subtab-admin-btn');
  settingsSubtabHouseholdBtn = document.getElementById('settings-subtab-household-btn');
  settingsSubtabFamilyBtn = document.getElementById('settings-subtab-family-btn');
  defaultsSaveButton = document.getElementById('my-settings-defaults-save');
  on(EVENTS.TAB_CHANGED, ({ tab }) => {
    if (tab === 'settings') loadSettingsPanel();
  });

  if (settingsAnthropicOwnerKeySave) {
    settingsAnthropicOwnerKeySave.addEventListener('click', async () => {
      const keyInput = document.getElementById('settings-anthropic-owner-key');
      const msgEl = document.getElementById('settings-anthropic-owner-key-msg');
      const key = keyInput && keyInput.value.trim();
      if (!key) {
        if (msgEl) msgEl.textContent = 'Enter an API key.';
        return;
      }
      try {
        const r = await fetch('/settings/anthropic/key', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ anthropicApiKey: key }),
        });
        const errBody = await r.json().catch(() => ({}));
        if (!r.ok) {
          setSettingsUiMessage(msgEl, mapServerReadOnlyErrorMessage(errBody.error) || 'Save failed');
          return;
        }
        setSettingsUiMessage(msgEl, 'Key saved.', { sticky: true });
        if (keyInput) keyInput.value = '';
        await loadMyHouseholdView();
        await loadAnthropicSection();
      } catch (e) {
        setSettingsUiMessage(msgEl, 'Request failed.');
      }
    });
  }

  if (settingsSubtabMyBtn) {
    settingsSubtabMyBtn.addEventListener('click', () => {
      showSettingsSubView('my');
    });
  }
  if (settingsSubtabUsageBtn) {
    settingsSubtabUsageBtn.addEventListener('click', async () => {
      await refreshOwnerAnthropicUsageReport();
      showSettingsSubView('usage');
    });
  }
  if (settingsSubtabAdminBtn) {
    settingsSubtabAdminBtn.addEventListener('click', async () => {
      await loadGlobalAdminView();
      showSettingsSubView('admin');
    });
  }
  if (settingsSubtabHouseholdBtn) {
    settingsSubtabHouseholdBtn.addEventListener('click', () => {
      showSettingsSubView('household');
    });
  }
  if (settingsSubtabFamilyBtn) {
    settingsSubtabFamilyBtn.addEventListener('click', () => {
      showSettingsSubView('family');
    });
  }

  if (settingsAddSubmit) {
    settingsAddSubmit.addEventListener('click', async () => {
      const displayName = document.getElementById('settings-new-display').value.trim();
      const role = document.getElementById('settings-new-role').value;
      const pin = document.getElementById('settings-new-pin').value.trim();
      const msgEl = document.getElementById('my-settings-msg');
      if (!displayName || !pin) {
        setSettingsUiMessage(msgEl, 'Display name and PIN required.');
        return;
      }
      try {
        const r = await fetch('/settings/household/users', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ displayName, role, pin }),
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) {
          setSettingsUiMessage(msgEl, mapServerReadOnlyErrorMessage(data.error) || 'Failed');
          return;
        }
        document.getElementById('settings-new-display').value = '';
        document.getElementById('settings-new-pin').value = '';
        setSettingsUiMessage(msgEl, 'User added.', { sticky: true });
        setNameColors({ ...getNameColors(), [normalizeDisplayNameKey(displayName)]: data.chatColor || 'blue' });
        await loadMyHouseholdView();
        await loadAnthropicSection();
        const subBtn = document.getElementById('settings-subtab-admin-btn');
        if (subBtn && subBtn.style.display !== 'none') {
          await loadGlobalAdminView();
        }
      } catch (e) {
        setSettingsUiMessage(msgEl, 'Request failed.');
      }
    });
  }

  if (defaultsSaveButton) {
    defaultsSaveButton.addEventListener('click', async () => {
      clearHouseholdDefaultsUiMessage();
      const portionsEl = document.getElementById('my-settings-defaults-portions');
      const styleEl = document.getElementById('my-settings-defaults-style');
      const assistantNameEl = document.getElementById('my-settings-defaults-assistant-name');
      const assistantToneEl = document.getElementById('my-settings-defaults-assistant-tone');
      const msgEl = document.getElementById('my-settings-defaults-msg');
      const defaultDinnerPortions = portionsEl && String(portionsEl.value).trim() ? Number(portionsEl.value) : null;
      const weeknightCookingStyle = styleEl && String(styleEl.value).trim() ? String(styleEl.value).trim() : 'normal';
      const assistantName =
        assistantNameEl && String(assistantNameEl.value).trim()
          ? String(assistantNameEl.value).trim()
          : 'KitchenBot';
      const assistantTone =
        assistantToneEl && String(assistantToneEl.value).trim()
          ? normalizeToneValue(assistantToneEl.value)
          : 'helpful';
      try {
        const r = await fetch('/settings/household/defaults', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            defaultDinnerPortions,
            weeknightCookingStyle,
            assistantName,
            assistantTone,
          }),
        });
        const errBody = await r.json().catch(() => ({}));
        if (msgEl) {
          setSettingsUiMessage(
            msgEl,
            r.ok ? 'Saved.' : mapServerReadOnlyErrorMessage(errBody.error) || 'Save failed',
            { sticky: r.ok }
          );
        }
        if (r.ok) {
          setAssistantName(assistantName);
          await loadHouseholdDefaultsEditor();
        }
      } catch (e) {
        setSettingsUiMessage(msgEl, 'Request failed.');
      }
    });
  }
}

async function loadAnthropicSection() {
  const statusEl = document.getElementById('settings-anthropic-status');
  const ownerSection = document.getElementById('settings-anthropic-owner-key-section');
  const ownerKeyInput = document.getElementById('settings-anthropic-owner-key');
  const ownerMsg = document.getElementById('settings-anthropic-owner-key-msg');
  try {
    const r = await fetch('/settings/anthropic');
    if (!r.ok) return false;
    const d = await r.json();
    if (statusEl) {
      statusEl.textContent = d.statusText || '';
    }
    if (ownerSection && ownerKeyInput) {
      if (d.canEditKey) {
        ownerSection.style.display = 'block';
        ownerKeyInput.value = '';
      } else {
        ownerSection.style.display = 'none';
        ownerKeyInput.value = '';
      }
      if (ownerMsg) ownerMsg.textContent = '';
    }
    return !!d.isGlobalAdmin;
  } catch (e) {
    return false;
  }
}


function normalizeToneValue(value) {
  const key = String(value ?? '').trim().toLowerCase();
  if (key === 'sexy') return 'thirsty';
  if (key === 'sassy') return 'witty';
  if (key === 'friendly') return 'helpful';
  return ['helpful', 'concise', 'witty', 'thirsty'].includes(key) ? key : 'helpful';
}
