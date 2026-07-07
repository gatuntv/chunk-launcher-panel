const form = document.getElementById('instanceForm');
const grid = document.getElementById('instanceGrid');
const mrpackInput = document.getElementById('mrpackInput');
const versionInput = document.getElementById('versionInput');
const loaderInput = document.getElementById('loaderInput');

// Si eligen un .mrpack, la versión y el loader los completa el servidor
// leyendo el archivo — dejamos los campos deshabilitados para que no
// confunda escribir algo ahí que de todos modos se va a ignorar.
mrpackInput.addEventListener('change', () => {
  const hasMrpack = mrpackInput.files.length > 0;
  versionInput.disabled = hasMrpack;
  loaderInput.disabled = hasMrpack;
  versionInput.required = !hasMrpack;
  if (hasMrpack) {
    versionInput.placeholder = 'Se completa desde el .mrpack';
  } else {
    versionInput.placeholder = '1.21.1';
  }
});

async function loadInstances() {
  const res = await fetch('/api/admin/instances');
  const instances = await res.json();
  grid.innerHTML = '';

  instances.forEach(inst => {
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
          <span>${inst.mods.length} mods</span>
        </div>
        <button class="delete-btn" data-id="${inst.id}">Eliminar</button>
      </div>
    `;
    grid.appendChild(card);
  });

  grid.querySelectorAll('.delete-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      await fetch(`/api/admin/instances/${btn.dataset.id}`, { method: 'DELETE' });
      loadInstances();
    });
  });
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const formData = new FormData(form);
  await fetch('/api/admin/instances', { method: 'POST', body: formData });
  form.reset();
  loadInstances();
});

loadInstances();
