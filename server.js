const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const AdmZip = require('adm-zip');

const app = express();
const PORT = process.env.PORT || 4000;

// Railway (y la mayoría de PaaS) hacen proxy hacia la app por HTTP interno,
// aunque el usuario final entre por https://. Sin esto, req.protocol siempre
// da 'http', y las URLs de iconUrl/backgroundUrl/mods que arma este server
// salen como http:// — el launcher las bloquea por CSP porque solo permite
// https para el dominio de Railway.
app.set('trust proxy', 1);

// Cinturón y tirantes: si por lo que sea 'trust proxy' no alcanza a corregir
// req.protocol (ej. quedó un deploy viejo corriendo, o Railway cambia cómo
// proxea), esto fuerza la URL pública correcta sin depender de eso.
// Configurable por variable de entorno en Railway (Settings → Variables);
// si no se define, cae en el dominio público del panel.
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || 'https://chunk-launcher-panel-production.up.railway.app').replace(/\/$/, '');

function getBaseUrl(req) {
  // En local (sin dominio público configurado ni proxy) seguimos respetando
  // el host real, para no romper el desarrollo con localhost:4000.
  const host = req.get('host') || '';
  if (host.startsWith('localhost') || host.startsWith('127.0.0.1')) {
    return `${req.protocol}://${host}`;
  }
  return PUBLIC_BASE_URL;
}

const DATA_FILE = path.join(__dirname, 'data', 'instances.json');
// OJO: antes esto apuntaba a /app/uploads, pero Railway solo permite UN
// volumen por servicio — el que ya montamos en /app/data. Así que las
// subidas (íconos, fondos, mods) ahora viven adentro de esa misma carpeta
// persistida, en vez de necesitar un segundo volumen aparte.
const UPLOADS_DIR = path.join(__dirname, 'data', 'uploads');

// --- setup inicial de carpetas/archivos ---
['icons', 'backgrounds', 'instances', 'mods'].forEach(d =>
  fs.mkdirSync(path.join(UPLOADS_DIR, d), { recursive: true })
);
if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, '[]');

function readInstances() {
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
}
function writeInstances(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// Un .mrpack es en realidad un .zip con un "modrinth.index.json" adentro que
// lista la versión de Minecraft, el loader (fabric/forge/quilt) y cada mod
// como una URL externa (al CDN de Modrinth), no como un archivo incluido.
// Así que no hace falta re-subir los .jar: solo leemos el índice y usamos
// esas URLs directo, el launcher las descarga igual que cualquier otro mod.
// Un .mrpack puede traer más que mods: shaderpacks, configs, resourcepacks,
// el mundo/saves, etc, cada uno con su propia carpeta dentro del "path" que
// trae el índice (ej "mods/foo.jar", "config/bar.json", "shaderpacks/baz.zip").
// Pedido: traer todo EXCEPTO el mundo (saves/) y los resourcepacks — el resto
// se incluye tal cual, respetando su carpeta real (antes todo se aplastaba
// como si fuera un mod y se tiraba en mods/, incluso lo que no lo era).
const EXCLUDED_PATH_PREFIXES = ['saves/', 'resourcepacks/'];

function parseMrpack(buffer, instanceId, baseUrl) {
  const zip = new AdmZip(buffer);
  const entry = zip.getEntry('modrinth.index.json');
  if (!entry) throw new Error('El archivo .mrpack no tiene un modrinth.index.json válido');

  const index = JSON.parse(zip.readAsText(entry));
  const deps = index.dependencies || {};

  const version = deps.minecraft;
  let loader = 'vanilla';
  if (deps['fabric-loader']) loader = 'fabric';
  else if (deps['forge']) loader = 'forge';
  else if (deps['quilt-loader']) loader = 'quilt';
  else if (deps['neoforge']) loader = 'forge'; // no soportado del todo aún, ver README

  const mods = (index.files || [])
    .filter(f => f.downloads?.length) // nos saltamos archivos sin URL de descarga
    .filter(f => f.env?.client !== 'unsupported') // no bajamos cosas que el cliente ni usa (server-only)
    .filter(f => {
      const normalized = f.path.replace(/\\/g, '/').toLowerCase();
      return !EXCLUDED_PATH_PREFIXES.some(prefix => normalized.startsWith(prefix));
    })
    .map(f => ({
      fileName: path.basename(f.path),
      url: f.downloads[0],
      // Ruta relativa dentro de la instancia (ej "mods/foo.jar", "shaderpacks/baz.zip").
      // Si el pack no trae carpeta (raro, pero por las dudas), lo mandamos a mods/.
      path: f.path.replace(/\\/g, '/').includes('/') ? f.path.replace(/\\/g, '/') : `mods/${f.path}`
    }));

  // El índice (index.files) solo lista lo que Modrinth aloja en su propio CDN.
  // Mods propios o privados (los tuyos, que no están subidos a Modrinth) y
  // configs no van ahí — Modrinth los empaqueta tal cual, como archivos
  // reales, dentro de las carpetas overrides/ (para todos) y
  // client-overrides/ (solo cliente, pisa lo de overrides/ si hay el mismo
  // archivo en las dos). Antes esto se ignoraba del todo: cualquier mod
  // tuyo que no fuera de Modrinth desaparecía en silencio al importar el pack.
  const bundled = new Map(); // ruta relativa -> entrada del zip

  // Algunas herramientas arman el .mrpack con los mods/config sueltos al
  // mismo nivel que modrinth.index.json (ej. "mods/foo.jar" directo, sin
  // "overrides/" adelante), en vez de seguir la convención formal. Los
  // tomamos como prioridad más baja: si el mismo archivo también aparece
  // dentro de overrides/ o client-overrides/, esas carpetas ganan.
  zip.getEntries().forEach((e) => {
    if (e.isDirectory) return;
    const normalized = e.entryName.replace(/\\/g, '/');
    if (normalized === 'modrinth.index.json') return;
    if (normalized.startsWith('overrides/') || normalized.startsWith('client-overrides/') || normalized.startsWith('server-overrides/')) return;
    const lower = normalized.toLowerCase();
    if (EXCLUDED_PATH_PREFIXES.some(p => lower.startsWith(p))) return;
    bundled.set(normalized, e);
  });

  const collectOverrides = (prefix) => {
    zip.getEntries().forEach((e) => {
      if (e.isDirectory) return;
      const normalized = e.entryName.replace(/\\/g, '/');
      if (!normalized.startsWith(prefix)) return;
      const relative = normalized.slice(prefix.length);
      if (!relative) return;
      const lower = relative.toLowerCase();
      if (EXCLUDED_PATH_PREFIXES.some(p => lower.startsWith(p))) return;
      bundled.set(relative, e);
    });
  };
  collectOverrides('overrides/');
  collectOverrides('client-overrides/'); // se procesa después, así pisa a overrides/ si coinciden

  const instanceFilesDir = path.join(UPLOADS_DIR, 'instances', instanceId);
  const bundledMods = [];
  for (const [relative, zipEntry] of bundled) {
    const dest = path.join(instanceFilesDir, relative);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, zipEntry.getData());
    bundledMods.push({
      fileName: path.basename(relative),
      url: `${baseUrl}/uploads/instances/${instanceId}/${relative}`,
      path: relative
    });
  }

  return { version, loader, mods: [...mods, ...bundledMods] };
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS_DIR));

// --- almacenamiento de archivos subidos ---
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const map = { icon: 'icons', background: 'backgrounds', mods: 'mods' };
    cb(null, path.join(UPLOADS_DIR, map[file.fieldname] || 'instances'));
  },
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`)
});
const upload = multer({ storage });

// ---------------------------------------------------------------------
// API que consume el LAUNCHER (lista pública de instancias)
// ---------------------------------------------------------------------
app.get('/api/instances', (req, res) => {
  res.json(readInstances());
});

// ---------------------------------------------------------------------
// API del PANEL (crear / editar / borrar instancias)
// ---------------------------------------------------------------------
app.get('/api/admin/instances', (req, res) => res.json(readInstances()));

app.post(
  '/api/admin/instances',
  upload.fields([
    { name: 'icon', maxCount: 1 },
    { name: 'background', maxCount: 1 },
    { name: 'mods', maxCount: 50 },
    { name: 'mrpack', maxCount: 1 }
  ]),
  (req, res) => {
    const { name, description, tag } = req.body;
    let { version, loader } = req.body;
    const baseUrl = getBaseUrl(req);
    const instanceId = randomUUID();

    const icon = req.files.icon?.[0];
    const background = req.files.background?.[0];
    const modFiles = req.files.mods || [];
    const mrpackFile = req.files.mrpack?.[0];

    let mods = modFiles.map(f => ({
      fileName: f.originalname,
      url: `${baseUrl}/uploads/mods/${f.filename}`,
      path: `mods/${f.originalname}`
    }));

    // Si subieron un .mrpack, pisa versión/loader/mods con lo que venga adentro
    // (así no hay que tipear nada a mano ni subir cada .jar por separado).
    if (mrpackFile) {
      try {
        const parsed = parseMrpack(fs.readFileSync(mrpackFile.path), instanceId, baseUrl);
        version = parsed.version || version;
        loader = parsed.loader || loader;
        mods = [...mods, ...parsed.mods];
      } catch (err) {
        return res.status(400).json({ success: false, error: `Error leyendo el .mrpack: ${err.message}` });
      } finally {
        fs.unlinkSync(mrpackFile.path); // no necesitamos guardar el .mrpack en sí, ya extrajimos lo que sirve
      }
    }

    if (!version || !loader) {
      return res.status(400).json({ success: false, error: 'Falta versión o loader (o subí un .mrpack que los traiga)' });
    }

    const instance = {
      id: instanceId,
      name,
      description,
      tag: tag || 'SERVIDOR PÚBLICO',
      titleHtml: name,
      version,
      loader, // 'vanilla' | 'forge' | 'fabric' | 'quilt'
      iconUrl: icon ? `${baseUrl}/uploads/icons/${icon.filename}` : null,
      backgroundUrl: background ? `${baseUrl}/uploads/backgrounds/${background.filename}` : null,
      mods,
      createdAt: new Date().toISOString()
    };

    const instances = readInstances();
    instances.push(instance);
    writeInstances(instances);

    res.json({ success: true, instance });
  }
);

app.delete('/api/admin/instances/:id', (req, res) => {
  const instances = readInstances().filter(i => i.id !== req.params.id);
  writeInstances(instances);

  const instanceFilesDir = path.join(UPLOADS_DIR, 'instances', req.params.id);
  fs.rm(instanceFilesDir, { recursive: true, force: true }, () => {});

  res.json({ success: true });
});

app.listen(PORT, () => {
  console.log(`Panel de Eufonia corriendo en http://localhost:${PORT}`);
});
