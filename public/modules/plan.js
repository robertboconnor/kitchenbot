// "This Week" — the household meal plan, shown as a Kitchen panel and as a compact strip above
// the chat.
//
// The plan itself is household-wide, but the /plan routes still REQUIRE a chatId query parameter
// (they 400 without one) even though the database layer ignores it. Rather than read a shared
// variable, this module keeps its own copy of which chat is open, updated by CHAT_CHANGED.

import { EVENTS, on } from './events.js';
import { setActiveTab, setKitchenView } from './navigation.js';
import { openCookbookDetail } from './cookbook.js';

let activeChatId = null;

// DOM handles, bound by initPlan() once the document exists.
let thisweekList = null;
let thisweekEmpty = null;
let thisweekStrip = null;
let chat = null;

export async function loadThisWeek() {
  if (!thisweekList) return;
  if (activeChatId == null) {
    thisweekList.innerHTML = '';
    if (thisweekEmpty) {
      thisweekEmpty.textContent = 'Open or start a chat to see this week’s plan.';
      thisweekEmpty.style.display = '';
    }
    return;
  }
  let items = [];
  try {
    const res = await fetch('/plan?chatId=' + encodeURIComponent(activeChatId), { credentials: 'same-origin' });
    if (res.ok) items = (await res.json()).items || [];
  } catch (err) {
    /* leave empty on failure */
  }
  thisweekList.innerHTML = '';
  if (thisweekEmpty) {
    thisweekEmpty.textContent = 'No meals planned this week yet. Ask KitchenBot to plan the week and they’ll show up here (across every chat).';
    thisweekEmpty.style.display = items.length === 0 ? '' : 'none';
  }
  for (const item of items) {
    const li = document.createElement('li');
    li.className = 'g-item' + (item.status === 'cooked' ? ' g-item-checked' : '');

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = item.status === 'cooked';
    checkbox.style.accentColor = 'var(--accent-strong)';
    checkbox.title = item.status === 'cooked' ? 'Mark as still to cook' : 'Mark as cooked';
    checkbox.addEventListener('change', async () => {
      const nowCooked = checkbox.checked;
      await fetch('/plan/' + item.id, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ chatId: activeChatId, status: nowCooked ? 'cooked' : 'planned' }),
      }).catch(() => {});
      if (nowCooked) {
        // one small celebratory beat, then refresh
        li.classList.add('kb-joy');
        setTimeout(() => loadThisWeek(), 480);
      } else {
        loadThisWeek();
      }
    });
    li.appendChild(checkbox);

    const nameWrap = document.createElement('span');
    nameWrap.className = 'g-item-name';
    const nameText = document.createElement('span');
    nameText.textContent = item.name;
    if (item.status === 'cooked') nameText.style.textDecoration = 'line-through';
    nameWrap.appendChild(nameText);
    if (item.cookbookEntryId) {
      const tag = document.createElement('button');
      tag.type = 'button';
      tag.textContent = '🍳 recipe';
      tag.title = 'Open ' + (item.cookbookTitle || 'the saved recipe');
      tag.style.cssText =
        'margin-left:8px;background:none;border:none;color:var(--accent-strong);font-size:12px;cursor:pointer;padding:0;text-decoration:underline;';
      tag.addEventListener('click', (e) => {
        e.stopPropagation();
        setKitchenView('cookbook');
        if (typeof openCookbookDetail === 'function') openCookbookDetail(item.cookbookEntryId);
      });
      nameWrap.appendChild(tag);
    }
    if (item.note) {
      const note = document.createElement('div');
      note.textContent = item.note;
      note.style.color = 'var(--text-soft)';
      note.style.fontSize = '12px';
      nameWrap.appendChild(note);
    }
    li.appendChild(nameWrap);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'g-item-remove';
    remove.textContent = '✕';
    remove.title = 'Remove from this week';
    remove.addEventListener('click', async () => {
      await fetch('/plan/' + item.id + '?chatId=' + encodeURIComponent(activeChatId), {
        method: 'DELETE',
        credentials: 'same-origin',
      }).catch(() => {});
      loadThisWeek();
    });
    li.appendChild(remove);

    thisweekList.appendChild(li);
  }
}

export async function renderThisWeekStrip() {
  if (!thisweekStrip) return;
  const onChatTab = chat && chat.style.display !== 'none';
  if (!onChatTab || activeChatId == null) {
    thisweekStrip.style.display = 'none';
    return;
  }
  let items = [];
  try {
    const res = await fetch('/plan?chatId=' + encodeURIComponent(activeChatId), { credentials: 'same-origin' });
    if (res.ok) items = (await res.json()).items || [];
  } catch (err) {
    /* leave empty */
  }
  if (items.length === 0) {
    thisweekStrip.innerHTML = '';
    thisweekStrip.style.display = 'none';
    return;
  }
  thisweekStrip.innerHTML = '';
  // Collapsed by DEFAULT — the meal chips ate ~1/5 of a phone screen. One line + a chevron
  // when collapsed; expands to the chips. State persists across chats/sessions.
  const collapsed = localStorage.getItem('kb_thisweek_collapsed') !== '0';
  thisweekStrip.style.cssText =
    'display:block;margin:0 0 6px;background:var(--accent-soft);border-radius:12px;overflow:hidden;';

  const header = document.createElement('button');
  header.type = 'button';
  header.setAttribute('aria-expanded', String(!collapsed));
  header.style.cssText =
    'display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;padding:8px 12px;background:none;border:none;cursor:pointer;text-align:left;';
  const label = document.createElement('span');
  label.style.cssText =
    'font-size:12px;font-weight:700;color:var(--accent-strong);text-transform:uppercase;letter-spacing:.04em;';
  const cookedCount = items.filter((i) => i.status === 'cooked').length;
  label.textContent = 'This week · ' + items.length + (cookedCount ? ' · ' + cookedCount + ' cooked' : '');
  const chevron = document.createElement('span');
  chevron.textContent = collapsed ? '▾' : '▴';
  chevron.setAttribute('aria-hidden', 'true');
  chevron.style.cssText = 'font-size:13px;color:var(--accent-strong);flex:none;';
  header.appendChild(label);
  header.appendChild(chevron);
  header.addEventListener('click', () => {
    localStorage.setItem('kb_thisweek_collapsed', collapsed ? '0' : '1');
    renderThisWeekStrip();
  });
  thisweekStrip.appendChild(header);

  if (!collapsed) {
    const body = document.createElement('div');
    body.style.cssText = 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:0 12px 10px;';
    for (const item of items) {
      const cooked = item.status === 'cooked';
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.style.cssText =
        'display:inline-flex;align-items:center;gap:5px;padding:4px 10px;border-radius:999px;border:1px solid var(--border-subtle);background:#fff;font-size:13px;cursor:pointer;' +
        (cooked ? 'opacity:.6;text-decoration:line-through;' : '');
      chip.textContent = (cooked ? '✓ ' : '') + item.name + (item.cookbookEntryId ? ' 🍳' : '');
      chip.title =
        item.name + (cooked ? ' — cooked' : ' — planned') + (item.cookbookEntryId ? ' · has a saved recipe' : '');
      chip.addEventListener('click', () => {
        setActiveTab('groceries');
        if (item.cookbookEntryId) {
          setKitchenView('cookbook');
          if (typeof openCookbookDetail === 'function') openCookbookDetail(item.cookbookEntryId);
        } else {
          setKitchenView('thisweek');
        }
      });
      body.appendChild(chip);
    }
    thisweekStrip.appendChild(body);
  }
  thisweekStrip.style.display = 'block';
}

/** Bind DOM handles and subscribe to the events the plan reacts to. */
export function initPlan() {
  thisweekList = document.getElementById('thisweek-list');
  thisweekEmpty = document.getElementById('thisweek-empty');
  thisweekStrip = document.getElementById('thisweek-strip');
  chat = document.getElementById('chat');

  on(EVENTS.CHAT_CHANGED, ({ chatId }) => {
    activeChatId = chatId;
    // Both surfaces follow the open chat.
    loadThisWeek();
    renderThisWeekStrip();
  });
  // Navigation announces where the user went; the plan decides what to redraw.
  on(EVENTS.KITCHEN_VIEW_CHANGED, ({ view }) => {
    if (view === 'thisweek') loadThisWeek();
  });
  on(EVENTS.TAB_CHANGED, ({ tab }) => {
    if (tab === 'chat') renderThisWeekStrip();
  });
  on(EVENTS.PLAN_CHANGED, () => {
    loadThisWeek();
    renderThisWeekStrip();
  });
}
