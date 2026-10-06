/**
 * /api/cajas
 * - GET  /                      → admin/mod: cajas con saldo calculado
 * - GET  /:tipo/movimientos     → admin/mod: movimientos de una caja
 * - POST /:tipo/movimiento      → admin: ingreso/egreso manual
 *
 * Las cajas siempre están abiertas (sin cierre): todo movimiento queda
 * registrado con su fecha para la auditoría.
 */
const express = require('express');
const db = require('../db');
const { authRequired, requireRole } = require('../middleware/auth');
const { ah, saldoCaja, cajaPorTipo, registrarMovimientoCaja } = require('../helpers');

const router = express.Router();
router.use(authRequired, requireRole('admin', 'moderador'));

const TIPOS = ['inscripcion', 'bebidas'];

router.get(
  '/',
  ah(async (req, res) => {
    const cajas = db.prepare('SELECT * FROM cajas ORDER BY id').all();
    res.json(cajas.map((c) => ({ ...c, ...saldoCaja(c.id) })));
  })
);

router.get(
  '/:tipo/movimientos',
  ah(async (req, res) => {
    const tipo = req.params.tipo;
    if (!TIPOS.includes(tipo)) return res.status(400).json({ mensaje: 'Tipo de caja inválido.' });
    const caja = cajaPorTipo(tipo);
    if (!caja) return res.status(404).json({ mensaje: 'Caja no encontrada.' });

    const movimientos = db
      .prepare(
        `SELECT m.*, u.nombre AS usuario_nombre
         FROM movimientos_caja m
         LEFT JOIN usuarios u ON u.id = m.usuario_id
         WHERE m.caja_id = ?
         ORDER BY m.created_at DESC, m.id DESC`
      )
      .all(caja.id);

    res.json({ caja, saldo: saldoCaja(caja.id), movimientos });
  })
);

router.post(
  '/:tipo/movimiento',
  requireRole('admin'),
  ah(async (req, res) => {
    const tipo = req.params.tipo;
    if (!TIPOS.includes(tipo)) return res.status(400).json({ mensaje: 'Tipo de caja inválido.' });
    const caja = db.prepare('SELECT * FROM cajas WHERE tipo = ? ORDER BY id DESC LIMIT 1').get(tipo);
    if (!caja) return res.status(404).json({ mensaje: 'Caja no encontrada.' });

    const { tipo: tipoMov, concepto, monto, metodo } = req.body || {};
    if (!['ingreso', 'egreso'].includes(tipoMov)) return res.status(400).json({ mensaje: 'Debe ser ingreso o egreso.' });
    const conceptoTxt = concepto !== undefined && concepto !== null ? String(concepto).trim() : '';
    if (!conceptoTxt) return res.status(400).json({ mensaje: 'El concepto es obligatorio.' });
    if (conceptoTxt.length > 200) return res.status(400).json({ mensaje: 'El concepto no puede superar 200 caracteres.' });
    const montoNum = Number(monto);
    if (isNaN(montoNum) || montoNum <= 0 || montoNum > 100000000) {
      return res.status(400).json({ mensaje: 'El monto debe ser mayor a 0 (máximo $100.000.000).' });
    }

    const movimiento = registrarMovimientoCaja({
      tipoCaja: tipo,
      usuarioId: req.user.id,
      tipo: tipoMov,
      concepto: conceptoTxt,
      monto: montoNum,
      metodo: metodo ? String(metodo).trim().slice(0, 30) : null,
    });

    res.status(201).json({ mensaje: 'Movimiento registrado.', movimiento, saldo: saldoCaja(caja.id) });
  })
);

module.exports = router;
