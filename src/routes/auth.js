/**
 * /api/auth
 * - POST /registro        → crea usuario (rol 'usuario') y devuelve token
 * - POST /login           → valida credenciales y devuelve token (8h)
 * - POST /recuperar       → SOLO pide email; nunca revela si existe
 * - POST /cambiar-password → usuario logueado (obligatorio si password_temporal=1)
 */
const express = require('express');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const db = require('../db');
const { firmarToken, authRequired } = require('../middleware/auth');
const { authLimiter } = require('../middleware/rateLimit');
const { ah, usuarioPublico, montoInscripcion, siguienteCodigoSinCedula } = require('../helpers');

const router = express.Router();

const esEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s || '');
const NOMBRE_MIN = 3;
const NOMBRE_MAX = 80;
const CEDULA_RE = /^\d{6,12}$/;
const EMAIL_MAX = 120;
const PASS_MIN = 6;
const PASS_MAX = 72;

// ---------------------------------------------------------
// Registro
// ---------------------------------------------------------
router.post(
  '/registro',
  authLimiter,
  ah(async (req, res) => {
    const { nombre, cedula, email, password, whatsapp } = req.body || {};
    if (!nombre || !email || !password) {
      return res.status(400).json({ mensaje: 'Nombre, email y contraseña son obligatorios.' });
    }
    // El WhatsApp es obligatorio: vincula avisos por WhatsApp (pagos, claves, soporte).
    const wRaw = String(whatsapp || '').trim();
    const w = wRaw.replace(/\D/g, '');
    if (!wRaw) {
      return res.status(400).json({ mensaje: 'El WhatsApp es obligatorio.' });
    }
    if (!/^\d{7,15}$/.test(w)) {
      return res.status(400).json({ mensaje: 'El WhatsApp debe tener solo dígitos (7 a 15).' });
    }
    const nom = String(nombre).trim();
    // Cédula opcional: si no la informan se asigna un código interno 900….
    let ced = String(cedula || '').trim();
    const mail = String(email).trim().toLowerCase();
    if (nom.length < NOMBRE_MIN || nom.length > NOMBRE_MAX) {
      return res.status(400).json({ mensaje: `El nombre debe tener entre ${NOMBRE_MIN} y ${NOMBRE_MAX} caracteres.` });
    }
    if (ced && !CEDULA_RE.test(ced)) {
      return res.status(400).json({ mensaje: 'La cédula debe tener solo dígitos (6 a 12).' });
    }
    if (!esEmail(mail) || mail.length > EMAIL_MAX) {
      return res.status(400).json({ mensaje: 'El email no es válido.' });
    }
    // La contraseña no se recorta: los espacios son válidos. Límite 72 por bcrypt.
    if (String(password).length < PASS_MIN || String(password).length > PASS_MAX) {
      return res.status(400).json({ mensaje: `La contraseña debe tener entre ${PASS_MIN} y ${PASS_MAX} caracteres.` });
    }

    // Unicidad: email siempre; cédula solo si la informó.
    const existe = ced
      ? db.prepare('SELECT id FROM usuarios WHERE cedula = ? OR email = ?').get(ced, mail)
      : db.prepare('SELECT id FROM usuarios WHERE email = ?').get(mail);
    if (existe) return res.status(409).json({ mensaje: 'La cédula o el email ya están registrados.' });

    const password_hash = await bcrypt.hash(String(password), 10);
    // Sección síncrona: asignar código + insertar sin awaits intermedios.
    if (!ced) ced = siguienteCodigoSinCedula();
    // El UUID lo genera el servidor: lo que mande el cliente se ignora.
    const info = db
      .prepare(
        `INSERT INTO usuarios (uuid, nombre, cedula, email, password_hash, rol, whatsapp, estado_pago, monto_abonado, saldo_pendiente)
         VALUES (?, ?, ?, ?, ?, 'usuario', ?, 'no_pago', 0, ?)`
      )
      .run(crypto.randomUUID(), nom, ced, mail, password_hash, w, montoInscripcion());

    const usuario = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(info.lastInsertRowid);
    const token = firmarToken(usuario);
    res.status(201).json({ token, usuario: usuarioPublico(usuario) });
  })
);

// ---------------------------------------------------------
// Login
// ---------------------------------------------------------
router.post(
  '/login',
  authLimiter,
  ah(async (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ mensaje: 'Email y contraseña son obligatorios.' });

    const usuario = db.prepare('SELECT * FROM usuarios WHERE email = ?').get(String(email).trim().toLowerCase());
    // Mensaje genérico: no revela si el email existe
    if (!usuario) return res.status(401).json({ mensaje: 'Credenciales incorrectas.' });

    const ok = await bcrypt.compare(String(password), usuario.password_hash);
    if (!ok) return res.status(401).json({ mensaje: 'Credenciales incorrectas.' });

    const token = firmarToken(usuario);
    res.json({ token, usuario: usuarioPublico(usuario) });
  })
);

// ---------------------------------------------------------
// Recuperación de contraseña (SOLO email, sin revelar existencia)
// Si el email existe: marca temporal + registra solicitud pendiente
// para que el admin/mod la atienda (notificación en su panel).
// ---------------------------------------------------------
router.post(
  '/recuperar',
  authLimiter,
  ah(async (req, res) => {
    const { email } = req.body || {};
    const mensaje =
      'Solicitud enviada. Contacta al admin/moderador por WhatsApp para recibir tu contraseña temporal.';

    if (email) {
      const usuario = db
        .prepare('SELECT id FROM usuarios WHERE email = ?')
        .get(String(email).trim().toLowerCase());
      // Solo marcamos que debe cambiarla; no devolvemos la contraseña ni indicamos si existía el email
      if (usuario) {
        db.prepare('UPDATE usuarios SET password_temporal = 1 WHERE id = ?').run(usuario.id);
        // Una sola pendiente por usuario: si ya hay, se refresca la fecha.
        const previa = db
          .prepare("SELECT id FROM solicitudes_recuperacion WHERE usuario_id = ? AND estado = 'pendiente'")
          .get(usuario.id);
        if (previa) {
          db.prepare('UPDATE solicitudes_recuperacion SET created_at = CURRENT_TIMESTAMP WHERE id = ?').run(previa.id);
        } else {
          db.prepare('INSERT INTO solicitudes_recuperacion (usuario_id, email) VALUES (?, ?)').run(
            usuario.id,
            String(email).trim().toLowerCase()
          );
        }
      }
    }
    res.json({ mensaje });
  })
);

// ---------------------------------------------------------
// Cambiar contraseña (usuario logueado)
// ---------------------------------------------------------
router.post(
  '/cambiar-password',
  authRequired,
  ah(async (req, res) => {
    // Alias histórico: el frontend envía password_nueva; se acepta password_nuevo también.
    const password_nueva = (req.body && (req.body.password_nueva ?? req.body.password_nuevo)) || '';
    const { password_actual } = req.body || {};
    if (!password_nueva || String(password_nueva).length < PASS_MIN || String(password_nueva).length > PASS_MAX) {
      return res.status(400).json({ mensaje: `La nueva contraseña debe tener entre ${PASS_MIN} y ${PASS_MAX} caracteres.` });
    }

    const actual = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(req.user.id);

    // Si tiene contraseña temporal basta con la nueva; si no, debe conocer la actual
    if (!actual.password_temporal) {
      if (!password_actual) return res.status(400).json({ mensaje: 'Debes indicar tu contraseña actual.' });
      const ok = await bcrypt.compare(String(password_actual), actual.password_hash);
      if (!ok) return res.status(400).json({ mensaje: 'La contraseña actual no es correcta.' });
    }

    const hash = await bcrypt.hash(String(password_nueva), 10);
    db.prepare('UPDATE usuarios SET password_hash = ?, password_temporal = 0 WHERE id = ?').run(hash, req.user.id);

    res.json({ mensaje: 'Contraseña actualizada correctamente.' });
  })
);

module.exports = router;
