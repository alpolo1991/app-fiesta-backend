/**
 * /api/acompanantes
 * - GET    /mios  → mis acompañantes (cualquier rol ve los suyos)
 * - GET    /      → admin/mod: todos, con datos del usuario
 * - POST   /      → usuario: agrega uno (máx 4, monto fijo de configuración)
 * - DELETE /:id   → el dueño (si aún no está pagado) o admin
 *
 * El precio es fijo (config monto_acompanante) y solo lo modifica el admin.
 * Cada acompañante suma a su saldo y, al pagarse, otorga +3/+1 de combo.
 */
const express = require('express');
const db = require('../db');
const { authRequired, requireRole } = require('../middleware/auth');
const {
  ah,
  CUPO_TOTAL,
  montoAcompanante,
  acompanantesDe,
  acompanantesPagados,
  refrescarEstadoPago,
  MAX_ACOMPANANTES,
} = require('../helpers');

const router = express.Router();
router.use(authRequired);

/** Marca cada acompañante como pagado o no (FIFO, base primero). */
function conPagado(usuarioId, datos) {
  const u = db.prepare('SELECT monto_abonado FROM usuarios WHERE id = ?').get(usuarioId);
  const calc = acompanantesPagados(usuarioId, u?.monto_abonado || 0);
  const porId = Object.fromEntries(calc.lista.map((a) => [a.id, a.pagado]));
  return { ...datos, lista: (datos.lista || []).map((a) => ({ ...a, pagado: !!porId[a.id] })) };
}

// ---------------------------------------------------------
// Mis acompañantes
// ---------------------------------------------------------
router.get(
  '/mios',
  ah(async (req, res) => {
    res.json(conPagado(req.user.id, acompanantesDe(req.user.id)));
  })
);

// ---------------------------------------------------------
// Todos (admin y moderador)
// ---------------------------------------------------------
router.get(
  '/',
  requireRole('admin', 'moderador'),
  ah(async (req, res) => {
    const usuarioId = req.query.usuario_id ? Number(req.query.usuario_id) : null;
    const cond = usuarioId ? 'WHERE a.usuario_id = ?' : '';
    const params = usuarioId ? [usuarioId] : [];
    const filas = db
      .prepare(
        `SELECT a.id, a.usuario_id, a.nombre, a.monto, a.created_at, u.nombre AS usuario_nombre,
                u.monto_abonado AS dueno_abonado
         FROM acompanantes a JOIN usuarios u ON u.id = a.usuario_id
         ${cond}
         ORDER BY a.usuario_id, a.id`
      )
      .all(...params);
    // Flag pagado por dueño (FIFO): se agrupa por usuario en orden.
    const porDueno = {};
    const lista = filas.map((f) => {
      const cub = porDueno[f.usuario_id] || 0;
      const pagado = Number(f.dueno_abonado || 0) >= cub + Number(f.monto);
      porDueno[f.usuario_id] = cub + Number(f.monto);
      const { dueno_abonado, ...resto } = f;
      return { ...resto, pagado };
    });
    // Vista general: lo reciente primero.
    lista.sort((a, b) => b.id - a.id);
    res.json({
      lista,
      cantidad: lista.length,
      total: lista.reduce((acc, f) => acc + Number(f.monto || 0), 0),
    });
  })
);

// ---------------------------------------------------------
// Agregar (solo rol usuario: el staff no tiene saldo a pagar)
// ---------------------------------------------------------
router.post(
  '/',
  requireRole('usuario'),
  ah(async (req, res) => {
    const nombre = String((req.body && req.body.nombre) || '').trim();
    if (!nombre) return res.status(400).json({ mensaje: 'Debes indicar el nombre del acompañante.' });
    if (nombre.length > 80) {
      return res.status(400).json({ mensaje: 'El nombre no puede superar 80 caracteres.' });
    }

    const actual = acompanantesDe(req.user.id);
    if (actual.cantidad >= MAX_ACOMPANANTES) {
      return res.status(400).json({ mensaje: `Máximo ${MAX_ACOMPANANTES} acompañantes por usuario.` });
    }
    if (actual.lista.some((a) => a.nombre.toLowerCase() === nombre.toLowerCase())) {
      return res.status(409).json({ mensaje: 'Ese acompañante ya está registrado.' });
    }

    const monto = montoAcompanante();
    const tx = db.transaction(() => {
      const info = db
        .prepare('INSERT INTO acompanantes (usuario_id, nombre, monto) VALUES (?, ?, ?)')
        .run(req.user.id, nombre, monto);
      db.prepare('UPDATE usuarios SET saldo_pendiente = saldo_pendiente + ? WHERE id = ?').run(monto, req.user.id);
      refrescarEstadoPago(req.user.id);
      return info.lastInsertRowid;
    });
    const id = tx();

    res.status(201).json({
      mensaje: `Acompañante ${nombre} registrado.`,
      acompanante: db.prepare('SELECT * FROM acompanantes WHERE id = ?').get(id),
      ...acompanantesDe(req.user.id),
    });
  })
);

// ---------------------------------------------------------
// Editar nombre (dueño o admin). El monto es fijo y no se toca.
// ---------------------------------------------------------
router.put(
  '/:id',
  ah(async (req, res) => {
    const id = Number(req.params.id);
    const a = db.prepare('SELECT * FROM acompanantes WHERE id = ?').get(id);
    if (!a) return res.status(404).json({ mensaje: 'Acompañante no encontrado.' });

    const esDueno = a.usuario_id === req.user.id;
    const puedeEditar = esDueno || req.user.rol === 'admin' || req.user.rol === 'moderador';
    if (!puedeEditar) {
      return res.status(403).json({ mensaje: 'No tienes permisos para editar este acompañante.' });
    }

    const nombre = String((req.body && req.body.nombre) || '').trim();
    if (!nombre) return res.status(400).json({ mensaje: 'Debes indicar el nombre del acompañante.' });
    if (nombre.length > 80) {
      return res.status(400).json({ mensaje: 'El nombre no puede superar 80 caracteres.' });
    }
    const dup = db
      .prepare('SELECT id FROM acompanantes WHERE usuario_id = ? AND LOWER(nombre) = LOWER(?) AND id != ?')
      .get(a.usuario_id, nombre, id);
    if (dup) return res.status(409).json({ mensaje: 'Ese acompañante ya está registrado.' });

    db.prepare('UPDATE acompanantes SET nombre = ? WHERE id = ?').run(nombre, id);
    res.json({ mensaje: 'Nombre actualizado.', acompanante: db.prepare('SELECT * FROM acompanantes WHERE id = ?').get(id) });
  })
);

// ---------------------------------------------------------
// Eliminar: el dueño solo si aún no está pagado; admin siempre
// que no deje la cuenta en negativo (sin overpay).
// ---------------------------------------------------------
router.delete(
  '/:id',
  ah(async (req, res) => {
    const id = Number(req.params.id);
    const a = db.prepare('SELECT * FROM acompanantes WHERE id = ?').get(id);
    if (!a) return res.status(404).json({ mensaje: 'Acompañante no encontrado.' });

    const esDueno = a.usuario_id === req.user.id;
    const esAdmin = req.user.rol === 'admin';
    const esMod = req.user.rol === 'moderador';
    if (!esDueno && !esAdmin && !esMod) {
      return res.status(403).json({ mensaje: 'No tienes permisos para eliminar este acompañante.' });
    }

    // ¿Está pagado? FIFO con base primero (ver helpers.acompanantesPagados).
    const pagado = acompanantesPagados(a.usuario_id, db.prepare('SELECT monto_abonado FROM usuarios WHERE id = ?').get(a.usuario_id)?.monto_abonado || 0)
      .lista.some((x) => x.id === a.id && x.pagado);
    // El dueño y el mod solo quitan lo no pagado; el admin puede quitar
    // incluso pagado (recalcula el saldo sin dejarlo negativo).
    if (pagado && !esAdmin) {
      return res.status(400).json({ mensaje: 'Ese acompañante ya está pagado y no se puede eliminar.' });
    }

    const tx = db.transaction(() => {
      db.prepare('DELETE FROM acompanantes WHERE id = ?').run(id);
      const u = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(a.usuario_id);
      const restante = db.prepare('SELECT COALESCE(SUM(monto), 0) AS suma FROM acompanantes WHERE usuario_id = ?').get(a.usuario_id).suma;
      const nuevoSaldo = Math.max(0, CUPO_TOTAL + Number(restante || 0) - Number(u.monto_abonado));
      db.prepare('UPDATE usuarios SET saldo_pendiente = ? WHERE id = ?').run(nuevoSaldo, a.usuario_id);
      refrescarEstadoPago(a.usuario_id);
    });
    tx();

    res.json({ mensaje: `Acompañante "${a.nombre}" eliminado.`, ...acompanantesDe(a.usuario_id) });
  })
);

module.exports = router;
