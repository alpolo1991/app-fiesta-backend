/**
 * /api/dashboard/resumen → indicadores para las tarjetas KPI.
 * Las cajas de inscripción y de bebidas se calculan SIEMPRE por separado
 * (nunca se suman en una sola cifra).
 */
const express = require('express');
const db = require('../db');
const { authRequired, requireRole } = require('../middleware/auth');
const { ah, saldoCaja, cajaPorTipo, comboEstado, acompanantesPagados } = require('../helpers');

const router = express.Router();
router.use(authRequired);

router.get(
  '/resumen',
  requireRole('admin', 'moderador'),
  ah(async (req, res) => {
    const scalar = (sql, ...params) => db.prepare(sql).get(...params) || {};

    // Solo el rol 'usuario' suma en cobros, combos y encuestas.
    // El staff (admin/moderador) tiene saldo 0 y se cuenta aparte.
    const U = `FROM usuarios WHERE rol = 'usuario'`;
    const personal = scalar(`SELECT COUNT(*) AS total ${U}`);
    const pagados = scalar(`SELECT COUNT(*) AS n ${U} AND estado_pago = 'pagado'`).n;
    const abonados = scalar(`SELECT COUNT(*) AS n ${U} AND estado_pago = 'abonado'`).n;
    const noPagados = scalar(`SELECT COUNT(*) AS n ${U} AND estado_pago = 'no_pago'`).n;
    const porCobrar = scalar(`SELECT COALESCE(SUM(saldo_pendiente), 0) AS total ${U}`).total;
    const recaudado = scalar(`SELECT COALESCE(SUM(monto_abonado), 0) AS total ${U}`).total;
    const nAdmins = scalar(`SELECT COUNT(*) AS n FROM usuarios WHERE rol = 'admin'`).n;
    const nMods = scalar(`SELECT COUNT(*) AS n FROM usuarios WHERE rol = 'moderador'`).n;

    // Cajas por separado
    const cajaIns = cajaPorTipo('inscripcion');
    const cajaBeb = cajaPorTipo('bebidas');
    const movIns = cajaIns ? saldoCaja(cajaIns.id) : { ingresos: 0, egresos: 0, saldo: 0 };
    const movBeb = cajaBeb ? saldoCaja(cajaBeb.id) : { ingresos: 0, egresos: 0, saldo: 0 };

    const soportesPendientes = scalar(
      `SELECT COUNT(*) AS n FROM soportes_pago WHERE estado = 'pendiente'`
    ).n;

    const stockBebidas = scalar(
      `SELECT COALESCE(SUM(cantidad_disponible), 0) AS n FROM inventario WHERE categoria = 'bebida'`
    ).n;
    const stockComidas = scalar(
      `SELECT COALESCE(SUM(cantidad_disponible), 0) AS n FROM inventario WHERE categoria = 'comida'`
    ).n;

    // Combos dinámicos (no el flag, que queda stale al pagar acompañantes).
    const idsUsuarios = db.prepare(`SELECT id FROM usuarios WHERE rol = 'usuario'`).all().map((r) => r.id);
    let combosCompletados = 0;
    idsUsuarios.forEach((uid) => {
      if (comboEstado(uid).completado) combosCompletados += 1;
    });
    const combosPendientes = idsUsuarios.length - combosCompletados;
    // El staff también tiene combo para trazabilidad: se cuenta aparte.
    const idsStaff = db.prepare(`SELECT id FROM usuarios WHERE rol IN ('admin', 'moderador')`).all().map((r) => r.id);
    let combosStaffOk = 0;
    idsStaff.forEach((uid) => {
      if (comboEstado(uid).completado) combosStaffOk += 1;
    });
    const combosStaff = { total: idsStaff.length, completados: combosStaffOk };

    // Ganancias generadas: cajas + confirmados (validados y pagados).
    const inscConf = db
      .prepare(
        `SELECT COUNT(*) AS personas, COALESCE(SUM(monto_abonado), 0) AS monto
         FROM usuarios WHERE rol = 'usuario' AND estado_pago = 'pagado' AND pago_validado = 1`
      )
      .get();
    let acompConfCantidad = 0;
    let acompConfMonto = 0;
    let acompPendCantidad = 0;
    let acompPendMonto = 0;
    db.prepare(`SELECT id, monto_abonado FROM usuarios WHERE rol = 'usuario'`)
      .all()
      .forEach((u) => {
        // Pagados FIFO con base primero (ver helpers.acompanantesPagados).
        const calc = acompanantesPagados(u.id, u.monto_abonado);
        calc.lista.forEach((a) => {
          if (a.pagado) {
            acompConfCantidad += 1;
            acompConfMonto += Number(a.monto);
          } else {
            acompPendCantidad += 1;
            acompPendMonto += Number(a.monto);
          }
        });
      });
    // Pago total = lo efectivamente en cajas. El detalle va en sus KPIs.
    const ganancias = {
      cajaInscripcion: movIns.saldo,
      cajaBebidas: movBeb.saldo,
      total: movIns.saldo + movBeb.saldo,
      inscripcionesConfirmadas: inscConf.personas || 0,
      montoInscripciones: inscConf.monto || 0,
      acompanantesConfirmados: acompConfCantidad,
      montoAcompanantes: acompConfMonto,
      acompanantesPorCobrar: acompPendCantidad,
      montoAcompanantesPorCobrar: acompPendMonto,
    };
    const encuestasCompletadas = scalar(
      `SELECT COUNT(*) AS n FROM encuestas_completadas c JOIN usuarios u ON u.id = c.usuario_id WHERE u.rol = 'usuario'`
    ).n;
    const encuestasPendientes = scalar(
      `SELECT COUNT(*) AS n FROM usuarios u WHERE u.rol = 'usuario' AND u.id NOT IN (SELECT usuario_id FROM encuestas_completadas)`
    ).n;

    const acompanantes = scalar(
      `SELECT COUNT(*) AS cantidad, COALESCE(SUM(a.monto), 0) AS total
       FROM acompanantes a JOIN usuarios u ON u.id = a.usuario_id
       WHERE u.rol = 'usuario'`
    );
    const nAcompanantes = acompanantes.cantidad || 0;

    res.json({
      personal: {
        // El acompañante cuenta como persona en el KPI (no tiene combo ni encuesta propios:
        // paga junto con su usuario, por eso pagados/abonados siguen siendo por usuario).
        total: (personal.total || 0) + nAcompanantes,
        usuarios: personal.total || 0,
        acompanantes: nAcompanantes,
        pagados,
        abonados,
        noPagados,
        porCobrar,
        recaudado,
      },
      equipo: { admins: nAdmins || 0, moderadores: nMods || 0 },
      cajaInscripcion: {
        nombre: 'Caja Inscripción',
        caja_id: cajaIns ? cajaIns.id : null,
        estado: cajaIns ? cajaIns.estado : 'sin caja',
        ingresos: movIns.ingresos,
        egresos: movIns.egresos,
        saldo: movIns.saldo,
      },
      cajaBebidas: {
        nombre: 'Caja Bebidas',
        caja_id: cajaBeb ? cajaBeb.id : null,
        estado: cajaBeb ? cajaBeb.estado : 'sin caja',
        ingresos: movBeb.ingresos,
        egresos: movBeb.egresos,
        saldo: movBeb.saldo,
      },
      soportesPendientes,
      stock: { bebidas: stockBebidas, comidas: stockComidas },
      combos: { completados: combosCompletados, pendientes: combosPendientes },
      combosStaff: { total: combosStaff.total || 0, completados: combosStaff.completados || 0 },
      ganancias,
      encuestas: { completadas: encuestasCompletadas, pendientes: encuestasPendientes },
      acompanantes: { cantidad: acompanantes.cantidad || 0, total: acompanantes.total || 0 },
    });
  })
);

module.exports = router;
