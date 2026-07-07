const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const AdmZip = require('adm-zip');

const app = express();
const PORT = process.env.PORT || 4000;

const DATA_FILE = path.join(__dirname, 'data', 'instances.json');
const UPLOADS_DIR = path.join(__dirname, 'uploads');

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

function parseMrpack(buffer) {
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

  return { version, loader, mods };
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
    const baseUrl = `${req.protocol}://${req.get('host')}`;

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
        const parsed = parseMrpack(fs.readFileSync(mrpackFile.path));
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
      id: randomUUID(),
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
  res.json({ success: true });
});

app.listen(PORT, () => {
  console.log(`Panel de Eufonia corriendo en http://localhost:${PORT}`);
});
