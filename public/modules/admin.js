// God Mode / global admin: impersonation banner, the household browser, and the Anthropic
// usage reports (both the admin-wide view and the per-household owner view).
//
// Owns its own household cache. Read-only state lives in session.js, which is what the rest of
// the app reacts to — this module only renders the banner and the admin surfaces.

import { EVENTS, emit, on } from './events.js';
import { getRawMe, isReadOnly, mapServerReadOnlyErrorMessage, setReadOnly } from './session.js';

let cachedAdminHouseholds = null;

// DOM handles, bound by initAdmin() once the document exists. Declared here rather than
// resolved per call so the moved code below reads exactly as it did in app.js.
let adminAnthropicShared = null;
let adminAnthropicHousehold = null;
let adminAnthropicHouseholdSelect = null;
let adminUsageRefresh = null;
let adminUsageHouseholdSelect = null;
let adminUsageStartDate = null;
let adminUsageEndDate = null;
let adminAnthropicModeSave = null;
let adminNewHhSubmit = null;
let godModeExitBtn = null;

function impersonationReadOnlyModeLabel() {
  if (!getRawMe() || !getRawMe().isImpersonating) return 'Read-only mode';
  return getRawMe().isGlobalAdmin === true ? 'God mode' : 'Demo mode';
}

function impersonationReadOnlyNoticeText() {
  const mode = impersonationReadOnlyModeLabel();
  if (mode === 'Read-only mode') {
    return 'Read-only mode. Exit to make changes.';
  }
  if (mode === 'God mode') {
    return 'God Mode is read-only. Exit God Mode to make changes.';
  }
  return 'Demo mode is read-only. Exit Demo Mode to make changes.';
}

export function applyGodModeFromMe(data) {
  const ro = !!(data && data.impersonationReadOnly && data.isImpersonating);
  const banner = document.getElementById('god-mode-banner');
  const textEl = document.getElementById('god-mode-banner-text');
  if (banner && textEl) {
    if (data && data.isImpersonating) {
      textEl.textContent = '';
      const strong = document.createElement('strong');
      strong.textContent =
        'Viewing as ' +
        String(data.name || 'user') +
        ' in ' +
        String(data.householdName || 'this household');
      textEl.appendChild(strong);
      textEl.appendChild(document.createElement('br'));
      const sub = document.createElement('span');
      sub.style.opacity = '0.92';
      sub.textContent =
        data.isGlobalAdmin === true ? 'Read-only God Mode' : 'Read-only Demo Mode';
      textEl.appendChild(sub);
      banner.style.display = 'flex';
      const exitBtn = document.getElementById('god-mode-exit-btn');
      if (exitBtn) {
        exitBtn.textContent =
          data.isGlobalAdmin === true ? 'Exit God Mode' : 'Exit Demo Mode';
      }
    } else {
      textEl.textContent = '';
      banner.style.display = 'none';
      const exitBtn = document.getElementById('god-mode-exit-btn');
      if (exitBtn) exitBtn.textContent = 'Exit God Mode';
    }
  }
  // The chat composer disables itself on READ_ONLY_CHANGED (not admin's to touch).
  const gas = document.getElementById('settings-anthropic-owner-key-save');
  const sas = document.getElementById('settings-add-submit');
  const adminModeSave = document.getElementById('admin-anthropic-mode-save');
  const adminNewHh = document.getElementById('admin-new-hh-submit');
  if (gas) gas.disabled = ro;
  if (sas) sas.disabled = ro;
  if (adminModeSave) adminModeSave.disabled = ro;
  if (adminNewHh) adminNewHh.disabled = ro;
  // Inventory controls disable themselves via READ_ONLY_CHANGED (modules/inventory.js).
  // Cookbook controls disable themselves via READ_ONLY_CHANGED (see modules/cookbook.js).
}

export function loadGlobalAdminView() {
  return refreshAdminHouseholdsList();
}

export function updateAdminAnthropicFormVisibility() {
  const sharedRadio = document.getElementById('admin-anthropic-mode-shared');
  const help = document.getElementById('admin-anthropic-shared-help');
  const isShared = sharedRadio && sharedRadio.checked;
  if (help) help.style.display = isShared ? 'block' : 'none';
}

function escapeAdminHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatAdminUsageUsd(value, available = true) {
  if (!available) return 'Unavailable';
  const n = Number(value);
  if (!Number.isFinite(n)) return 'Unavailable';
  return '$' + n.toFixed(4);
}

function collapseUsagePreviewText(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function truncateUsagePreviewText(value, limit = 80) {
  const text = collapseUsagePreviewText(value);
  if (!text) return '';
  if (text.length <= limit) return text;
  return text.slice(0, Math.max(0, limit - 1)).trimEnd() + '…';
}

function renderAdminUsageSection(title, rows, labelKey, description) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return (
      '<section class="admin-report-section"><h5>' +
      escapeAdminHtml(title) +
      '</h5>' +
      (description
        ? '<div class="admin-report-note">' + escapeAdminHtml(description) + '</div>'
        : '') +
      '<div class="admin-report-empty">No rows.</div></section>'
    );
  }
  let html =
    '<section class="admin-report-section"><h5>' +
    escapeAdminHtml(title) +
    '</h5>' +
    (description
      ? '<div class="admin-report-note">' + escapeAdminHtml(description) + '</div>'
      : '') +
    '<div class="admin-report-table-wrap"><table class="admin-report-table">' +
    '<thead><tr><th>' +
    escapeAdminHtml(labelKey) +
    '</th><th class="num">Calls</th><th class="num">In</th><th class="num">Out</th><th class="num">Est. cost</th></tr></thead><tbody>';
  for (const row of rows) {
    const label = row.householdName || row.key || '—';
    html +=
      '<tr><td>' +
      escapeAdminHtml(label) +
      '</td><td class="num">' +
      escapeAdminHtml(row.callCount != null ? row.callCount : 0) +
      '</td><td class="num">' +
      escapeAdminHtml(row.inputTokens != null ? row.inputTokens : 0) +
      '</td><td class="num">' +
      escapeAdminHtml(row.outputTokens != null ? row.outputTokens : 0) +
      '</td><td class="num">' +
      escapeAdminHtml(
        formatAdminUsageUsd(
          row.estimatedCostUsd,
          row.estimatedCostAvailable !== false
        )
      ) +
      '</td></tr>';
  }
  html += '</tbody></table></div></section>';
  return html;
}

export function renderAnthropicUsageReportInto(root, reportData, options = {}) {
  if (!root) return;
  if (!reportData || !reportData.totals) {
    root.innerHTML = '<span class="admin-report-empty">No usage data yet.</span>';
    return;
  }
  const includeByHousehold = options.includeByHousehold !== false;
  const includeHouseholdColumn = options.includeHouseholdColumn !== false;
  const includeDebugColumns = options.includeDebugColumns !== false;
  const title = options.title || 'Anthropic call ledger';
  const totals = reportData.totals || {};
  let html = '<div class="admin-report-title">' + escapeAdminHtml(title) + '</div>';
  if (reportData.household && options.statusNote !== false) {
    html +=
      '<div class="admin-report-note" style="margin-bottom:10px;">' +
      escapeAdminHtml(reportData.household.statusText || '') +
      '</div>';
  }
  html += '<div class="admin-report-stats">';
  html += '<div class="admin-report-stat"><span class="label">Calls</span><span class="value">' + escapeAdminHtml(totals.callCount != null ? totals.callCount : 0) + '</span></div>';
  html += '<div class="admin-report-stat"><span class="label">Input tokens</span><span class="value">' + escapeAdminHtml(totals.inputTokens != null ? totals.inputTokens : 0) + '</span></div>';
  html += '<div class="admin-report-stat"><span class="label">Output tokens</span><span class="value">' + escapeAdminHtml(totals.outputTokens != null ? totals.outputTokens : 0) + '</span></div>';
  html += '<div class="admin-report-stat"><span class="label">Estimated cost</span><span class="value">' +
    escapeAdminHtml(
      formatAdminUsageUsd(
        totals.estimatedCostUsd,
        totals.estimatedCostAvailable !== false
      )
    ) +
    '</span></div>';
  const cacheReadTokens = Number(totals.cacheReadInputTokens || 0);
  const cacheCreateTokens = Number(totals.cacheCreationInputTokens || 0);
  const freshInputTokens = Number(totals.inputTokens || 0);
  const inputSideTokens = freshInputTokens + cacheReadTokens + cacheCreateTokens;
  const cachedPct = inputSideTokens > 0 ? Math.round((cacheReadTokens / inputSideTokens) * 100) : 0;
  const cachingSavingsUsd =
    totals.estimatedCostWithoutCacheUsd != null && totals.estimatedCostUsd != null
      ? Number(totals.estimatedCostWithoutCacheUsd) - Number(totals.estimatedCostUsd)
      : null;
  if (cacheReadTokens > 0 || cacheCreateTokens > 0) {
    html += '<div class="admin-report-stat"><span class="label">Cached reads</span><span class="value">' + escapeAdminHtml(cacheReadTokens) + '</span></div>';
    if (cachingSavingsUsd != null && cachingSavingsUsd > 0) {
      html += '<div class="admin-report-stat"><span class="label">Saved by caching</span><span class="value">' + escapeAdminHtml(formatAdminUsageUsd(cachingSavingsUsd, true)) + '</span></div>';
    }
  }
  html += '</div>';
  if (cacheReadTokens > 0) {
    html += '<div class="admin-report-note" style="margin-top:6px;">' + escapeAdminHtml(cachedPct + '% of input tokens were served from cache (billed at ~1/10th the price of fresh input).') + '</div>';
  }
  html += '<div class="admin-report-grid">';
  html += renderAdminUsageSection(
    'Where usage went',
    reportData.byFunction || [],
    'Function',
    'A single visible KitchenBot turn usually spans several Anthropic calls — the brain loop that reasons and writes the reply, plus a truthfulness check, context loading, and titling.'
  );
  if (includeByHousehold) {
    html += renderAdminUsageSection('By household', reportData.byHousehold || [], 'Household');
  }
  html += '</div>';
  const recentRows = Array.isArray(reportData.recentRows) ? reportData.recentRows : [];
  html += '<section class="admin-report-section" style="margin-top:12px;"><h5>Recent calls</h5>';
  html += '<div class="admin-report-note">This table shows Anthropic calls made during KB turns, not every visible KitchenBot message. Some replies come from deterministic outcome text and do not create a separate ledger row.</div>';
  if (recentRows.length === 0) {
    html += '<div class="admin-report-empty">No rows.</div>';
  } else {
    html +=
      '<div class="admin-report-table-wrap"><table class="admin-report-table">' +
      '<thead><tr><th>Time</th>' +
      (includeHouseholdColumn ? '<th>Household</th>' : '') +
      '<th>Purpose</th><th>Query / Prompt</th>' +
      '<th>Model</th><th class="num">In</th><th class="num">Out</th><th class="num">Cost</th></tr></thead><tbody>';
    for (const row of recentRows) {
      const fullQueryOrPrompt = collapseUsagePreviewText(row.actionQuery || row.promptExcerpt || '');
      const queryOrPrompt = truncateUsagePreviewText(fullQueryOrPrompt, 80) || '—';
      html +=
        '<tr><td>' +
        escapeAdminHtml(row.createdAt || '—') +
        '</td>' +
        (includeHouseholdColumn
          ? '<td>' + escapeAdminHtml(row.householdName || row.householdId || '—') + '</td>'
          : '') +
        '<td>' +
        escapeAdminHtml(row.callPurpose || '—') +
        '</td>' +
        '<td title="' + escapeAdminHtml(fullQueryOrPrompt || '—') + '">' + escapeAdminHtml(queryOrPrompt) + '</td>' +
        '<td>' +
        escapeAdminHtml(row.model || '—') +
        '</td><td class="num">' +
        escapeAdminHtml(row.inputTokens != null ? row.inputTokens : 0) +
        '</td><td class="num">' +
        escapeAdminHtml(row.outputTokens != null ? row.outputTokens : 0) +
        '</td><td class="num">' +
        escapeAdminHtml(formatAdminUsageUsd(row.estimatedCostUsd, row.estimatedCostUsd != null)) +
        '</td></tr>';
    }
    html += '</tbody></table></div>';
  }
  html += '</section>';
  html += renderAdminUsageSection(
    'Raw internal purposes',
    reportData.byPurpose || [],
    'Purpose',
    'This is the low-level engineering breakdown of the raw call_purpose values written to the ledger.'
  );
  root.innerHTML = html;
}

function renderAdminUsageReport(reportData) {
  const root = document.getElementById('admin-usage-report');
  renderAnthropicUsageReportInto(root, reportData, {
    includeByHousehold: true,
    includeHouseholdColumn: true,
    title: 'Anthropic call ledger',
    statusNote: false,
  });
}

function renderOwnerAnthropicUsageReport(reportData) {
  const root = document.getElementById('owner-usage-report');
  renderAnthropicUsageReportInto(root, reportData, {
    includeByHousehold: false,
    includeHouseholdColumn: false,
    title: 'Household Anthropic usage',
    statusNote: false,
  });
  const noteEl = document.getElementById('owner-usage-status-note');
  if (noteEl) {
    const household = reportData && reportData.household;
    noteEl.textContent = household ? household.statusText : '';
  }
}

export async function refreshAdminUsageReport() {
  const msgEl = document.getElementById('admin-usage-msg');
  const reportEl = document.getElementById('admin-usage-report');
  const startEl = document.getElementById('admin-usage-start-date');
  const endEl = document.getElementById('admin-usage-end-date');
  const hhEl = document.getElementById('admin-usage-household-select');
  if (!reportEl || !startEl || !endEl || !hhEl) return;
  if (msgEl) msgEl.textContent = 'Loading usage…';
  try {
    const qs = new URLSearchParams();
    if (startEl.value) qs.set('startDate', startEl.value);
    if (endEl.value) qs.set('endDate', endEl.value);
    if (hhEl.value && hhEl.value !== 'all') qs.set('householdId', hhEl.value);
    const r = await fetch('/admin/usage-report?' + qs.toString());
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      if (msgEl) msgEl.textContent = data.error || 'Failed to load usage.';
      return;
    }
    renderAdminUsageReport(data);
    if (msgEl) msgEl.textContent = '';
  } catch (e) {
    if (msgEl) msgEl.textContent = 'Failed to load usage.';
  }
}

export async function refreshOwnerAnthropicUsageReport() {
  const msgEl = document.getElementById('owner-usage-msg');
  const reportEl = document.getElementById('owner-usage-report');
  const startEl = document.getElementById('owner-usage-start-date');
  const endEl = document.getElementById('owner-usage-end-date');
  if (!reportEl || !startEl || !endEl) return;
  if (msgEl) msgEl.textContent = 'Loading usage…';
  try {
    const qs = new URLSearchParams();
    if (startEl.value) qs.set('startDate', startEl.value);
    if (endEl.value) qs.set('endDate', endEl.value);
    const r = await fetch('/settings/household/anthropic-usage?' + qs.toString());
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      if (msgEl) msgEl.textContent = data.error || 'Failed to load usage.';
      return;
    }
    renderOwnerAnthropicUsageReport(data);
    if (msgEl) msgEl.textContent = '';
  } catch (e) {
    if (msgEl) msgEl.textContent = 'Failed to load usage.';
  }
}

function renderAdminHouseholdDetail(detailData) {
  const hh = detailData && detailData.household;
  if (!hh) return;
  const usage = detailData.usage;
  const nameEl = document.getElementById('admin-detail-name');
  const keyEl = document.getElementById('admin-detail-key');
  const tbody = document.getElementById('admin-detail-users-body');
  const banner = document.getElementById('admin-editing-banner');
  const usageEl = document.getElementById('admin-detail-usage');
  const pinGlobalMsg = document.getElementById('admin-pin-global-msg');
  if (pinGlobalMsg) pinGlobalMsg.textContent = '';
  if (nameEl) nameEl.textContent = hh.name;
  if (keyEl) keyEl.textContent = hh.householdKey;
  if (banner) {
    banner.textContent =
      'Editing: #' + hh.id + ' — ' + hh.name + ' (household key: ' + hh.householdKey + ')';
  }
  if (usageEl) {
    if (usage) {
      let html =
        '<div class="settings-admin-usage-summary"><h5>Message usage (stored messages)</h5>' +
        '<div>Total messages (this household): <strong>' +
        (usage.totalMessages != null ? usage.totalMessages : 0) +
        '</strong></div>';
      html +=
        '<div style="margin-top:6px;">Latest message: <strong>' +
        (usage.latestMessageAt ? String(usage.latestMessageAt) : '—') +
        '</strong></div>';
      html += '<div style="margin-top:10px; font-size:12px; text-transform:uppercase; letter-spacing:0.08em; color:var(--text-soft);">User messages by name</div>';
      const rows = usage.messagesByUser || [];
      if (rows.length === 0) {
        html += '<div class="admin-report-empty" style="margin-top:6px;">No user messages yet.</div>';
      } else {
        html += '<ul>';
        for (const row of rows) {
          html +=
            '<li>' +
            escapeAdminHtml(row.displayName || '—') +
            ': ' +
            (row.count != null ? row.count : 0) +
            '</li>';
        }
        html += '</ul>';
      }
      html += '</div>';
      usageEl.innerHTML = html;
    } else {
      usageEl.innerHTML = '';
    }
  }
  if (tbody) {
    tbody.innerHTML = '';
    for (const u of hh.users || []) {
      const tr = document.createElement('tr');
      const td1 = document.createElement('td');
      td1.textContent = u.displayName;
      const td3 = document.createElement('td');
      const pinIn = document.createElement('input');
      pinIn.type = 'password';
      pinIn.placeholder = 'new PIN';
      pinIn.autocomplete = 'new-password';
      pinIn.style.maxWidth = '120px';
      pinIn.disabled = isReadOnly();
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = 'Set PIN';
      btn.style.marginLeft = '8px';
      btn.disabled = isReadOnly();
      btn.addEventListener('click', async () => {
        const pin = pinIn.value.trim();
        if (!pin) {
          if (pinGlobalMsg) pinGlobalMsg.textContent = 'Enter a PIN for ' + u.displayName + '.';
          return;
        }
        const rr = await fetch(
          '/admin/households/' + encodeURIComponent(hh.id) + '/users/' + encodeURIComponent(u.id) + '/pin',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pin }),
          }
        );
        const errBody = await rr.json().catch(() => ({}));
        if (pinGlobalMsg) {
          pinGlobalMsg.textContent = rr.ok
            ? 'PIN updated for #' + hh.id + ' — ' + hh.name + ' / user "' + u.displayName + '" (id ' + u.id + ').'
            : mapServerReadOnlyErrorMessage(errBody.error) || 'Failed to update PIN.';
        }
        if (rr.ok) pinIn.value = '';
      });
      td3.appendChild(pinIn);
      td3.appendChild(btn);
      const td4 = document.createElement('td');
      if (!isReadOnly()) {
        const viewAsBtn = document.createElement('button');
        viewAsBtn.type = 'button';
        viewAsBtn.textContent = 'View as';
        viewAsBtn.addEventListener('click', async () => {
          try {
            const rr = await fetch('/admin/impersonate', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ householdId: hh.id, userId: u.id }),
            });
            const errBody = await rr.json().catch(() => ({}));
            if (!rr.ok) {
              if (pinGlobalMsg) {
                pinGlobalMsg.textContent = errBody.error || 'Could not start God Mode.';
              }
              return;
            }
            const meR = await fetch('/me');
            if (!meR.ok) {
              emit(EVENTS.SESSION_EXPIRED, {});
              return;
            }
            const meData = await meR.json();
            // The shell owns re-hydration; admin only reports that identity changed.
            emit(EVENTS.REHYDRATE_APP, {
              me: meData,
              options: { forceChatTab: true, resetSessionView: true },
            });
          } catch (e) {
            if (pinGlobalMsg) pinGlobalMsg.textContent = 'Request failed.';
          }
        });
        td4.appendChild(viewAsBtn);
      } else {
        td4.textContent = '—';
      }
      tr.appendChild(td1);
      tr.appendChild(td3);
      tr.appendChild(td4);
      tbody.appendChild(tr);
    }
  }
}

export async function loadAdminAnthropicForSelected() {
  const sel = document.getElementById('admin-anthropic-household-select');
  const hid = sel && sel.value ? Number(sel.value) : NaN;
  const sharedRadio = document.getElementById('admin-anthropic-mode-shared');
  const hhRadio = document.getElementById('admin-anthropic-mode-household');
  const statEl = document.getElementById('admin-anthropic-selected-status');
  const msgEl = document.getElementById('admin-anthropic-msg');
  if (!sharedRadio || !hhRadio || !Number.isFinite(hid)) return;
  try {
    const rDetail = await fetch('/admin/households/' + encodeURIComponent(hid));
    if (rDetail.ok) {
      const detailData = await rDetail.json();
      if (detailData.household) {
        renderAdminHouseholdDetail(detailData);
        if (cachedAdminHouseholds) {
          const ix = cachedAdminHouseholds.findIndex((h) => h.id === hid);
          if (ix >= 0) cachedAdminHouseholds[ix] = detailData.household;
        }
      }
    }
    const r = await fetch('/settings/anthropic?householdId=' + encodeURIComponent(hid));
    if (!r.ok) return;
    const d = await r.json();
    if (d.household.anthropicKeyMode === 'household') {
      hhRadio.checked = true;
    } else {
      sharedRadio.checked = true;
    }
    if (statEl) {
      statEl.textContent =
        'Anthropic: ' +
        (d.statusBrief || d.statusText || '') +
        ' · Runtime: Smart only';
    }
    updateAdminAnthropicFormVisibility();
    if (msgEl) msgEl.textContent = '';
  } catch (e) {}
}

export async function refreshAdminHouseholdsList() {
  const listEl = document.getElementById('settings-admin-households-list');
  const sel = document.getElementById('admin-anthropic-household-select');
  const usageSel = document.getElementById('admin-usage-household-select');
  if (!listEl && !sel && !usageSel) return;
  try {
    const r = await fetch('/admin/households');
    if (!r.ok) return;
    const data = await r.json();
    const households = data.households || [];
    cachedAdminHouseholds = households;
    const prevSel = sel && sel.value;
    const prevUsageSel = usageSel && usageSel.value;
    if (listEl) {
      listEl.innerHTML = '';
      listEl.className = 'settings-admin-household-list';
      for (const hh of households) {
        const row = document.createElement('div');
        row.className = 'settings-admin-household-row';
        const main = document.createElement('div');
        main.className = 'settings-admin-household-row-main';
        const n =
          hh.totalMessages != null && Number.isFinite(Number(hh.totalMessages))
            ? Number(hh.totalMessages)
            : 0;
        const msgLabel = n === 1 ? 'msg' : 'msgs';
        const name = document.createElement('strong');
        name.className = 'settings-admin-household-name';
        name.textContent = '#' + hh.id + ' — ' + hh.name;
        const meta = document.createElement('div');
        meta.className = 'settings-admin-household-meta';
        meta.textContent =
          'Key ' +
          hh.householdKey +
          ' • ' +
          n +
          ' ' +
          msgLabel +
          ' • ' +
          hh.anthropicStatusLabel;
        main.appendChild(name);
        main.appendChild(meta);
        const tags = document.createElement('div');
        tags.className = 'settings-admin-household-tags';
        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'settings-admin-household-delete';
        delBtn.textContent = 'Delete';
        delBtn.style.marginLeft = 'auto';
        delBtn.addEventListener('click', async () => {
          const typed = window.prompt(
            'Permanently delete household "' + hh.name + '" and ALL of its data (users, chats, lists, cookbook — everything). This cannot be undone.\\n\\nType the household name to confirm:'
          );
          if (typed == null) return;
          if (typed.trim() !== String(hh.name).trim()) {
            window.alert('Name did not match — nothing was deleted.');
            return;
          }
          try {
            const dr = await fetch('/admin/households/' + encodeURIComponent(hh.id), {
              method: 'DELETE',
              credentials: 'same-origin',
            });
            const data = await dr.json().catch(() => ({}));
            if (!dr.ok) {
              window.alert(data.error || 'Delete failed.');
              return;
            }
            await refreshAdminHouseholdsList();
          } catch (e) {
            window.alert('Delete failed.');
          }
        });
        tags.appendChild(delBtn);
        row.appendChild(main);
        row.appendChild(tags);
        listEl.appendChild(row);
      }
    }
    if (sel) {
      sel.innerHTML = '';
      for (const hh of households) {
        const opt = document.createElement('option');
        opt.value = String(hh.id);
        opt.textContent = '#' + hh.id + ' — ' + hh.name;
        sel.appendChild(opt);
      }
      if (prevSel && households.some((h) => String(h.id) === prevSel)) {
        sel.value = prevSel;
      } else if (households.length) {
        sel.selectedIndex = 0;
      }
      await loadAdminAnthropicForSelected();
    }
    if (usageSel) {
      usageSel.innerHTML = '';
      const allOpt = document.createElement('option');
      allOpt.value = 'all';
      allOpt.textContent = 'All households';
      usageSel.appendChild(allOpt);
      for (const hh of households) {
        const opt = document.createElement('option');
        opt.value = String(hh.id);
        opt.textContent = '#' + hh.id + ' — ' + hh.name;
        usageSel.appendChild(opt);
      }
      if (prevUsageSel && (prevUsageSel === 'all' || households.some((h) => String(h.id) === prevUsageSel))) {
        usageSel.value = prevUsageSel;
      } else {
        usageSel.value = 'all';
      }
    }
    await refreshAdminUsageReport();
  } catch (e) {}
}

export function initializeAdminUsageFilters() {
  const startEl = document.getElementById('admin-usage-start-date');
  const endEl = document.getElementById('admin-usage-end-date');
  if (!startEl || !endEl) return;
  if (!endEl.value) {
    const end = new Date();
    endEl.value = end.toISOString().slice(0, 10);
  }
  if (!startEl.value) {
    const start = new Date();
    start.setDate(start.getDate() - 7);
    startEl.value = start.toISOString().slice(0, 10);
  }
}

export function initializeOwnerUsageFilters() {
  const startEl = document.getElementById('owner-usage-start-date');
  const endEl = document.getElementById('owner-usage-end-date');
  if (!startEl || !endEl) return;
  if (!endEl.value) {
    const end = new Date();
    endEl.value = end.toISOString().slice(0, 10);
  }
  if (!startEl.value) {
    const start = new Date();
    start.setDate(start.getDate() - 7);
    startEl.value = start.toISOString().slice(0, 10);
  }
}

export async function refreshOwnerAnthropicUsageView() {
  initializeOwnerUsageFilters();
  await refreshOwnerAnthropicUsageReport();
}


/** The God Mode / admin controls: usage filters, household selection, key mode, exit. */
function initAdminUi() {
  if (adminAnthropicShared) adminAnthropicShared.addEventListener('change', updateAdminAnthropicFormVisibility);

  if (adminAnthropicHousehold) adminAnthropicHousehold.addEventListener('change', updateAdminAnthropicFormVisibility);

  if (adminAnthropicHouseholdSelect) {
    adminAnthropicHouseholdSelect.addEventListener('change', () => {
      loadAdminAnthropicForSelected();
    });
  }

  if (adminUsageRefresh) {
    adminUsageRefresh.addEventListener('click', async () => {
      await refreshAdminUsageReport();
    });
  }

  if (adminUsageHouseholdSelect) {
    adminUsageHouseholdSelect.addEventListener('change', () => {
      refreshAdminUsageReport();
    });
  }

  if (adminUsageStartDate) {
    adminUsageStartDate.addEventListener('change', () => {
      refreshAdminUsageReport();
    });
  }

  if (adminUsageEndDate) {
    adminUsageEndDate.addEventListener('change', () => {
      refreshAdminUsageReport();
    });
  }

  if (adminAnthropicModeSave) {
    adminAnthropicModeSave.addEventListener('click', async () => {
      const sel = document.getElementById('admin-anthropic-household-select');
      const hid = sel && sel.value ? Number(sel.value) : NaN;
      const msgEl = document.getElementById('admin-anthropic-msg');
      if (!Number.isFinite(hid)) {
        if (msgEl) msgEl.textContent = 'Select a household.';
        return;
      }
      const shared = document.getElementById('admin-anthropic-mode-shared');
      const mode = shared && shared.checked ? 'shared' : 'household';
      try {
        const r = await fetch('/settings/anthropic/mode', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ householdId: hid, anthropicKeyMode: mode }),
        });
        const errBody = await r.json().catch(() => ({}));
        if (!r.ok) {
          if (msgEl) msgEl.textContent = mapServerReadOnlyErrorMessage(errBody.error) || 'Save failed';
          return;
        }
        if (msgEl) msgEl.textContent = 'Mode saved.';
        await loadGlobalAdminView();
      } catch (e) {
        if (msgEl) msgEl.textContent = 'Request failed.';
      }
    });
  }

  if (adminNewHhSubmit) {
    adminNewHhSubmit.addEventListener('click', async () => {
      const householdName = document.getElementById('admin-new-hh-name').value.trim();
      const householdKey = document.getElementById('admin-new-hh-key').value.trim();
      const ownerDisplayName = document.getElementById('admin-new-owner-name').value.trim();
      const ownerPin = document.getElementById('admin-new-owner-pin').value;
      const msgEl = document.getElementById('admin-new-hh-msg');
      if (!householdName || !householdKey || !ownerDisplayName || !ownerPin) {
        if (msgEl) msgEl.textContent = 'All fields are required.';
        return;
      }
      if (msgEl) msgEl.textContent = 'Creating…';
      try {
        const r = await fetch('/admin/households', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ householdName, householdKey, ownerDisplayName, ownerPin }),
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) {
          if (msgEl) msgEl.textContent = mapServerReadOnlyErrorMessage(data.error) || 'Failed';
          return;
        }
        if (msgEl) {
          msgEl.textContent =
            'Created household #' + data.household.id + ' — owner user id ' + data.owner.id + '.';
        }
        document.getElementById('admin-new-hh-name').value = '';
        document.getElementById('admin-new-hh-key').value = '';
        document.getElementById('admin-new-owner-name').value = '';
        document.getElementById('admin-new-owner-pin').value = '';
        await loadGlobalAdminView();
      } catch (e) {
        if (msgEl) msgEl.textContent = 'Request failed.';
      }
    });
  }

  if (godModeExitBtn) {
    godModeExitBtn.addEventListener('click', async () => {
      try {
        const r = await fetch('/admin/impersonate/exit', { method: 'POST' });
        if (!r.ok) return;
        const meR = await fetch('/me');
        if (!meR.ok) {
          showLogin();
          return;
        }
        const meData = await meR.json();
        await rehydrateAuthenticatedApp(meData, { forceChatTab: true, resetSessionView: true });
      } catch (e) {}
    });
  }
}

/** Bind DOM handles and wire this feature's own listeners. Called once at startup. */
export function initAdmin() {
  adminAnthropicShared = document.getElementById('admin-anthropic-mode-shared');
  adminAnthropicHousehold = document.getElementById('admin-anthropic-mode-household');
  adminAnthropicHouseholdSelect = document.getElementById('admin-anthropic-household-select');
  adminUsageRefresh = document.getElementById('admin-usage-refresh');
  adminUsageHouseholdSelect = document.getElementById('admin-usage-household-select');
  adminUsageStartDate = document.getElementById('admin-usage-start-date');
  adminUsageEndDate = document.getElementById('admin-usage-end-date');
  adminAnthropicModeSave = document.getElementById('admin-anthropic-mode-save');
  adminNewHhSubmit = document.getElementById('admin-new-hh-submit');
  godModeExitBtn = document.getElementById('god-mode-exit-btn');

  initAdminUi();
}
