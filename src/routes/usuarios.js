/**
 * /api/usuarios
 * Gestión de usuarios, validación de pagos y resets de contraseña.
 */
const express = require('express');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const db = require('../db');
const { authRequired, requireRole } = require('../middleware/auth');
const {
  ah,
  montoInscripcion,
  ABONO_MINIMO,
  refrescarEstadoPago,
  reservarCombo,
  acompanantesDe,
  comboEstado,
  registrarMovimientoCaja,
  usuarioPublico,
  totalCupo,
  textoRespuesta,
} = require('../helpers');

const router = express.Router();
router.use(authRequired);

const ROTULOS = { admin: 'Administrador', moderador: 'Moderador', usuario: 'Usuario' };

/** SELECT compartido del listado y la ficha: usuario + métricas de combo/pagos. */
const SQL_USUARIO_DETALLE = `
  SELECT u.*,
         (SELECT COALESCE(SUM(e.cantidad), 0) FROM entregas_usuario e
          JOIN inventario i ON i.id = e.inventario_id
          WHERE e.usuario_id = u.id AND e.tipo = 'combo' AND i.categoria = 'bebida') AS cervezas_entregadas,
         (SELECT COALESCE(SUM(e.cantidad), 0) FROM entregas_usuario e
          JOIN inventario i ON i.id = e.inventario_id
          WHERE e.usuario_id = u.id AND e.tipo = 'combo' AND i.categoria = 'comida') AS comidas_entregadas,
         (SELECT COUNT(*) FROM soportes_pago s WHERE s.usuario_id = u.id AND s.estado = 'pendiente') AS soportes_pendientes,
         (SELECT COUNT(*) FROM respuestas_encuesta r WHERE r.usuario_id = u.id) AS respuestas_encuesta,
         (SELECT COUNT(*) FROM acompanantes a WHERE a.usuario_id = u.id) AS n_acompanantes,
         (SELECT COALESCE(SUM(a.monto), 0) FROM acompanantes a WHERE a.usuario_id = u.id) AS total_acompanantes
  FROM usuarios u`;

/** Genera una contraseña temporal legible (8 caracteres). */
function passwordTemporal() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let out = '';
  const bytes = crypto.randomBytes(8);
  for (let i = 0; i < 8; i++) out += chars[bytes[i] % chars.length];
  return out;
}

// ---------------------------------------------------------
// Mi perfil
// ---------------------------------------------------------
router.get('/me', (req, res) => res.json(req.user));

router.put(
  '/me',
  ah(async (req, res) => {
    const { nombre, email, whatsapp } = req.body || {};
    const cambios = [];
    const valores = [];

    if (nombre !== undefined) {
      const nom = String(nombre).trim();
      if (nom.length < 3 || nom.length > 80) {
        return res.status(400).json({ mensaje: 'El nombre debe tener entre 3 y 80 caracteres.' });
      }
      cambios.push('nombre = ?');
      valores.push(nom);
    }
    if (email !== undefined) {
      const mail = String(email).trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail) || mail.length > 120) {
        return res.status(400).json({ mensaje: 'El email no es válido.' });
      }
      const existe = db
        .prepare('SELECT id FROM usuarios WHERE email = ? AND id != ?')
        .get(mail, req.user.id);
      if (existe) return res.status(409).json({ mensaje: 'Ese email ya está en uso por otro usuario.' });
      cambios.push('email = ?');
      valores.push(mail);
    }
    if (whatsapp !== undefined) {
      const raw = String(whatsapp).trim();
      const w = raw.replace(/\D/g, '');
      if (raw !== '' && !/^\d{7,15}$/.test(w)) {
        return res.status(400).json({ mensaje: 'El WhatsApp debe tener solo dígitos (7 a 15).' });
      }
      cambios.push('whatsapp = ?');
      valores.push(w);
    }
    if (!cambios.length) return res.status(400).json({ mensaje: 'No hay datos para actualizar.' });

    valores.push(req.user.id);
    db.prepare(`UPDATE usuarios SET ${cambios.join(', ')} WHERE id = ?`).run(...valores);
    const actualizado = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(req.user.id);
    res.json({ mensaje: 'Perfil actualizado.', usuario: usuarioPublico(actualizado) });
  })
);

// ---------------------------------------------------------
// Registro manual (admin y moderador): mismos datos y validaciones
// que /auth/registro, sin pedir clave: genera una temporal
// (deberá cambiarla al ingresar) y la devuelve una sola vez
// para compartirla por WhatsApp.
// ---------------------------------------------------------
router.post(
  '/',
  requireRole('admin', 'moderador'),
  ah(async (req, res) => {
    const { nombre, cedula, email, whatsapp } = req.body || {};
    if (!nombre || !cedula || !email || !whatsapp) {
      return res.status(400).json({ mensaje: 'Nombre, cédula, email y WhatsApp son obligatorios.' });
    }
    const nom = String(nombre).trim();
    const ced = String(cedula).trim();
    const mail = String(email).trim().toLowerCase();
    const w = String(whatsapp).trim().replace(/\D/g, '');
    if (nom.length < 3 || nom.length > 80) {
      return res.status(400).json({ mensaje: 'El nombre debe tener entre 3 y 80 caracteres.' });
    }
    if (!/^\d{6,12}$/.test(ced)) {
      return res.status(400).json({ mensaje: 'La cédula debe tener solo dígitos (6 a 12).' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail) || mail.length > 120) {
      return res.status(400).json({ mensaje: 'El email no es válido.' });
    }
    if (!/^\d{7,15}$/.test(w)) {
      return res.status(400).json({ mensaje: 'El WhatsApp debe tener solo dígitos (7 a 15).' });
    }
    const existe = db.prepare('SELECT id FROM usuarios WHERE cedula = ? OR email = ?').get(ced, mail);
    if (existe) return res.status(409).json({ mensaje: 'La cédula o el email ya están registrados.' });

    const temporal = passwordTemporal();
    const password_hash = await bcrypt.hash(temporal, 10);
    // El UUID lo genera el servidor: lo que mande el cliente se ignora.
    const info = db
      .prepare(
        `INSERT INTO usuarios (uuid, nombre, cedula, email, password_hash, rol, whatsapp, estado_pago, monto_abonado, saldo_pendiente, password_temporal)
         VALUES (?, ?, ?, ?, ?, 'usuario', ?, 'no_pago', 0, ?, 1)`
      )
      .run(crypto.randomUUID(), nom, ced, mail, password_hash, w, montoInscripcion());

    const usuario = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(info.lastInsertRowid);
    res.status(201).json({
      mensaje: `Usuario "${nom}" registrado. Comparte su clave temporal para que ingrese.`,
      usuario: usuarioPublico(usuario),
      password_temporal: temporal,
    });
  })
);

// ---------------------------------------------------------
// Listado (admin y moderador)
// ---------------------------------------------------------
router.get(
  '/',
  requireRole('admin', 'moderador'),
  ah(async (req, res) => {
    const filas = db.prepare(`${SQL_USUARIO_DETALLE} ORDER BY u.created_at DESC, u.id DESC`).all();
    res.json(filas.map(usuarioPublico));
  })
);

// ---------------------------------------------------------
// Ficha de un usuario (admin y moderador) → modal de datos
// ---------------------------------------------------------
router.get(
  '/:id',
  requireRole('admin', 'moderador'),
  ah(async (req, res) => {
    const id = Number(req.params.id);
    const usuario = db.prepare(`${SQL_USUARIO_DETALLE} WHERE u.id = ?`).get(id);
    if (!usuario) return res.status(404).json({ mensaje: 'Usuario no encontrado.' });

    const completada = db.prepare('SELECT completada_en FROM encuestas_completadas WHERE usuario_id = ?').get(id);
    const respuestas = db
      .prepare(
        `SELECT r.pregunta_id, r.respuesta, p.texto AS pregunta_texto, p.tipo
         FROM respuestas_encuesta r
         JOIN preguntas_encuesta p ON p.id = r.pregunta_id
         WHERE r.usuario_id = ?
         ORDER BY p.orden, p.id`
      )
      .all(id);
    const soportes = db
      .prepare(
        'SELECT id, monto_reportado, tipo, estado, created_at FROM soportes_pago WHERE usuario_id = ? ORDER BY created_at DESC, id DESC'
      )
      .all(id);

    res.json({
      usuario: usuarioPublico(usuario),
      acompanantes: acompanantesDe(id),
      combo: { ...comboEstado(id), completado: comboEstado(id).completado || !!usuario.combo_completado },
      encuesta: {
        completada: !!completada,
        completada_en: completada ? completada.completada_en : null,
        respuestas: respuestas.map((r) => ({ ...r, respuesta: textoRespuesta(r.respuesta) })),
      },
      soportes,
    });
  })
);

// ---------------------------------------------------------
// Editar datos de un usuario (SOLO admin): nombre, cédula, email, whatsapp.
// El rol se cambia en PUT /:id/rol, los montos en PUT /:id/pago,
// la contraseña en PUT /:id/reset-password.
// ---------------------------------------------------------
router.put(
  '/:id',
  requireRole('admin'),
  ah(async (req, res) => {
    const id = Number(req.params.id);
    const usuario = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(id);
    if (!usuario) return res.status(404).json({ mensaje: 'Usuario no encontrado.' });

    const { nombre, cedula, email, whatsapp } = req.body || {};
    const cambios = [];
    const valores = [];

    if (nombre !== undefined) {
      const nom = String(nombre).trim();
      if (nom.length < 3 || nom.length > 80) {
        return res.status(400).json({ mensaje: 'El nombre debe tener entre 3 y 80 caracteres.' });
      }
      cambios.push('nombre = ?');
      valores.push(nom);
    }
    if (cedula !== undefined) {
      const ced = String(cedula).trim();
      if (!/^\d{6,12}$/.test(ced)) {
        return res.status(400).json({ mensaje: 'La cédula debe tener solo dígitos (6 a 12).' });
      }
      const dup = db.prepare('SELECT id FROM usuarios WHERE cedula = ? AND id != ?').get(ced, id);
      if (dup) return res.status(409).json({ mensaje: 'Esa cédula ya está registrada por otro usuario.' });
      cambios.push('cedula = ?');
      valores.push(ced);
    }
    if (email !== undefined) {
      const mail = String(email).trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail) || mail.length > 120) {
        return res.status(400).json({ mensaje: 'El email no es válido.' });
      }
      const dup = db.prepare('SELECT id FROM usuarios WHERE email = ? AND id != ?').get(mail, id);
      if (dup) return res.status(409).json({ mensaje: 'Ese email ya está en uso por otro usuario.' });
      cambios.push('email = ?');
      valores.push(mail);
    }
    if (whatsapp !== undefined) {
      const raw = String(whatsapp).trim();
      const w = raw.replace(/\D/g, '');
      if (raw !== '' && !/^\d{7,15}$/.test(w)) {
        return res.status(400).json({ mensaje: 'El WhatsApp debe tener solo dígitos (7 a 15).' });
      }
      cambios.push('whatsapp = ?');
      valores.push(w);
    }

    if (!cambios.length) return res.status(400).json({ mensaje: 'No hay datos para actualizar.' });

    valores.push(id);
    db.prepare(`UPDATE usuarios SET ${cambios.join(', ')} WHERE id = ?`).run(...valores);
    const actualizado = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(id);
    res.json({ mensaje: 'Usuario actualizado.', usuario: usuarioPublico(actualizado) });
  })
);

// ---------------------------------------------------------
// Editar montos de pago manualmente (SOLO admin)
// ---------------------------------------------------------
router.put(
  '/:id/pago',
  requireRole('admin'),
  ah(async (req, res) => {
    const id = Number(req.params.id);
    const usuario = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(id);
    if (!usuario) return res.status(404).json({ mensaje: 'Usuario no encontrado.' });

    const { monto_abonado, saldo_pendiente } = req.body || {};
    const tope = totalCupo(usuario);
    if (monto_abonado === undefined || isNaN(Number(monto_abonado)) || Number(monto_abonado) < 0) {
      return res.status(400).json({ mensaje: 'Monto abonado inválido.' });
    }
    const abonado = Number(monto_abonado);
    if (abonado > tope) {
      return res.status(400).json({ mensaje: 'El abonado no puede superar el total a pagar.' });
    }
    // Si no llega saldo explícito se deriva del cupo total (incluye acompañantes)
    const saldo =
      saldo_pendiente !== undefined && !isNaN(Number(saldo_pendiente))
        ? Number(saldo_pendiente)
        : Math.max(0, tope - abonado);
    if (saldo < 0 || saldo > tope) {
      return res.status(400).json({ mensaje: 'Saldo pendiente inválido.' });
    }

    db.prepare('UPDATE usuarios SET monto_abonado = ?, saldo_pendiente = ? WHERE id = ?').run(abonado, saldo, id);
    const actualizado = refrescarEstadoPago(id);
    const reserva = actualizado.estado_pago === 'pagado' ? reservarCombo(id) : null;
    res.json({ mensaje: 'Pago actualizado.', usuario: usuarioPublico(actualizado), reserva });
  })
);

// ---------------------------------------------------------
// Validar / no validar pago (admin y moderador)
// ---------------------------------------------------------
router.put(
  '/:id/validar-pago',
  requireRole('admin', 'moderador'),
  ah(async (req, res) => {
    const id = Number(req.params.id);
    const usuario = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(id);
    if (!usuario) return res.status(404).json({ mensaje: 'Usuario no encontrado.' });
    if (usuario.rol !== 'usuario') {
      return res.status(400).json({ mensaje: 'El staff no tiene saldo a pagar.' });
    }

    const valor = req.body && req.body.pago_validado !== undefined ? Number(req.body.pago_validado) : 1;
    db.prepare('UPDATE usuarios SET pago_validado = ? WHERE id = ?').run(valor ? 1 : 0, id);
    const actualizado = refrescarEstadoPago(id);
    res.json({ mensaje: valor ? 'Pago validado.' : 'Validación de pago retirada.', usuario: usuarioPublico(actualizado) });
  })
);

// ---------------------------------------------------------
// Registrar abono manual (admin) → mueve dinero a Caja Inscripción
// ---------------------------------------------------------
router.post(
  '/:id/abono',
  requireRole('admin'),
  ah(async (req, res) => {
    const id = Number(req.params.id);
    const usuario = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(id);
    if (!usuario) return res.status(404).json({ mensaje: 'Usuario no encontrado.' });
    if (usuario.rol !== 'usuario') {
      return res.status(400).json({ mensaje: 'El staff no tiene saldo a pagar.' });
    }

    const monto = Number((req.body || {}).monto);
    const metodo = (req.body && req.body.metodo) || 'efectivo';
    if (isNaN(monto) || monto <= 0) return res.status(400).json({ mensaje: 'El monto debe ser mayor a 0.' });
    if (monto < ABONO_MINIMO && monto < usuario.saldo_pendiente) {
      return res.status(400).json({ mensaje: `El abono mínimo es $${ABONO_MINIMO.toLocaleString('es-CO')}.` });
    }
    if (monto > usuario.saldo_pendiente) return res.status(400).json({ mensaje: 'El monto supera el saldo pendiente.' });

    const tx = db.transaction(() => {
      db.prepare('UPDATE usuarios SET monto_abonado = monto_abonado + ?, saldo_pendiente = MAX(0, saldo_pendiente - ?), pago_validado = 1 WHERE id = ?')
        .run(monto, monto, id);
      refrescarEstadoPago(id);
      registrarMovimientoCaja({
        tipoCaja: 'inscripcion',
        usuarioId: id,
        tipo: 'ingreso',
        concepto: `Abono manual - ${usuario.nombre}`,
        monto,
        metodo,
      });
    });
    tx();

    let reserva = null;
    const trasAbono = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(id);
    if (trasAbono.estado_pago === 'pagado') reserva = reservarCombo(id);

    const actualizado = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(id);
    res.json({ mensaje: 'Abono registrado.', usuario: usuarioPublico(actualizado), reserva });
  })
);

// ---------------------------------------------------------
// Eliminar usuario (SOLO admin). Nunca con pagos registrados:
// lo abonado ya está en caja y borrar rompería la auditoría.
// ---------------------------------------------------------
router.delete(
  '/:id',
  requireRole('admin'),
  ah(async (req, res) => {
    const id = Number(req.params.id);
    const usuario = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(id);
    if (!usuario) return res.status(404).json({ mensaje: 'Usuario no encontrado.' });
    // No dejar el sistema sin administradores (antes que el auto-borrado).
    if (usuario.rol === 'admin' && db.prepare("SELECT COUNT(*) AS n FROM usuarios WHERE rol = 'admin'").get().n <= 1) {
      return res.status(400).json({ mensaje: 'No puedes eliminar al último administrador.' });
    }
    if (id === req.user.id) return res.status(400).json({ mensaje: 'No puedes eliminarte a ti mismo.' });
    // Con dinero registrado no se elimina: lo abonado ya está en Caja
    // Inscripción y borrar rompería la auditoría (el pago fue confirmado).
    if (Number(usuario.monto_abonado || 0) > 0) {
      return res.status(400).json({
        mensaje: `No se puede eliminar a ${usuario.nombre}: tiene pagos registrados en caja.`,
      });
    }

    db.prepare('DELETE FROM usuarios WHERE id = ?').run(id);
    res.json({ mensaje: `Usuario "${usuario.nombre}" eliminado.` });
  })
);

// ---------------------------------------------------------
// Cambiar rol (SOLO admin)
// ---------------------------------------------------------
router.put(
  '/:id/rol',
  requireRole('admin'),
  ah(async (req, res) => {
    const id = Number(req.params.id);
    const { rol } = req.body || {};
    if (!['usuario', 'moderador', 'admin'].includes(rol)) {
      return res.status(400).json({ mensaje: 'Rol inválido.' });
    }
    const usuario = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(id);
    if (!usuario) return res.status(404).json({ mensaje: 'Usuario no encontrado.' });
    // No dejar el sistema sin administradores (antes que el auto-cambio).
    if (usuario.rol === 'admin' && rol !== 'admin' && db.prepare("SELECT COUNT(*) AS n FROM usuarios WHERE rol = 'admin'").get().n <= 1) {
      return res.status(400).json({ mensaje: 'No puedes quitar el rol al último administrador.' });
    }
    if (id === req.user.id && rol !== 'admin') {
      return res.status(400).json({ mensaje: 'No puedes cambiar tu propio rol.' });
    }

    db.prepare('UPDATE usuarios SET rol = ? WHERE id = ?').run(rol, id);
    // El staff no tiene saldo a pagar; al volver a 'usuario' se restaura el cupo base.
    if (rol === 'usuario') {
      const actual = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(id);
      const nAcomp = db.prepare('SELECT COUNT(*) AS n FROM acompanantes WHERE usuario_id = ?').get(id).n;
      if (Number(actual.monto_abonado) === 0 && Number(actual.saldo_pendiente) === 0 && !nAcomp) {
        db.prepare('UPDATE usuarios SET saldo_pendiente = ? WHERE id = ?').run(montoInscripcion(), id);
        refrescarEstadoPago(id);
      }
    } else {
      db.prepare('UPDATE usuarios SET saldo_pendiente = 0, monto_abonado = 0 WHERE id = ?').run(id);
      refrescarEstadoPago(id);
      reservarCombo(id); // el staff también tiene combo (sin pagar suscripción)
    }
    res.json({ mensaje: `Rol actualizado a ${ROTULOS[rol]}.`, usuario: usuarioPublico({ ...usuario, rol }) });
  })
);

// ---------------------------------------------------------
// Resetear contraseña (admin y moderador).
// Devuelve la contraseña temporal para dársela al usuario por WhatsApp.
// El moderador NO puede resetear moderadores ni admin.
// ---------------------------------------------------------
router.put(
  '/:id/reset-password',
  requireRole('admin', 'moderador'),
  ah(async (req, res) => {
    const id = Number(req.params.id);
    const usuario = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(id);
    if (!usuario) return res.status(404).json({ mensaje: 'Usuario no encontrado.' });

    if (req.user.rol === 'moderador' && usuario.rol !== 'usuario') {
      return res.status(403).json({ mensaje: 'Un moderador solo puede resetear contraseñas de usuarios.' });
    }

    const temporal = passwordTemporal();
    const hash = await bcrypt.hash(temporal, 10);
    db.prepare('UPDATE usuarios SET password_hash = ?, password_temporal = 1 WHERE id = ?').run(hash, id);
    // La solicitud pendiente (si hay) queda atendida automáticamente.
    db.prepare(
      `UPDATE solicitudes_recuperacion SET estado = 'atendida', atendida_en = CURRENT_TIMESTAMP, atendida_por = ?
       WHERE usuario_id = ? AND estado = 'pendiente'`
    ).run(req.user.id, id);

    res.json({
      mensaje: `Contraseña temporal generada para ${usuario.nombre}.`,
      password_temporal: temporal,
      usuario: { id: usuario.id, nombre: usuario.nombre, email: usuario.email, whatsapp: usuario.whatsapp || '' },
    });
  })
);

module.exports = router;
