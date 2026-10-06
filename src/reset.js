/**
 * Reset de la base de datos de desarrollo: borra server/fiesta.db* y los
 * soportes subidos, y vuelve a sembrar desde cero.
 *
 *   cd server && npm run reset   (o desde la raíz: npm run reset)
 *
 * Seguridad: solo toca las rutas de desarrollo dentro de server/
 * (server/fiesta.db* y server/uploads). Ignora FIESTA_DB_PATH y
 * FIESTA_UPLOADS_DIR para no borrar nunca una BD de pruebas temporal.
 */
const path = require('path');
const fs = require('fs');

const SERVER_DIR = path.join(__dirname, '..');
const DB_FILES = ['fiesta.db', 'fiesta.db-shm', 'fiesta.db-wal', 'fiesta.db-journal'].map((f) =>
  path.join(SERVER_DIR, f)
);
const UPLOADS_DIR = path.join(SERVER_DIR, 'uploads');

function borrarSiExiste(ruta) {
  try {
    if (fs.existsSync(ruta)) {
      fs.rmSync(ruta, { force: true });
      console.log(`🗑️  Borrado: ${path.basename(ruta)}`);
    }
  } catch (e) {
    console.error(`⚠️  No se pudo borrar ${ruta}: ${e.message}`);
    process.exitCode = 1;
  }
}

function limpiarSubidas() {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  for (const archivo of fs.readdirSync(UPLOADS_DIR)) {
    if (archivo === '.gitkeep') continue;
    borrarSiExiste(path.join(UPLOADS_DIR, archivo));
  }
  // El .gitkeep mantiene la carpeta versionada aunque quede vacía.
  const gitkeep = path.join(UPLOADS_DIR, '.gitkeep');
  if (!fs.existsSync(gitkeep)) fs.writeFileSync(gitkeep, '');
}

function main() {
  console.log('🔄 Reset de la base de datos de desarrollo…');
  DB_FILES.forEach(borrarSiExiste);
  limpiarSubidas();

  // Se requiere DESPUÉS de borrar: db.js crea fiesta.db + schema al cargarse.
  const { seed } = require('./seed');
  const sembro = seed();
  console.log(sembro ? '✅ Base de datos reiniciada desde cero.' : 'ℹ️  La base ya tenía usuarios, no se sembró de nuevo.');
}

if (require.main === module) main();

module.exports = { main };
