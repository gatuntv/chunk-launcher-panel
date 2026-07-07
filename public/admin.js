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

const submitBtn = form.querySelector('button[type="submit"]');
const formError = document.createElement('p');
formError.className = 'form-error';
formError.hidden = true;
form.appendChild(formError);

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  formError.hidden = true;
  submitBtn.disabled = true;
  submitBtn.textContent = 'Publicando…';

  try {
    const formData = new FormData(form);
    const res = await fetch('/api/admin/instances', { method: 'POST', body: formData });
    const data = await res.json().catch(() => ({}));

    // Antes esto no chequeaba res.ok: si el servidor rechazaba la instancia
    // (ej. faltaba versión/loader), el form igual se reseteaba como si se
    // hubiera publicado, y el error quedaba invisible para quien lo subía.
    if (!res.ok || !data.success) {
      throw new Error(data.error || `El servidor respondió ${res.status}`);
    }

    form.reset();
    // Al hacer reset, el listener de mrpackInput no se dispara solo,
    // así que reponemos manualmente el estado de versión/loader.
    versionInput.disabled = false;
    loaderInput.disabled = false;
    versionInput.required = true;
    loadInstances();
  } catch (err) {
    formError.textContent = `No se pudo publicar: ${err.message}`;
    formError.hidden = false;
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Publicar instancia';
  }
});

loadInstances();
