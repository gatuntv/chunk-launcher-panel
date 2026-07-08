const form = document.getElementById('instanceForm');
const grid = document.getElementById('instanceGrid');
const mrpackInput = document.getElementById('mrpackInput');
const versionInput = document.getElementById('versionInput');
const loaderInput = document.getElementById('loaderInput');
const instanceIdInput = document.getElementById('instanceIdInput');
const formTitle = document.getElementById('formTitle');
const submitInstanceBtn = document.getElementById('submitInstanceBtn');
const cancelEditBtn = document.getElementById('cancelEditBtn');
const keepModsWrap = document.getElementById('keepModsWrap');
const keepModsInput = document.getElementById('keepModsInput');
const iconInput = form.querySelector('input[name="icon"]');
const memoryMinInput = document.getElementById('memoryMinInput');
const memoryMaxInput = document.getElementById('memoryMaxInput');

let currentInstances = [];

// Si eligen un .mrpack, la versión y el loader los completa el servidor
// leyendo el archivo — dejamos los campos deshabilitados para que no
// confunda escribir algo ahí que de todos modos se va a ignorar.
mrpackInput.addEventListener('change', () => {
  const hasMrpack = mrpackInput.files.length > 0;
  versionInput.disabled = hasMrpack;
  loaderInput.disabled = hasMrpack;
  versionInput.required = !hasMrpack && !instanceIdInput.value;
  if (hasMrpack) {
    versionInput.placeholder = 'Se completa desde el .mrpack';
  } else {
    versionInput.placeholder = '1.21.1';
  }
});

function enterEditMode(inst) {
  instanceIdInput.value = inst.id;
  formTitle.textContent = `Editando: ${inst.name}`;
  submitInstanceBtn.textContent = 'Guardar cambios';
  cancelEditBtn.hidden = false;
  keepModsWrap.hidden = false;

  form.name.value = inst.name || '';
  form.description.value = inst.description || '';
  form.tag.value = inst.tag || '';
  versionInput.value = inst.version || '';
  loaderInput.value = inst.loader || 'vanilla';
  memoryMinInput.value = inst.memoryMin || '';
  memoryMaxInput.value = inst.memoryMax || '';

  // Editar no obliga a resubir ícono ni versión (ya existen en la instancia).
  iconInput.required = false;
  versionInput.required = false;

  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function exitEditMode() {
  instanceIdInput.value = '';
  formTitle.textContent = 'Nueva instancia';
  submitInstanceBtn.textContent = 'Publicar instancia';
  cancelEditBtn.hidden = true;
  keepModsWrap.hidden = true;
  keepModsInput.checked = true;
  iconInput.required = true;
  versionInput.required = !mrpackInput.files.length;
  form.reset();
  versionInput.disabled = false;
  loaderInput.disabled = false;
}

cancelEditBtn.addEventListener('click', exitEditMode);

async function loadInstances() {
  const res = await fetch('/api/admin/instances');
  const instances = await res.json();
  currentInstances = instances;
  grid.innerHTML = '';

  instances.forEach(inst => {
    const realMods = inst.mods.filter(m => (m.path || '').startsWith('mods/'));
    const extraFiles = inst.mods.length - realMods.length;
    const filesLabel = extraFiles > 0
      ? `${realMods.length} mods · ${extraFiles} archivos extra`
      : `${realMods.length} mods`;

    const card = document.createElement('div');
    card.className = 'instance-card';
    card.innerHTML = `
      <img class="thumb" src="${inst.backgroundUrl || inst.iconUrl || ''}" alt="${inst.name}" />
      <div class="body">
        <h3>${inst.name}</h3>
        <p>${inst.description || ''}</p>
        <div class="meta">
          <span>${inst.version}</span>
          <span>${inst.loader}</span>
          <span>${filesLabel}</span>
          <span>RAM ${inst.memoryMin || '2G'}–${inst.memoryMax || '4G'}</span>
        </div>
        <div class="actions-row">
          <button class="edit-btn" data-id="${inst.id}">Editar</button>
          <button class="delete-btn" data-id="${inst.id}">Eliminar</button>
        </div>
      </div>
    `;
    grid.appendChild(card);
  });

  grid.querySelectorAll('.delete-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      await fetch(`/api/admin/instances/${btn.dataset.id}`, { method: 'DELETE' });
      if (instanceIdInput.value === btn.dataset.id) exitEditMode();
      loadInstances();
    });
  });

  grid.querySelectorAll('.edit-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const inst = currentInstances.find(i => i.id === btn.dataset.id);
      if (inst) enterEditMode(inst);
    });
  });
}

const submitBtn = form.querySelector('button[type="submit"]');
const formError = document.createElement('p');
formError.className = 'form-error';
formError.hidden = true;
form.appendChild(formError);

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  formError.hidden = true;
  const isEditing = !!instanceIdInput.value;
  submitBtn.disabled = true;
  submitBtn.textContent = isEditing ? 'Guardando…' : 'Publicando…';

  try {
    const formData = new FormData(form);
    formData.set('keepMods', keepModsInput.checked ? 'true' : 'false');

    const url = isEditing ? `/api/admin/instances/${instanceIdInput.value}` : '/api/admin/instances';
    const method = isEditing ? 'PUT' : 'POST';
    const res = await fetch(url, { method, body: formData });
    const data = await res.json().catch(() => ({}));

    if (!res.ok || !data.success) {
      throw new Error(data.error || `El servidor respondió ${res.status}`);
    }

    exitEditMode();
    loadInstances();
  } catch (err) {
    formError.textContent = `No se pudo ${isEditing ? 'guardar' : 'publicar'}: ${err.message}`;
    formError.hidden = false;
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = isEditing ? 'Guardar cambios' : 'Publicar instancia';
  }
});

// ---------------------------------------------------------------------
// JUGADORES Y BANEOS POR IP
// ---------------------------------------------------------------------
const playersTableWrap = document.getElementById('playersTableWrap');
const banOverlay = document.getElementById('banOverlay');
const banModalTitle = document.getElementById('banModalTitle');
const banReasonInput = document.getElementById('banReasonInput');
const banDaysInput = document.getElementById('banDaysInput');
const banCancelBtn = document.getElementById('banCancelBtn');
const banAcceptBtn = document.getElementById('banAcceptBtn');

let pendingBanIp = null;

function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString();
}

function openBanModal(ip) {
  pendingBanIp = ip;
  banModalTitle.textContent = `Banear IP ${ip}`;
  banReasonInput.value = '';
  banDaysInput.value = '';
  banOverlay.hidden = false;
  banReasonInput.focus();
}

function closeBanModal() {
  banOverlay.hidden = true;
  pendingBanIp = null;
}

banCancelBtn.addEventListener('click', closeBanModal);
banOverlay.addEventListener('click', (e) => { if (e.target === banOverlay) closeBanModal(); });

banAcceptBtn.addEventListener('click', async () => {
  if (!pendingBanIp) return;
  banAcceptBtn.disabled = true;
  try {
    await fetch('/api/admin/bans', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ip: pendingBanIp,
        days: banDaysInput.value ? Number(banDaysInput.value) : 0,
        reason: banReasonInput.value.trim()
      })
    });
    closeBanModal();
    loadPlayers();
  } finally {
    banAcceptBtn.disabled = false;
  }
});

async function unbanIp(ip) {
  await fetch(`/api/admin/bans/${encodeURIComponent(ip)}`, { method: 'DELETE' });
  loadPlayers();
}

async function loadPlayers() {
  const res = await fetch('/api/admin/players');
  const players = await res.json();

  if (!players.length) {
    playersTableWrap.innerHTML = '<p class="empty-hint">Todavía no entró nadie al launcher.</p>';
    return;
  }

  const rows = players.map(p => {
    const usernamesHtml = p.usernames.map(u =>
      `<span class="username-pill">${u.username}<span class="type-tag">${u.type === 'microsoft' ? 'MS' : u.type === 'cracked' ? 'cracked' : ''}</span></span>`
    ).join('');

    const statusHtml = p.banned
      ? `<span class="status-pill banned">Baneado</span>
         <div class="ban-reason">${p.banReason || ''}${p.banExpiresAt ? ` · hasta ${formatDate(p.banExpiresAt)}` : ' · permanente'}</div>`
      : `<span class="status-pill ok">Activo</span>`;

    const actionHtml = p.banned
      ? `<button class="unban-btn" data-ip="${p.ip}">Desbanear</button>`
      : `<button class="ban-btn" data-ip="${p.ip}">Banear</button>`;

    return `
      <tr>
        <td>${usernamesHtml}</td>
        <td class="ip-cell">${p.ip}</td>
        <td>${formatDate(p.lastSeen)}</td>
        <td>${statusHtml}</td>
        <td class="player-actions">${actionHtml}</td>
      </tr>
    `;
  }).join('');

  playersTableWrap.innerHTML = `
    <table class="players-table">
      <thead>
        <tr>
          <th>Usuario(s)</th>
          <th>IP</th>
          <th>Última conexión</th>
          <th>Estado</th>
          <th></th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;

  playersTableWrap.querySelectorAll('.ban-btn').forEach(btn =>
    btn.addEventListener('click', () => openBanModal(btn.dataset.ip))
  );
  playersTableWrap.querySelectorAll('.unban-btn').forEach(btn =>
    btn.addEventListener('click', () => unbanIp(btn.dataset.ip))
  );
}

loadInstances();
loadPlayers();
setInterval(loadPlayers, 15000);
