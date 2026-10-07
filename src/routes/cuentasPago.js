/**
 * /api/cuentas-pago
 * - GET  /          → cualquier usuario logueado (para el modal de pago)
 * - PUT  /:id       → SOLO admin (número, titular, activa, orden)
 * - GET  /:id/qr    → logueado: imagen QR para pagar por QR
 * - PUT  /:id/qr    → SOLO admin: sube/cambia el QR (jpg/png/webp, tamaño configurable)
 * - DELETE /:id/qr  → SOLO admin: quita el QR
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
router.use(authRequired);

const storageDisco = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `qr-${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
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

/** Fila pública: indica si hay QR sin exponer la referencia interna. */
function cuentaPublica(c) {
  if (!c) return c;
  const { qr, ...resto } = c;
  return { ...resto, tiene_qr: !!qr };
}

router.get(
  '/',
  ah(async (req, res) => {
    const soloActivas = !(req.user.rol === 'admin' && req.query.todas === '1');
    const filas = soloActivas
      ? db.prepare('SELECT * FROM cuentas_pago WHERE activa = 1 ORDER BY orden IS NULL, orden, id').all()
      : db.prepare('SELECT * FROM cuentas_pago ORDER BY orden IS NULL, orden, id').all();
    res.json(filas.map(cuentaPublica));
  })
);

router.put(
  '/:id',
  requireRole('admin'),
  ah(async (req, res) => {
    const id = Number(req.params.id);
    const cuenta = db.prepare('SELECT * FROM cuentas_pago WHERE id = ?').get(id);
    if (!cuenta) return res.status(404).json({ mensaje: 'Cuenta no encontrada.' });

    const { numero, titular, activa, orden } = req.body || {};
    const campos = [];
    const valores = [];

    if (numero !== undefined) {
      if (!String(numero).trim()) return res.status(400).json({ mensaje: 'El número no puede estar vacío.' });
      campos.push('numero = ?');
      valores.push(String(numero).trim());
    }
    if (titular !== undefined) {
      if (!String(titular).trim()) return res.status(400).json({ mensaje: 'El titular no puede estar vacío.' });
      campos.push('titular = ?');
      valores.push(String(titular).trim());
    }
    if (activa !== undefined) {
      campos.push('activa = ?');
      valores.push(activa ? 1 : 0);
    }
    if (orden !== undefined && !isNaN(Number(orden))) {
      campos.push('orden = ?');
      valores.push(Number(orden));
    }
    if (!campos.length) return res.status(400).json({ mensaje: 'No hay datos para actualizar.' });

    campos.push('updated_at = CURRENT_TIMESTAMP');
    valores.push(id);
    db.prepare(`UPDATE cuentas_pago SET ${campos.join(', ')} WHERE id = ?`).run(...valores);

    res.json({ mensaje: 'Cuenta actualizada.', cuenta: cuentaPublica(db.prepare('SELECT * FROM cuentas_pago WHERE id = ?').get(id)) });
  })
);

// ---------------------------------------------------------
// Ver QR (cualquier logueado: sale en el modal de pago)
// ---------------------------------------------------------
router.get(
  '/:id/qr',
  ah(async (req, res) => {
    const cuenta = db.prepare('SELECT * FROM cuentas_pago WHERE id = ?').get(Number(req.params.id));
    if (!cuenta) return res.status(404).json({ mensaje: 'Cuenta no encontrada.' });
    if (!cuenta.qr) return res.status(404).json({ mensaje: 'Esta cuenta aún no tiene QR.' });

    if (NUBE) return res.redirect(urlDeNube(cuenta.qr));

    const ruta = path.join(UPLOAD_DIR, path.basename(cuenta.qr));
    if (!fs.existsSync(ruta)) return res.status(404).json({ mensaje: 'El QR ya no existe en el servidor.' });
    res.setHeader('Content-Type', MIME[path.extname(ruta).toLowerCase()] || 'application/octet-stream');
    res.sendFile(ruta);
  })
);

// ---------------------------------------------------------
// Subir/cambiar QR (SOLO admin)
// ---------------------------------------------------------
router.put(
  '/:id/qr',
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
      // Límite configurable por el admin (default 1 MB).
      if (req.file && req.file.size > tamanoMaxImagenBytes()) {
        if (!NUBE && req.file.filename) borrarLocal(req.file.filename);
        return res.status(400).json({ mensaje: `El archivo supera el máximo permitido de ${etiquetaTamanoMax()}.` });
      }
      next();
    });
  },
  ah(async (req, res) => {
    const id = Number(req.params.id);
    const cuenta = db.prepare('SELECT * FROM cuentas_pago WHERE id = ?').get(id);
    if (!cuenta) {
      if (req.file && !NUBE) borrarLocal(req.file.filename);
      return res.status(404).json({ mensaje: 'Cuenta no encontrada.' });
    }
    if (!req.file) return res.status(400).json({ mensaje: 'Debes adjuntar la imagen del QR.' });

    let qr;
    try {
      qr = NUBE ? await subirANube(req.file.buffer, req.file.originalname) : req.file.filename;
    } catch (e) {
      return res.status(502).json({ mensaje: 'No se pudo guardar el QR. Intenta de nuevo.' });
    }
    if (cuenta.qr) {
      if (NUBE) await borrarDeNube(cuenta.qr);
      else borrarLocal(cuenta.qr);
    }
    db.prepare('UPDATE cuentas_pago SET qr = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(qr, id);
    res.json({ mensaje: 'QR actualizado.', cuenta: cuentaPublica(db.prepare('SELECT * FROM cuentas_pago WHERE id = ?').get(id)) });
  })
);

// ---------------------------------------------------------
// Quitar QR (SOLO admin)
// ---------------------------------------------------------
router.delete(
  '/:id/qr',
  requireRole('admin'),
  ah(async (req, res) => {
    const id = Number(req.params.id);
    const cuenta = db.prepare('SELECT * FROM cuentas_pago WHERE id = ?').get(id);
    if (!cuenta) return res.status(404).json({ mensaje: 'Cuenta no encontrada.' });
    if (!cuenta.qr) return res.status(400).json({ mensaje: 'Esta cuenta no tiene QR.' });

    if (NUBE) await borrarDeNube(cuenta.qr);
    else borrarLocal(cuenta.qr);
    db.prepare('UPDATE cuentas_pago SET qr = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);
    res.json({ mensaje: 'QR eliminado.', cuenta: cuentaPublica(db.prepare('SELECT * FROM cuentas_pago WHERE id = ?').get(id)) });
  })
);

module.exports = router;
