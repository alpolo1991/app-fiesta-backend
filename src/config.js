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
// dotenv aquí (idempotente): garantiza .env en todos los entrypoints
// (index, seed, reset), no solo cuando index.js lo carga primero.
require('dotenv').config();
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

// --- Persistencia: SQLite local (dev/test) vs Turso (prod) ---
// Hoy: SQLite en archivo. Nube: Turso vía driver `libsql` (API sync
// compatible con better-sqlite3, ver src/db.js).
const DB_PATH =
  process.env.FIESTA_DB_PATH || path.join(__dirname, '..', 'fiesta.db');
const TURSO_DATABASE_URL = process.env.TURSO_DATABASE_URL || null;
const TURSO_AUTH_TOKEN = process.env.TURSO_AUTH_TOKEN || null;
// Estricto por entorno, igual que imágenes: dev/test SIEMPRE SQLite local
// aunque haya vars Turso; solo producción usa Turso (y lo exige).
const USA_TURSO = isProd && !!TURSO_DATABASE_URL && !!TURSO_AUTH_TOKEN;
const DB_BACKEND = USA_TURSO ? 'turso' : 'sqlite';
const UPLOAD_DIR =
  process.env.FIESTA_UPLOADS_DIR || path.join(__dirname, '..', 'uploads');

const NUBE =
  // Estricto por entorno: dev/test SIEMPRE en disco aunque haya claves
  // en .env; solo producción usa Cloudinary (y lo exige, ver index.js).
  isProd &&
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
  TURSO_DATABASE_URL,
  TURSO_AUTH_TOKEN,
  USA_TURSO,
  DB_BACKEND,
  UPLOAD_DIR,
  NUBE,
  URL_PUBLICA,
};
