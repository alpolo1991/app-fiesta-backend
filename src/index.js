/**
 * ============================================================
 *  FIESTA FIN DE AÑO 2026 - API (Express + better-sqlite3)
 * ============================================================
 *  Arranque:  npm run dev   /   npm start
 *  Variables de entorno (.env): JWT_SECRET, PORT, FRONTEND_URL (lista con
 *  comas), FIESTA_DB_PATH, FIESTA_UPLOADS_DIR, CLOUDINARY_* (ver .env.example)
 * ============================================================
 */
require('dotenv').config();

const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');

const db = require('./db');
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
const PORT = process.env.PORT || 4000;

// Detrás de Render/Vercel hay un proxy: se confía en el primero para que
// req.ip sea la IP real (clave para el rate-limit).
app.set('trust proxy', 1);

// ---------- Seguridad / parsing ----------
// CORS restringido a los frontends (lista separada por comas en FRONTEND_URL)
const ORIGENES = (process.env.FRONTEND_URL || 'http://localhost:5173')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);
app.use(
  cors({
    origin: ORIGENES.length === 1 ? ORIGENES[0] : ORIGENES,
    credentials: true,
  })
);
app.use(express.json({ limit: '1mb' }));

// Carpeta de subidas en disco (solo modo local; en nube ver src/storage.js)
const { UPLOAD_DIR } = require('./storage');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ---------- Seed automático al primer arranque ----------
try {
  seed();
} catch (e) {
  console.error('Error en el seed:', e.message);
}

// ---------- Endpoints ----------
app.get('/api/salud', (req, res) => res.json({ ok: true, servicio: 'fiesta-api' }));

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
  res.status(err.status || 500).json({ mensaje: err.message || 'Error interno del servidor.' });
});

app.listen(PORT, () => {
  console.log(`🚀 API escuchando en http://localhost:${PORT}`);
  console.log(`   Base de datos: ${db.name}`); // ruta real (FIESTA_DB_PATH en pruebas)
  console.log(`   Subidas:       ${UPLOAD_DIR}`);
});
