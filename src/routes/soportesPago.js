/**
 * /api/soportes-pago
 * - POST /                     → usuario sube soporte (multipart jpg/png/webp, tamaño configurable 0.5–3 MB)
 * - GET  /mios                 → usuario: sus soportes
 * - GET  /                     → admin/mod: pendientes (o ?estado=todas)
 * - PUT  /:id/aprobar          → admin/mod: actualiza saldo y registra movimiento en Caja Inscripción
 * - PUT  /:id/rechazar         → admin/mod: comentario obligatorio
 * - GET  /:id/archivo          → admin/mod: visor de imágenes
 *
 * NOTA: los tickets de soporte quedan fuera de esta versión (fase 2).
 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const db = require('../db');
const { authRequired, requireRole } = require('../middleware/auth');
const { ah, ABONO_MINIMO, refrescarEstadoPago, registrarMovimientoCaja, usuarioPublico, reservarCombo, dineroCol, tamanoMaxImagenBytes, etiquetaTamanoMax, TAMANO_MAX_IMAGEN_MB_MAX } = require('../helpers');
const { NUBE, UPLOAD_DIR, subirANube, urlDeNube, borrarDeNube, borrarLocal } = require('../storage');

const router = express.Router();

// Almacenamiento en disco con nombre aleatorio (evita colisiones y nombres peligrosos)
const storageDisco = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
  },
});

const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

// Solo imágenes. Multer corta en el techo absoluto (3 MB) y el límite
// configurable del admin (0.5–3 MB) se valida tras la subida con mensaje claro.
// En nube se guarda en memoria y se sube tras validar.
const upload = multer({
  storage: NUBE ? multer.memoryStorage() : storageDisco,
  limits: { fileSize: TAMANO_MAX_IMAGEN_MB_MAX * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (MIME[ext] && ['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) return cb(null, true);
    cb(new Error('Solo se permiten imágenes (jpg, png, webp).'));
  },
});

router.use(authRequired);

/** Elimina el archivo subido (nube o disco) de forma silenciosa. */
async function borrarSubido(archivo) {
  if (!archivo) return;
  if (NUBE) await borrarDeNube(archivo);
  else borrarLocal(archivo);
}

// ---------------------------------------------------------
// Subir soporte (usuario; admin/mod pueden subir por otro usuario
// con `usuario_id`: queda pendiente igual que si lo subiera él)
// ---------------------------------------------------------
router.post(
  '/',
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
    if (!req.file) return res.status(400).json({ mensaje: 'Debes adjuntar una imagen del soporte de pago.' });

    const monto = Number((req.body || {}).monto);
    const tipo = (req.body && req.body.tipo) || 'abono';
    // En nube el archivo está en memoria: se sube solo si pasa las validaciones.
    const nombreTemporal = NUBE ? null : req.file.filename;
    const fallar = async (mensaje) => {
      await borrarSubido(nombreTemporal);
      return res.status(400).json({ mensaje });
    };

    // Dueño del soporte: uno mismo, o (solo staff) el usuario indicado.
    const pedidoPara = (req.body && req.body.usuario_id !== undefined && req.body.usuario_id !== null && req.body.usuario_id !== '')
      ? Number(req.body.usuario_id)
      : req.user.id;
    if (!Number.isInteger(pedidoPara)) return fallar('usuario_id inválido.');
    if (pedidoPara !== req.user.id && !['admin', 'moderador'].includes(req.user.rol)) {
      return res.status(403).json({ mensaje: 'No tienes permisos para subir soportes de otro usuario.' });
    }
    const usuario = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(pedidoPara);
    if (!usuario) return fallar('Usuario no encontrado.');
    if (pedidoPara !== req.user.id && usuario.rol !== 'usuario') {
      return fallar('Solo se suben soportes de usuarios.');
    }

    if (!['abono', 'pago_total'].includes(tipo)) {
      return fallar('Tipo de soporte inválido.');
    }
    if (isNaN(monto) || monto <= 0) {
      return fallar('Debes indicar el monto reportado.');
    }

    // Pago total => el monto es exactamente el saldo pendiente
    const montoFinal = tipo === 'pago_total' ? usuario.saldo_pendiente : monto;

    if (montoFinal <= 0) {
      return fallar('No hay saldo pendiente por pagar.');
    }

    if (montoFinal > usuario.saldo_pendiente) {
      return fallar('El monto reportado supera el saldo pendiente.');
    }
    if (tipo === 'abono' && montoFinal < ABONO_MINIMO && montoFinal < usuario.saldo_pendiente) {
      return fallar(`El abono mínimo es $${ABONO_MINIMO.toLocaleString('es-CO')}.`);
    }

    let archivo;
    try {
      archivo = NUBE ? await subirANube(req.file.buffer, req.file.originalname) : nombreTemporal;
    } catch (e) {
      return res.status(502).json({ mensaje: 'No se pudo guardar la imagen. Intenta de nuevo.' });
    }

    const info = db
      .prepare(
        `INSERT INTO soportes_pago (usuario_id, archivo, monto_reportado, tipo, estado)
         VALUES (?, ?, ?, ?, 'pendiente')`
      )
      .run(usuario.id, archivo, montoFinal, tipo);

    const soporte = db.prepare('SELECT * FROM soportes_pago WHERE id = ?').get(info.lastInsertRowid);
    res.status(201).json({
      mensaje: 'Soporte enviado. Quedará pendiente de validación por el admin o moderador.',
      soporte,
    });
  })
);

// ---------------------------------------------------------
// Mis soportes (usuario)
// ---------------------------------------------------------
router.get(
  '/mios',
  ah(async (req, res) => {
    const filas = db
      .prepare('SELECT * FROM soportes_pago WHERE usuario_id = ? ORDER BY created_at DESC, id DESC')
      .all(req.user.id);
    res.json(filas);
  })
);

// ---------------------------------------------------------
// Listado (admin y moderador): pendientes por defecto
// ?estado=todas|pendiente|aprobado|rechazado  ?usuario_id= (filtro opcional)
// ---------------------------------------------------------
router.get(
  '/',
  requireRole('admin', 'moderador'),
  ah(async (req, res) => {
    const estado = req.query.estado || 'pendiente';
    const usuarioId = req.query.usuario_id ? Number(req.query.usuario_id) : null;
    if (req.query.usuario_id && !Number.isInteger(usuarioId)) {
      return res.status(400).json({ mensaje: 'usuario_id inválido.' });
    }

    const conds = [];
    const params = [];
    if (estado !== 'todas') {
      conds.push('s.estado = ?');
      params.push(estado);
    }
    if (usuarioId) {
      conds.push('s.usuario_id = ?');
      params.push(usuarioId);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    // Pendientes: los más antiguos primero; historial: lo reciente primero.
    const orden = estado === 'pendiente' ? 'ORDER BY s.created_at ASC, s.id ASC' : 'ORDER BY s.created_at DESC, s.id DESC';

    const filas = db
      .prepare(
        `SELECT s.*, u.nombre AS usuario_nombre, u.cedula AS usuario_cedula, u.email AS usuario_email,
                r.nombre AS revisado_por_nombre
         FROM soportes_pago s
         JOIN usuarios u ON u.id = s.usuario_id
         LEFT JOIN usuarios r ON r.id = s.revisado_por
         ${where}
         ${orden}`
      )
      .all(...params);
    res.json(filas);
  })
);

// ---------------------------------------------------------
// Exportar CSV de pagos validados (admin y moderador).
// ?estado=aprobado (defecto) | pendiente | rechazado | todas
// ---------------------------------------------------------
router.get(
  '/exportar',
  requireRole('admin', 'moderador'),
  ah(async (req, res) => {
    const estado = req.query.estado || 'aprobado';
    const filtro = ['pendiente', 'aprobado', 'rechazado'].includes(estado) ? 'WHERE s.estado = ?' : '';
    const params = filtro ? [estado] : [];

    const filas = db
      .prepare(
        `SELECT s.id, s.monto_reportado, s.tipo AS soporte_tipo, s.estado, s.created_at,
                s.revisado_en, s.comentario_revision,
                u.nombre AS usuario_nombre, u.cedula AS usuario_cedula,
                u.email AS usuario_email, u.whatsapp AS usuario_whatsapp,
                u.monto_abonado, u.saldo_pendiente, u.estado_pago,
                (SELECT COUNT(*) FROM acompanantes a WHERE a.usuario_id = u.id) AS n_acompanantes,
                (SELECT COALESCE(SUM(a.monto), 0) FROM acompanantes a WHERE a.usuario_id = u.id) AS total_acompanantes,
                (SELECT GROUP_CONCAT(a.nombre, ' | ') FROM acompanantes a WHERE a.usuario_id = u.id) AS nombres_acompanantes,
                r.nombre AS revisado_por_nombre
         FROM soportes_pago s
         JOIN usuarios u ON u.id = s.usuario_id
         LEFT JOIN usuarios r ON r.id = s.revisado_por
         ${filtro}
         ORDER BY s.created_at DESC, s.id DESC`
      )
      .all(...params);

    const esc = (v) => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };

    const encabezado = [
      'Fecha_soporte', 'Nombre', 'Cedula', 'Email', 'WhatsApp', 'Tipo_soporte', 'Estado_soporte',
      'Monto_reportado', 'Monto_abonado', 'Saldo_pendiente', 'Estado_pago',
      'Cantidad_acompanantes', 'Total_acompanantes', 'Nombres_acompanantes', 'Revisado_por', 'Revisado_en', 'Comentario',
    ].map(esc).join(';');

    const lineas = filas.map((f) =>
      [
        f.created_at, f.usuario_nombre, f.usuario_cedula, f.usuario_email, f.usuario_whatsapp || '',
        f.soporte_tipo, f.estado, f.monto_reportado, f.monto_abonado, f.saldo_pendiente, f.estado_pago,
        f.n_acompanantes || 0, f.total_acompanantes || '', f.nombres_acompanantes || '', f.revisado_por_nombre || '',
        f.revisado_en || '', f.comentario_revision || '',
      ].map(esc).join(';')
    );

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="pagos-${estado}.csv"`);
    res.send('\ufeff' + [encabezado, ...lineas].join('\n')); // BOM para Excel
  })
);

// ---------------------------------------------------------
// Visor de imagen (admin, moderador y el dueño del soporte)
// ---------------------------------------------------------
router.get(
  '/:id/archivo',
  ah(async (req, res) => {
    const soporte = db.prepare('SELECT * FROM soportes_pago WHERE id = ?').get(Number(req.params.id));
    if (!soporte) return res.status(404).json({ mensaje: 'Soporte no encontrado.' });
    // Solo admin/moderador o el propio dueño pueden ver la imagen
    const permitido = ['admin', 'moderador'].includes(req.user.rol) || soporte.usuario_id === req.user.id;
    if (!permitido) return res.status(403).json({ mensaje: 'No tienes permisos para ver este soporte.' });

    // En nube se redirige a una URL firmada temporal (la sesión ya se validó).
    if (NUBE) return res.redirect(urlDeNube(soporte.archivo));

    const ruta = path.join(UPLOAD_DIR, path.basename(soporte.archivo));
    if (!fs.existsSync(ruta)) return res.status(404).json({ mensaje: 'El archivo ya no existe en el servidor.' });

    res.setHeader('Content-Type', MIME[path.extname(ruta).toLowerCase()] || 'application/octet-stream');
    res.sendFile(ruta);
  })
);

// ---------------------------------------------------------
// Aprobar soporte (admin y moderador) → todo el flujo contable
// ---------------------------------------------------------
router.put(
  '/:id/aprobar',
  requireRole('admin', 'moderador'),
  ah(async (req, res) => {
    const id = Number(req.params.id);
    const soporte = db.prepare('SELECT * FROM soportes_pago WHERE id = ?').get(id);
    if (!soporte) return res.status(404).json({ mensaje: 'Soporte no encontrado.' });
    if (soporte.estado !== 'pendiente') return res.status(400).json({ mensaje: 'El soporte ya fue revisado.' });

    const usuario = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(soporte.usuario_id);
    const comentario = (req.body && req.body.comentario) || null;

    // Sin auto-aprobación: nadie aprueba su propio soporte.
    if (soporte.usuario_id === req.user.id) {
      return res.status(403).json({ mensaje: 'No puedes aprobar tu propio soporte.' });
    }
    // Revalida contra el saldo actual (pudo cambiar desde la subida).
    if (soporte.monto_reportado > Number(usuario.saldo_pendiente)) {
      return res.status(400).json({
        mensaje: `El soporte supera el saldo actual (${dineroCol(usuario.saldo_pendiente)}). Recházalo o pide uno nuevo.`,
      });
    }

    const tx = db.transaction(() => {
      // 1) Marcar soporte como aprobado
      db.prepare(
        `UPDATE soportes_pago SET estado = 'aprobado', revisado_por = ?, revisado_en = CURRENT_TIMESTAMP,
         comentario_revision = ? WHERE id = ?`
      ).run(req.user.id, comentario, id);

      // 2) Actualizar montos del usuario
      db.prepare(
        `UPDATE usuarios SET monto_abonado = monto_abonado + ?,
         saldo_pendiente = MAX(0, saldo_pendiente - ?), pago_validado = 1 WHERE id = ?`
      ).run(soporte.monto_reportado, soporte.monto_reportado, usuario.id);
      refrescarEstadoPago(usuario.id);
      // 2b) Al pagar el total se reserva su combo en inventario (sin frenar dinero).

      // 3) Registrar el ingreso en la Caja de Inscripciones
      registrarMovimientoCaja({
        tipoCaja: 'inscripcion',
        usuarioId: usuario.id,
        tipo: 'ingreso',
        concepto:
          soporte.tipo === 'pago_total'
            ? `Pago total aprobado - ${usuario.nombre}`
            : `Abono aprobado - ${usuario.nombre}`,
        monto: soporte.monto_reportado,
        metodo: 'transferencia',
      });
    });
    tx();

    let reserva = null;
    const trasPago = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(usuario.id);
    if (trasPago.estado_pago === 'pagado') reserva = reservarCombo(usuario.id);

    const actualizado = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(usuario.id);
    res.json({
      mensaje: 'Soporte aprobado y pago actualizado.',
      soporte: db.prepare('SELECT * FROM soportes_pago WHERE id = ?').get(id),
      usuario: usuarioPublico(actualizado),
      reserva,
    });
  })
);

// ---------------------------------------------------------
// Rechazar soporte (admin y moderador) - comentario OBLIGATORIO
// ---------------------------------------------------------
router.put(
  '/:id/rechazar',
  requireRole('admin', 'moderador'),
  ah(async (req, res) => {
    const id = Number(req.params.id);
    const soporte = db.prepare('SELECT * FROM soportes_pago WHERE id = ?').get(id);
    if (!soporte) return res.status(404).json({ mensaje: 'Soporte no encontrado.' });
    if (soporte.estado !== 'pendiente') return res.status(400).json({ mensaje: 'El soporte ya fue revisado.' });

    const comentario = ((req.body || {}).comentario || '').trim();
    if (!comentario) return res.status(400).json({ mensaje: 'Debes indicar un comentario al rechazar.' });

    db.prepare(
      `UPDATE soportes_pago SET estado = 'rechazado', revisado_por = ?, revisado_en = CURRENT_TIMESTAMP,
       comentario_revision = ? WHERE id = ?`
    ).run(req.user.id, comentario, id);

    res.json({
      mensaje: 'Soporte rechazado. El usuario puede subirlo nuevamente.',
      soporte: db.prepare('SELECT * FROM soportes_pago WHERE id = ?').get(id),
    });
  })
);

module.exports = router;
