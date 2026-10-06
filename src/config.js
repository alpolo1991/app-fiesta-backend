/**
 * Configuración central por entorno (desarrollo / producción).
 *
 * - Desarrollo (local):  NODE_ENV=development → logs detallados, muestra
 *   URL local, ruta de SQLite, uploads y CORS.
 * - Producción (Render): NODE_ENV=production → logs mínimos, sin rutas
 *   internas ni secretos. /api/salud responde solo { ok: true }.
 * - Pruebas (npm test): NODE_ENV=test → silencioso, BD temporal.
 *
 * Fase 2 (DB en la nube): toda la elección de base de datos pasa por aquí.
 * Hoy se usa SQLite vía FIESTA_DB_PATH; cuando exista DATABASE_URL (ej.
 * Postgres/Turso) este será el único archivo a cambiar.
 */
const path = require('path');

const NODE_ENV = process.env.NODE_ENV || 'development';
const isProd = NODE_ENV === 'production';
const isTest = NODE_ENV === 'test';
const isDev = !isProd && !isTest;

const PORT = Number(process.env.PORT || 4000);

const ORIGENES = (process.env.FRONTEND_URL || 'http://localhost:5173')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

// --- Persistencia (fase 2: aquí se elegirá SQLite local vs DB nube) ---
// Hoy: SQLite en archivo. Futuro: si hay DATABASE_URL se usará esa.
const DB_PATH =
  process.env.FIESTA_DB_PATH || path.join(__dirname, '..', 'fiesta.db');
const DATABASE_URL = process.env.DATABASE_URL || null; // reservado fase 2
const UPLOAD_DIR =
  process.env.FIESTA_UPLOADS_DIR || path.join(__dirname, '..', 'uploads');

const NUBE =
  process.env.CLOUDINARY_ENABLED !== '0' &&
  !!process.env.CLOUDINARY_CLOUD_NAME &&
  !!process.env.CLOUDINARY_API_KEY &&
  !!process.env.CLOUDINARY_API_SECRET;

// URL pública para mostrar en logs (sin secretos).
const URL_PUBLICA = isProd
  ? 'https://tu-api.onrender.com' // Render la sirve en su dominio
  : `http://localhost:${PORT}`;

module.exports = {
  NODE_ENV,
  isDev,
  isProd,
  isTest,
  PORT,
  ORIGENES,
  DB_PATH,
  DATABASE_URL,
  UPLOAD_DIR,
  NUBE,
  URL_PUBLICA,
};
