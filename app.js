/* ── State ───────────────────────────────────────────────────────────────── */

const STORAGE_KEY = 'timetracker_v1';

let state = {
  groups: [],
  activeTaskId: null,
  globalPaused: false
};

let structureDirty = true;
let currentView = 'tracker'; // 'tracker' | 'stats'

/* ── Modal context ───────────────────────────────────────────────────────── */
let modalMode = null;     // 'group' | 'task'
let modalGroupId = null;
let bulkMode = false;

/* ── Edit sheet context ──────────────────────────────────────────────────── */
let editTaskId = null;
let editArchiveConfirm = false;
let editArchiveTimer = null;

/* ── Long press ──────────────────────────────────────────────────────────── */
let longPressTimer = null;
let longPressTriggered = false;
const LONG_PRESS_MS = 500;

/* ── Color palette ───────────────────────────────────────────────────────── */
const COLORS = [
  '#4A90E2', '#E24A4A', '#4ACE7A', '#E2974A',
  '#974AE2', '#4AE2D9', '#E2CC4A', '#E24A97'
];
let selectedColor = COLORS[0];

/* ── Persistence ─────────────────────────────────────────────────────────── */

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    // Migration: ensure all tasks have archived field
    (parsed.groups || []).forEach(g =>
      (g.tasks || []).forEach(t => { if (t.archived === undefined) t.archived = false; })
    );
    state = { globalPaused: false, ...parsed };
  } catch (e) {
    console.warn('TimeTracker: loadState failed', e);
  }
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    console.warn('TimeTracker: saveState failed', e);
  }
}

/* ── Utilities ───────────────────────────────────────────────────────────── */

function uid() {
  return typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function formatMs(ms) {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${pad(h)}:${pad(m)}:${pad(sec)}`;
}

function pad(n) { return String(n).padStart(2, '0'); }

function parseTimeInput(str) {
  str = (str || '').trim();
  const parts = str.split(':').map(v => Math.max(0, parseInt(v, 10) || 0));
  if (parts.length === 3) return (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;
  if (parts.length === 2) return (parts[0] * 60 + parts[1]) * 1000;
  return parts[0] * 60 * 1000;
}

function computeMs(task) {
  return task.totalMs + (task.startedAt ? Date.now() - task.startedAt : 0);
}

function groupTotal(group) {
  return group.tasks.reduce((s, t) => s + computeMs(t), 0);
}

function findTask(taskId) {
  for (const g of state.groups) {
    const t = g.tasks.find(t => t.id === taskId);
    if (t) return { task: t, group: g };
  }
  return null;
}

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function pauseActiveTask() {
  if (!state.activeTaskId) return;
  const found = findTask(state.activeTaskId);
  if (found) {
    found.task.totalMs += Date.now() - found.task.startedAt;
    found.task.startedAt = null;
  }
  state.activeTaskId = null;
}

/* ── Dispatch ────────────────────────────────────────────────────────────── */

function dispatch(action) {
  switch (action.type) {

    case 'TAP_TASK': {
      if (state.globalPaused) return;
      const found = findTask(action.taskId);
      if (!found || found.task.archived) return;
      const { task } = found;

      if (state.activeTaskId === action.taskId) {
        // Pause this task
        task.totalMs += Date.now() - task.startedAt;
        task.startedAt = null;
        state.activeTaskId = null;
      } else {
        pauseActiveTask();
        task.startedAt = Date.now();
        state.activeTaskId = action.taskId;
      }
      structureDirty = true;
      break;
    }

    case 'TOGGLE_GLOBAL_PAUSE': {
      if (!state.globalPaused) {
        pauseActiveTask();
        state.globalPaused = true;
      } else {
        state.globalPaused = false;
      }
      structureDirty = true;
      break;
    }

    case 'ADD_GROUP': {
      state.groups.push({ id: uid(), name: action.name, color: action.color, tasks: [] });
      structureDirty = true;
      break;
    }

    case 'DELETE_GROUP': {
      const g = state.groups.find(g => g.id === action.groupId);
      if (g && g.tasks.some(t => t.id === state.activeTaskId)) pauseActiveTask();
      state.groups = state.groups.filter(g => g.id !== action.groupId);
      structureDirty = true;
      break;
    }

    case 'ADD_TASK': {
      const g = state.groups.find(g => g.id === action.groupId);
      if (!g) return;
      const names = action.names || (action.name ? [action.name] : []);
      names.forEach(name => {
        name = name.trim();
        if (name) g.tasks.push({ id: uid(), name, totalMs: 0, startedAt: null, archived: false });
      });
      structureDirty = true;
      break;
    }

    case 'DELETE_TASK': {
      if (state.activeTaskId === action.taskId) pauseActiveTask();
      state.groups.forEach(g => { g.tasks = g.tasks.filter(t => t.id !== action.taskId); });
      structureDirty = true;
      break;
    }

    case 'EDIT_TASK': {
      const found = findTask(action.taskId);
      if (!found) return;
      const { task } = found;
      if (state.activeTaskId === action.taskId) pauseActiveTask();
      if (action.name)              task.name    = action.name;
      if (action.totalMs !== undefined) task.totalMs = action.totalMs;
      structureDirty = true;
      break;
    }

    case 'ARCHIVE_TASK': {
      const found = findTask(action.taskId);
      if (!found) return;
      if (state.activeTaskId === action.taskId) pauseActiveTask();
      found.task.archived = true;
      structureDirty = true;
      break;
    }

    case 'UNARCHIVE_TASK': {
      const found = findTask(action.taskId);
      if (found) found.task.archived = false;
      structureDirty = true;
      break;
    }

    case 'TICK':
      // No state mutation — just re-render timers
      break;
  }

  saveState();
  render();
}

/* ── Render orchestration ────────────────────────────────────────────────── */

function render() {
  updateHeader();
  if (currentView === 'tracker') {
    if (structureDirty) {
      renderStructure();
      structureDirty = false;
    } else {
      renderTimers();
    }
  } else {
    if (structureDirty) {
      renderStats();
      structureDirty = false;
    }
  }
}

/* ── Header update ───────────────────────────────────────────────────────── */

function updateHeader() {
  // Global pause button
  const pauseBtn = document.getElementById('btn-global-pause');
  document.getElementById('icon-pause').classList.toggle('hidden',  state.globalPaused);
  document.getElementById('icon-play').classList.toggle('hidden',  !state.globalPaused);
  pauseBtn.classList.toggle('active', state.globalPaused);
  pauseBtn.title = state.globalPaused ? 'Reprendre' : 'Pause générale';

  // Pause banner
  document.getElementById('global-pause-banner').classList.toggle('hidden', !state.globalPaused);

  // Title & stats button icon
  const inStats = currentView === 'stats';
  document.getElementById('app-title').textContent = inStats ? 'Statistiques' : 'TimeTracker';
  document.getElementById('icon-stats').classList.toggle('hidden',  inStats);
  document.getElementById('icon-back').classList.toggle('hidden',  !inStats);
  document.getElementById('btn-stats').title = inStats ? 'Retour' : 'Statistiques';

  // Add-group button only in tracker view
  document.getElementById('btn-add-group').classList.toggle('hidden', inStats);
}

/* ── Tracker structure render ────────────────────────────────────────────── */

function renderStructure() {
  clearTimeout(longPressTimer);
  longPressTimer = null;
  longPressTriggered = false;

  const root = document.getElementById('app-root');
  root.innerHTML = '';

  if (state.groups.length === 0) {
    root.innerHTML = `
      <div class="empty-state">
        <svg viewBox="0 0 64 64" width="64" height="64" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="32" cy="36" r="22"/>
          <polyline points="32,22 32,36 40,42"/>
          <rect x="22" y="10" width="20" height="8" rx="4"/>
        </svg>
        <p>Aucun groupe pour l'instant</p>
        <p class="hint">Appuie sur <strong>+ Groupe</strong> pour commencer</p>
      </div>`;
    return;
  }

  for (const group of state.groups) {
    const activeTasks = group.tasks.filter(t => !t.archived);
    const section = buildGroupEl(group, activeTasks);
    root.appendChild(section);
  }
}

function buildGroupEl(group, activeTasks) {
  const section = document.createElement('section');
  section.className = 'group';
  section.dataset.groupId = group.id;
  section.style.setProperty('--group-color', group.color);

  /* Group header */
  const header = document.createElement('div');
  header.className = 'group-header';
  header.innerHTML = `
    <span class="group-dot"></span>
    <span class="group-name">${esc(group.name)}</span>
    <span class="group-total" data-group-id="${group.id}">${formatMs(groupTotal(group))}</span>
    <button class="btn-add-task btn-icon-sm" title="Ajouter une tâche">+</button>
    <button class="btn-delete-group btn-icon-sm danger" title="Supprimer le groupe">✕</button>
  `;
  header.querySelector('.btn-add-task').addEventListener('click', () => openModal('task', group.id));
  header.querySelector('.btn-delete-group').addEventListener('click', () =>
    animateDelete(section, () => dispatch({ type: 'DELETE_GROUP', groupId: group.id }))
  );
  section.appendChild(header);

  /* Task list */
  const ul = document.createElement('ul');
  ul.className = 'task-list';

  if (activeTasks.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'task-empty';
    empty.textContent = 'Aucune tâche — appuie sur + pour en ajouter';
    ul.appendChild(empty);
  }

  for (const task of activeTasks) {
    ul.appendChild(buildTaskEl(task));
  }

  section.appendChild(ul);
  return section;
}

function buildTaskEl(task) {
  const isRunning = task.id === state.activeTaskId;
  const li = document.createElement('li');
  li.className = `task-card${isRunning ? ' running' : ''}${state.globalPaused ? ' paused' : ''}`;
  li.dataset.taskId = task.id;

  li.innerHTML = `
    <div class="task-main">
      <span class="task-run-dot"></span>
      <span class="task-name">${esc(task.name)}</span>
    </div>
    <div class="task-right">
      <span class="task-timer" data-timer-id="${task.id}">${formatMs(computeMs(task))}</span>
      <button class="btn-delete-task btn-icon-sm danger" title="Supprimer">✕</button>
    </div>
  `;

  /* Tap = start/pause */
  li.addEventListener('click', e => {
    if (e.target.closest('.btn-delete-task')) return;
    if (longPressTriggered) { longPressTriggered = false; return; }
    dispatch({ type: 'TAP_TASK', taskId: task.id });
  });

  /* Long press = edit sheet */
  li.addEventListener('pointerdown', e => {
    if (e.target.closest('.btn-delete-task')) return;
    longPressTriggered = false;
    longPressTimer = setTimeout(() => {
      longPressTriggered = true;
      navigator.vibrate && navigator.vibrate(30);
      openEditSheet(task.id);
    }, LONG_PRESS_MS);
  });
  const cancelLP = () => clearTimeout(longPressTimer);
  li.addEventListener('pointerup',     cancelLP);
  li.addEventListener('pointercancel', cancelLP);
  li.addEventListener('pointermove',   cancelLP);

  /* Delete */
  li.querySelector('.btn-delete-task').addEventListener('click', e => {
    e.stopPropagation();
    animateDelete(li, () => dispatch({ type: 'DELETE_TASK', taskId: task.id }));
  });

  return li;
}

/* ── Tracker timer-only update (every tick) ──────────────────────────────── */

function renderTimers() {
  for (const group of state.groups) {
    // Update group total
    const totalEl = document.querySelector(`.group-total[data-group-id="${group.id}"]`);
    if (totalEl) totalEl.textContent = formatMs(groupTotal(group));

    for (const task of group.tasks) {
      if (task.archived) continue;
      const timerEl = document.querySelector(`.task-timer[data-timer-id="${task.id}"]`);
      if (timerEl) timerEl.textContent = formatMs(computeMs(task));
      const card = document.querySelector(`.task-card[data-task-id="${task.id}"]`);
      if (card) {
        card.classList.toggle('running', task.id === state.activeTaskId);
        card.classList.toggle('paused',  state.globalPaused);
      }
    }
  }
}

/* ── Stats render ────────────────────────────────────────────────────────── */

function renderStats() {
  const root = document.getElementById('app-root');
  root.innerHTML = '';

  if (state.groups.length === 0) {
    root.innerHTML = `<div class="empty-state"><p>Aucune donnée à afficher.</p></div>`;
    return;
  }

  let grandTotal = 0;
  const sorted = [...state.groups].sort((a, b) => groupTotal(b) - groupTotal(a));

  for (const group of sorted) {
    const total = groupTotal(group);
    grandTotal += total;

    const section = document.createElement('section');
    section.className = 'stats-group';
    section.style.setProperty('--group-color', group.color);

    section.innerHTML = `
      <div class="stats-group-header">
        <span class="group-dot"></span>
        <span class="stats-group-name">${esc(group.name)}</span>
        <span class="stats-group-total">${formatMs(total)}</span>
      </div>
    `;

    const ul = document.createElement('ul');
    ul.className = 'stats-task-list';

    const active   = [...group.tasks].filter(t => !t.archived).sort((a, b) => computeMs(b) - computeMs(a));
    const archived = [...group.tasks].filter(t =>  t.archived).sort((a, b) => computeMs(b) - computeMs(a));

    for (const task of active) {
      ul.appendChild(buildStatsRow(task, false));
    }

    if (archived.length > 0) {
      const label = document.createElement('li');
      label.className = 'stats-section-label';
      label.textContent = 'Archivées';
      ul.appendChild(label);
      for (const task of archived) ul.appendChild(buildStatsRow(task, true));
    }

    section.appendChild(ul);
    root.appendChild(section);
  }

  const footer = document.createElement('div');
  footer.className = 'stats-footer';
  footer.innerHTML = `<span>Total général</span><span class="stats-footer-time">${formatMs(grandTotal)}</span>`;
  root.appendChild(footer);
}

function buildStatsRow(task, isArchived) {
  const li = document.createElement('li');
  li.className = `stats-task-row${isArchived ? ' archived' : ''}`;
  li.innerHTML = `
    <span class="stats-task-name">${esc(task.name)}</span>
    <span class="stats-task-time">${formatMs(computeMs(task))}</span>
    ${isArchived ? `<button class="btn-unarchive btn-icon-sm" title="Désarchiver">↩</button>` : ''}
  `;
  if (isArchived) {
    li.querySelector('.btn-unarchive').addEventListener('click', () =>
      dispatch({ type: 'UNARCHIVE_TASK', taskId: task.id })
    );
  }
  return li;
}

/* ── Delete animation ────────────────────────────────────────────────────── */

function animateDelete(el, callback) {
  el.classList.add('removing');
  el.addEventListener('animationend', callback, { once: true });
}

/* ── Modal ───────────────────────────────────────────────────────────────── */

function openModal(mode, groupId = null) {
  modalMode   = mode;
  modalGroupId = groupId;
  bulkMode    = false;

  const input    = document.getElementById('modal-input');
  const bulk     = document.getElementById('modal-bulk');
  const toggle   = document.getElementById('btn-toggle-bulk');
  const colorRow = document.getElementById('modal-color-row');
  const bulkRow  = document.getElementById('modal-bulk-row');

  input.value = '';
  input.classList.remove('hidden');
  bulk.value = '';
  bulk.classList.add('hidden');
  toggle.textContent = 'Ajouter plusieurs tâches à la fois →';

  if (mode === 'group') {
    document.getElementById('modal-title').textContent = 'Nouveau groupe';
    input.placeholder = 'Nom du groupe';
    colorRow.classList.remove('hidden');
    bulkRow.classList.add('hidden');
    initColorSwatches();
  } else {
    document.getElementById('modal-title').textContent = 'Nouvelle tâche';
    input.placeholder = 'Nom de la tâche';
    colorRow.classList.add('hidden');
    bulkRow.classList.remove('hidden');
  }

  showOverlay('modal-overlay');
  setTimeout(() => input.focus(), 120);
}

function closeModal() { hideOverlay('modal-overlay'); }

function confirmModal() {
  if (modalMode === 'group') {
    const name = document.getElementById('modal-input').value.trim();
    if (!name) return;
    dispatch({ type: 'ADD_GROUP', name, color: selectedColor });
    closeModal();
    return;
  }
  // task mode
  if (bulkMode) {
    const lines = document.getElementById('modal-bulk').value
      .split('\n').map(l => l.trim()).filter(Boolean);
    if (!lines.length) return;
    dispatch({ type: 'ADD_TASK', groupId: modalGroupId, names: lines });
  } else {
    const name = document.getElementById('modal-input').value.trim();
    if (!name) return;
    dispatch({ type: 'ADD_TASK', groupId: modalGroupId, name });
  }
  closeModal();
}

/* ── Color swatches ──────────────────────────────────────────────────────── */

function initColorSwatches() {
  const container = document.getElementById('color-swatches');
  container.innerHTML = '';
  COLORS.forEach(color => {
    const btn = document.createElement('button');
    btn.className = `color-swatch${color === selectedColor ? ' selected' : ''}`;
    btn.type = 'button';
    btn.style.background = color;
    btn.title = color;
    btn.addEventListener('click', () => {
      selectedColor = color;
      container.querySelectorAll('.color-swatch').forEach(b =>
        b.classList.toggle('selected', b === btn)
      );
    });
    container.appendChild(btn);
  });
}

/* ── Edit sheet ──────────────────────────────────────────────────────────── */

function openEditSheet(taskId) {
  editTaskId = taskId;
  editArchiveConfirm = false;
  clearTimeout(editArchiveTimer);

  const found = findTask(taskId);
  if (!found) return;
  const { task } = found;

  document.getElementById('edit-name').value = task.name;
  document.getElementById('edit-time').value = formatMs(computeMs(task));

  const archBtn = document.getElementById('edit-archive');
  archBtn.textContent = 'Archiver';
  archBtn.classList.remove('confirming');

  showOverlay('edit-overlay');
  setTimeout(() => document.getElementById('edit-name').focus(), 120);
}

function closeEditSheet() {
  editTaskId = null;
  editArchiveConfirm = false;
  clearTimeout(editArchiveTimer);
  hideOverlay('edit-overlay');
}

function confirmEdit() {
  if (!editTaskId) return;
  const name    = document.getElementById('edit-name').value.trim();
  const timeStr = document.getElementById('edit-time').value;
  const totalMs = parseTimeInput(timeStr);
  dispatch({ type: 'EDIT_TASK', taskId: editTaskId, name: name || undefined, totalMs });
  closeEditSheet();
}

function archiveTask() {
  if (!editTaskId) return;
  if (!editArchiveConfirm) {
    editArchiveConfirm = true;
    const btn = document.getElementById('edit-archive');
    btn.textContent = "Confirmer l'archivage";
    btn.classList.add('confirming');
    editArchiveTimer = setTimeout(() => {
      editArchiveConfirm = false;
      btn.textContent = 'Archiver';
      btn.classList.remove('confirming');
    }, 3000);
  } else {
    dispatch({ type: 'ARCHIVE_TASK', taskId: editTaskId });
    closeEditSheet();
  }
}

/* ── Overlay helpers ─────────────────────────────────────────────────────── */

function showOverlay(id) {
  const el = document.getElementById(id);
  el.classList.remove('hidden');
  el.offsetHeight; // force reflow so CSS transition plays
  el.classList.add('open');
}

function hideOverlay(id) {
  const el = document.getElementById(id);
  el.classList.remove('open');
  setTimeout(() => el.classList.add('hidden'), 280);
}

/* ── Event wiring ────────────────────────────────────────────────────────── */

function setupEvents() {
  /* Global pause */
  document.getElementById('btn-global-pause').addEventListener('click', () =>
    dispatch({ type: 'TOGGLE_GLOBAL_PAUSE' })
  );

  /* Stats / back toggle */
  document.getElementById('btn-stats').addEventListener('click', () => {
    currentView = currentView === 'tracker' ? 'stats' : 'tracker';
    structureDirty = true;
    render();
  });

  /* Add group */
  document.getElementById('btn-add-group').addEventListener('click', () => openModal('group'));

  /* Modal */
  document.getElementById('modal-cancel').addEventListener('click', closeModal);
  document.getElementById('modal-confirm').addEventListener('click', confirmModal);
  document.getElementById('modal-overlay').addEventListener('click', e => {
    if (e.target.id === 'modal-overlay') closeModal();
  });
  document.getElementById('modal-input').addEventListener('keydown', e => {
    if (e.key === 'Enter')  confirmModal();
    if (e.key === 'Escape') closeModal();
  });
  document.getElementById('modal-bulk').addEventListener('keydown', e => {
    if (e.key === 'Escape') closeModal();
    // Ctrl+Enter confirms in bulk mode
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) confirmModal();
  });

  /* Bulk toggle */
  document.getElementById('btn-toggle-bulk').addEventListener('click', () => {
    bulkMode = !bulkMode;
    const input  = document.getElementById('modal-input');
    const bulk   = document.getElementById('modal-bulk');
    const toggle = document.getElementById('btn-toggle-bulk');
    if (bulkMode) {
      input.classList.add('hidden');
      bulk.classList.remove('hidden');
      toggle.textContent = '← Une seule tâche';
      bulk.focus();
    } else {
      input.classList.remove('hidden');
      bulk.classList.add('hidden');
      toggle.textContent = 'Ajouter plusieurs tâches à la fois →';
      input.focus();
    }
  });

  /* Edit sheet */
  document.getElementById('edit-cancel').addEventListener('click', closeEditSheet);
  document.getElementById('edit-confirm').addEventListener('click', confirmEdit);
  document.getElementById('edit-archive').addEventListener('click', archiveTask);
  document.getElementById('edit-overlay').addEventListener('click', e => {
    if (e.target.id === 'edit-overlay') closeEditSheet();
  });
  document.getElementById('edit-name').addEventListener('keydown', e => {
    if (e.key === 'Enter')  confirmEdit();
    if (e.key === 'Escape') closeEditSheet();
  });
  document.getElementById('edit-time').addEventListener('keydown', e => {
    if (e.key === 'Enter')  confirmEdit();
    if (e.key === 'Escape') closeEditSheet();
  });

  /* Page Visibility API — correct timer after phone lock/background */
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      structureDirty = true;
      render();
    }
  });
}

/* ── Tick loop ───────────────────────────────────────────────────────────── */

function startTickLoop() {
  setInterval(() => dispatch({ type: 'TICK' }), 1000);
}

/* ── Service worker registration ─────────────────────────────────────────── */

function registerSW() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(err =>
      console.warn('SW registration failed:', err)
    );
  }
}

/* ── Boot ────────────────────────────────────────────────────────────────── */

function boot() {
  loadState();
  setupEvents();
  structureDirty = true;
  render();
  startTickLoop();
  registerSW();
}

boot();
