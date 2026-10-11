/**
 * /api/configuracion
 * - GET  /          → claves y valores (WhatsApp, datos del evento;
 *                     del póster solo expone `tiene_poster`, no la referencia)
 * - GET  /contactos → staff (admin/mod con WhatsApp) para /soporte y /recuperar.
 *                     Todo rol nuevo aparece solo; sin staff usa la config.
 * - GET  /poster    → imagen del póster (pública, para Soporte/modal inicio)
 * - PUT  /poster    → SOLO admin: sube/cambia el póster (jpg/png/webp)
 * - DELETE /poster  → SOLO admin: quita el póster
 * - PUT  /:clave    → SOLO admin
 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const db = require('../db');
const { authRequired, requireRole } = require('../middleware/auth');
const { ah, tamanoMaxImagenBytes, etiquetaTamanoMax, TAMANO_MAX_IMAGEN_MB_MAX } = require('../helpers');
const { NUBE, UPLOAD_DIR, subirANube, urlDeNube, borrarDeNube, borrarLocal } = require('../storage');

const router = express.Router();

const storageDisco = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `poster-${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
  },
});

const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

const upload = multer({
  storage: NUBE ? multer.memoryStorage() : storageDisco,
  limits: { fileSize: TAMANO_MAX_IMAGEN_MB_MAX * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (MIME[ext] && ['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) return cb(null, true);
    cb(new Error('Solo se permiten imágenes (jpg, png, webp).'));
  },
});

/** Referencia interna del póster (public_id nube o archivo local). */
function refPoster() {
  try {
    const fila = db.prepare("SELECT valor FROM configuracion WHERE clave = 'poster_evento'").get();
    const v = String(fila && fila.valor || '').trim();
    return v || null;
  } catch (e) {
    return null;
  }
}

function guardarRefPoster(ref) {
  db.prepare(
    `INSERT INTO configuracion (clave, valor, updated_at) VALUES ('poster_evento', ?, CURRENT_TIMESTAMP)
     ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor, updated_at = CURRENT_TIMESTAMP`
  ).run(ref);
}

// Lectura abierta (el login/recuperar necesitan los WhatsApp antes de iniciar sesión)
router.get(
  '/',
  ah(async (req, res) => {
    const filas = db.prepare('SELECT clave, valor FROM configuracion').all();
    const map = {};
    filas.forEach((f) => (map[f.clave] = f.valor));
    // Del póster no se expone la referencia interna, solo si existe.
    delete map.poster_evento;
    map.tiene_poster = !!refPoster();
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

// Póster del evento (público para ver; solo admin lo cambia).
router.get(
  '/poster',
  ah(async (req, res) => {
    const ref = refPoster();
    if (!ref) return res.status(404).json({ mensaje: 'Aún no hay póster del evento.' });
    if (NUBE) return res.redirect(urlDeNube(ref));
    const ruta = path.join(UPLOAD_DIR, path.basename(ref));
    if (!fs.existsSync(ruta)) return res.status(404).json({ mensaje: 'El póster ya no existe en el servidor.' });
    res.setHeader('Content-Type', MIME[path.extname(ruta).toLowerCase()] || 'application/octet-stream');
    res.sendFile(ruta);
  })
);

router.put(
  '/poster',
  authRequired,
  requireRole('admin'),
  (req, res, next) => {
    upload.single('archivo')(req, res, (err) => {
      if (err) {
        const msg =
          err.code === 'LIMIT_FILE_SIZE'
            ? `El archivo supera el máximo absoluto de ${TAMANO_MAX_IMAGEN_MB_MAX} MB.`
            : err.message || 'Error al subir el archivo.';
        return res.status(400).json({ mensaje: msg });
      }
      if (req.file && req.file.size > tamanoMaxImagenBytes()) {
        if (!NUBE && req.file.filename) borrarLocal(req.file.filename);
        return res.status(400).json({ mensaje: `El archivo supera el máximo permitido de ${etiquetaTamanoMax()}.` });
      }
      next();
    });
  },
  ah(async (req, res) => {
    if (!req.file) return res.status(400).json({ mensaje: 'Debes adjuntar la imagen del póster.' });
    let ref;
    try {
      ref = NUBE ? await subirANube(req.file.buffer, req.file.originalname) : req.file.filename;
    } catch (e) {
      return res.status(502).json({ mensaje: 'No se pudo guardar el póster. Intenta de nuevo.' });
    }
    const anterior = refPoster();
    guardarRefPoster(ref);
    if (anterior && anterior !== ref) {
      if (NUBE) await borrarDeNube(anterior);
      else borrarLocal(anterior);
    }
    res.json({ mensaje: 'Póster actualizado.', tiene_poster: true });
  })
);

router.delete(
  '/poster',
  authRequired,
  requireRole('admin'),
  ah(async (req, res) => {
    const ref = refPoster();
    if (!ref) return res.status(404).json({ mensaje: 'No hay póster para quitar.' });
    if (NUBE) await borrarDeNube(ref);
    else borrarLocal(ref);
    guardarRefPoster('');
    res.json({ mensaje: 'Póster eliminado.', tiene_poster: false });
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
      tamano_max_imagen_mb: (s) => {
        const n = Number(s);
        return !isNaN(n) && n > 0 && n <= 3 ? null : 'El tamaño debe ser mayor a 0 y hasta 3 MB.';
      },
      combo_cerveza: (s) => {
        const n = Number(s);
        return Number.isInteger(n) && n >= 0 && n <= 100 ? null : 'La cantidad debe ser un entero entre 0 y 100.';
      },
      combo_comida: (s) => {
        const n = Number(s);
        return Number.isInteger(n) && n >= 0 && n <= 100 ? null : 'La cantidad debe ser un entero entre 0 y 100.';
      },
      nombre_evento: (s) => (s.trim() && s.trim().length <= 120 ? null : 'El nombre del evento es obligatorio (máx 120).'),
      lugar_evento: (s) => (s.trim().length <= 120 ? null : 'El lugar no puede superar 120 caracteres.'),
      direccion_evento: (s) => (s.trim().length <= 120 ? null : 'La dirección no puede superar 120 caracteres.'),
      fecha_evento: (s) => (s === '' || /^\d{4}-\d{2}-\d{2}$/.test(s) ? null : 'La fecha debe ser YYYY-MM-DD o vacía.'),
      fecha_abono: (s) => (s === '' || /^\d{4}-\d{2}-\d{2}$/.test(s) ? null : 'La fecha debe ser YYYY-MM-DD o vacía.'),
      fecha_limite_pago: (s) => (s === '' || /^\d{4}-\d{2}-\d{2}$/.test(s) ? null : 'La fecha debe ser YYYY-MM-DD o vacía.'),
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
