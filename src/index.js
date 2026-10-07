/**
 * ============================================================
 *  FIESTA FIN DE AÑO 2026 - API (Express + better-sqlite3)
 * ============================================================
 *  Arranque:  npm run dev   /   npm start
 *  Variables de entorno (.env): NODE_ENV (development|production),
 *  JWT_SECRET, PORT, FRONTEND_URL (lista con comas), FIESTA_DB_PATH,
 *  FIESTA_UPLOADS_DIR, CLOUDINARY_* (ver .env.example)
 * ============================================================
 */
require('dotenv').config();

const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');

const config = require('./config');
const db = require('./db'); // inicializa SQLite (efecto lateral)
const { seed } = require('./seed');

// ---------- Rutas ----------
const authRoutes = require('./routes/auth');
const recuperacionesRoutes = require('./routes/recuperaciones');
const usuariosRoutes = require('./routes/usuarios');
const cuentasPagoRoutes = require('./routes/cuentasPago');
const soportesPagoRoutes = require('./routes/soportesPago');
const configuracionRoutes = require('./routes/configuracion');
const dashboardRoutes = require('./routes/dashboard');
const cajasRoutes = require('./routes/cajas');
const preguntasRoutes = require('./routes/preguntas');
const encuestaRoutes = require('./routes/encuesta');
const acompanantesRoutes = require('./routes/acompanantes');
const inventarioRoutes = require('./routes/inventario');
const entregasRoutes = require('./routes/entregas');

const app = express();
const PORT = config.PORT;

// Detrás de Render/Vercel hay un proxy: se confía en el primero para que
// req.ip sea la IP real (clave para el rate-limit).
app.set('trust proxy', 1);

// ---------- Seguridad / parsing ----------
// CORS restringido a los frontends (lista separada por comas en FRONTEND_URL)
const ORIGENES = config.ORIGENES;
app.use(
  cors({
    origin: ORIGENES.length === 1 ? ORIGENES[0] : ORIGENES,
    credentials: true,
  })
);
app.use(express.json({ limit: '1mb' }));

// Carpeta de subidas en disco (solo modo local; en nube ver src/storage.js)
if (!config.NUBE) fs.mkdirSync(config.UPLOAD_DIR, { recursive: true });

// ---------- Seed automático al primer arranque ----------
// Solo siembra con la BD vacía (seed.js verifica `usuarios`); si ya hay
// datos no toca nada.
try {
  const sembro = seed();
  if (!sembro) {
    const n = db.prepare('SELECT COUNT(*) AS n FROM usuarios').get().n;
    console.log(`ℹ️  Seed omitido: ya hay ${n} usuario(s), datos intactos.`);
  }
} catch (e) {
  console.error('Error en el seed:', e.message);
}

// Aviso solo en desarrollo: sin JWT_SECRET se usa un valor inseguro.
if (config.isDev && !process.env.JWT_SECRET) {
  console.warn('⚠️  Sin JWT_SECRET en .env: usando valor de desarrollo (no usar en producción).');
}

// Producción exige Cloudinary: sin claves, fallar visible en vez de
// guardar en disco efímero.
if (config.isProd && !config.NUBE) {
  console.error('❌ Producción sin Cloudinary: faltan CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET en Render.');
  process.exit(1);
}

// Producción exige Turso: sin URL/token, fallar visible en vez de usar
// SQLite efímero (se perderían los datos al reiniciar).
if (config.isProd && !config.USA_TURSO) {
  console.error('❌ Producción sin Turso: faltan TURSO_DATABASE_URL / TURSO_AUTH_TOKEN en Render.');
  process.exit(1);
}

// ---------- Endpoints ----------
// En producción responde mínimo (sin detalles internos); en desarrollo
// muestra entorno y rutas útiles para depurar.
app.get('/api/salud', (req, res) => {
  if (config.isProd) return res.json({ ok: true, servicio: 'fiesta-api' });
  res.json({
    ok: true,
    servicio: 'fiesta-api',
    env: config.NODE_ENV,
    url: config.URL_PUBLICA,
    db: config.DB_BACKEND === 'turso' ? 'turso (nube)' : config.DB_PATH,
    uploads: config.NUBE ? 'cloudinary' : config.UPLOAD_DIR,
    frontend: config.ORIGENES,
  });
});

app.use('/api/auth', authRoutes);
app.use('/api/recuperaciones', recuperacionesRoutes);
app.use('/api/usuarios', usuariosRoutes);
app.use('/api/cuentas-pago', cuentasPagoRoutes);
app.use('/api/soportes-pago', soportesPagoRoutes);
app.use('/api/configuracion', configuracionRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/cajas', cajasRoutes);
app.use('/api/preguntas', preguntasRoutes);
app.use('/api/opciones', preguntasRoutes.opciones);
app.use('/api/encuesta', encuestaRoutes);
app.use('/api/acompanantes', acompanantesRoutes);
app.use('/api/inventario', inventarioRoutes);
app.use('/api/entregas', entregasRoutes);

// ---------- Sirve el build del frontend (producción) ----------
const clienteDist = path.join(__dirname, '..', '..', 'client', 'dist');
if (fs.existsSync(clienteDist)) {
  app.use(express.static(clienteDist));
  // Cualquier ruta que no sea /api se resuelve con el index.html (React Router)
  app.get(/^\/(?!api).*/, (req, res) => res.sendFile(path.join(clienteDist, 'index.html')));
}

// ---------- 404 para la API ----------
app.use('/api', (req, res) => {
  res.status(404).json({ mensaje: `Ruta no encontrada: ${req.method} ${req.originalUrl}` });
});

// ---------- Manejador de errores centralizado ----------
app.use((err, req, res, next) => {
  console.error('[ERROR]', err.message);
  if (res.headersSent) return next(err);
  const status = err.status || 500;
  // En producción no se filtran detalles internos en errores 500.
  const mensaje = status >= 500 && config.isProd ? 'Error interno del servidor.' : err.message || 'Error interno del servidor.';
  const cuerpo = { mensaje };
  if (config.isDev) cuerpo.stack = err.stack;
  res.status(status).json(cuerpo);
});

app.listen(PORT, () => {
  if (config.isProd) {
    console.log('✅ API en producción lista (Turso + Cloudinary)');
    console.log(`   Salud: /api/salud`);
    return;
  }
  if (config.isTest) {
    console.log(`[test] API en puerto ${PORT}`);
    return;
  }
  console.log(`🚀 API (development) en ${config.URL_PUBLICA}`);
  console.log(`   Base de datos: ${config.DB_BACKEND === 'turso' ? 'turso (nube)' : `${config.DB_PATH} (SQLite local)`}`);
  console.log(`   Subidas:       ${config.NUBE ? 'Cloudinary (nube)' : config.UPLOAD_DIR}`);
  console.log(`   Frontend CORS: ${config.ORIGENES.join(', ')}`);
});
