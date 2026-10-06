/**
 * /api/configuracion
 * - GET  /          → claves y valores (WhatsApp, datos del evento)
 * - GET  /contactos → staff (admin/mod con WhatsApp) para /soporte y /recuperar.
 *                     Todo rol nuevo aparece solo; sin staff usa la config.
 * - PUT  /:clave    → SOLO admin
 */
const express = require('express');
const db = require('../db');
const { authRequired, requireRole } = require('../middleware/auth');
const { ah } = require('../helpers');

const router = express.Router();

// Lectura abierta (el login/recuperar necesitan los WhatsApp antes de iniciar sesión)
router.get(
  '/',
  ah(async (req, res) => {
    const filas = db.prepare('SELECT clave, valor FROM configuracion').all();
    const map = {};
    filas.forEach((f) => (map[f.clave] = f.valor));
    res.json(map);
  })
);

// Contactos del staff (público: lo usan /soporte y /recuperar sin sesión).
// Solo admin/mod con WhatsApp registrado, admins primero.
router.get(
  '/contactos',
  ah(async (req, res) => {
    const filas = db
      .prepare(
        `SELECT nombre, rol, whatsapp FROM usuarios
         WHERE rol IN ('admin', 'moderador') AND whatsapp IS NOT NULL AND TRIM(whatsapp) != ''
         ORDER BY CASE rol WHEN 'admin' THEN 0 ELSE 1 END, nombre`
      )
      .all();
    const normalizar = (v) => {
      const d = String(v || '').replace(/\D/g, '');
      if (!d) return '';
      return d.startsWith('57') && d.length >= 12 ? d : `57${d}`;
    };
    res.json(
      filas.map((f) => ({
        nombre: f.nombre,
        rol: f.rol,
        whatsapp: String(f.whatsapp).replace(/\D/g, ''),
        wa: normalizar(f.whatsapp),
      }))
    );
  })
);

router.put(
  '/:clave',
  authRequired,
  requireRole('admin'),
  ah(async (req, res) => {
    const clave = String(req.params.clave).trim();
    const { valor } = req.body || {};
    if (!clave) return res.status(400).json({ mensaje: 'Clave inválida.' });
    if (valor === undefined || valor === null) return res.status(400).json({ mensaje: 'Debes indicar un valor.' });

    // Solo claves conocidas, cada una con su formato (evita typos y basura).
    const v = String(valor);
    const validadores = {
      whatsapp_admin: (s) => (s === '' || /^\d{7,15}$/.test(s.replace(/\D/g, '')) ? null : 'El WhatsApp debe tener solo dígitos (7 a 15).'),
      whatsapp_moderador: (s) => (s === '' || /^\d{7,15}$/.test(s.replace(/\D/g, '')) ? null : 'El WhatsApp debe tener solo dígitos (7 a 15).'),
      nombre_admin: (s) => (s.trim() && s.trim().length <= 80 ? null : 'El nombre es obligatorio (máx 80).'),
      nombre_moderador: (s) => (s.trim() && s.trim().length <= 80 ? null : 'El nombre es obligatorio (máx 80).'),
      monto_acompanante: (s) => {
        const n = Number(s);
        return Number.isInteger(n) && n >= 1000 && n <= 1000000 ? null : 'El monto debe ser un entero entre 1000 y 1000000.';
      },
      monto_inscripcion: (s) => {
        const n = Number(s);
        return Number.isInteger(n) && n >= 1000 && n <= 1000000 ? null : 'El monto debe ser un entero entre 1000 y 1000000.';
      },
      nombre_evento: (s) => (s.trim() && s.trim().length <= 120 ? null : 'El nombre del evento es obligatorio (máx 120).'),
      lugar_evento: (s) => (s.trim().length <= 120 ? null : 'El lugar no puede superar 120 caracteres.'),
      fecha_evento: (s) => (s === '' || /^\d{4}-\d{2}-\d{2}$/.test(s) ? null : 'La fecha debe ser YYYY-MM-DD o vacía.'),
      hora_evento: (s) => (s === '' || /^\d{2}:\d{2}$/.test(s) ? null : 'La hora debe ser HH:MM o vacía.'),
    };
    const validar = validadores[clave];
    if (!validar) return res.status(400).json({ mensaje: `Clave de configuración desconocida: "${clave}".` });
    const error = validar(v);
    if (error) return res.status(400).json({ mensaje: error });

    db.prepare(
      `INSERT INTO configuracion (clave, valor, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor, updated_at = CURRENT_TIMESTAMP`
    ).run(clave, v);

    res.json({ mensaje: 'Configuración actualizada.', clave, valor: v });
  })
);

module.exports = router;
