/**
 * /api/inventario
 * - GET    /              → admin/mod: productos + total vendido
 * - POST   /              → admin: crear producto
 * - PUT    /:id           → admin: editar datos (no cantidades)
 * - POST   /:id/ingreso   → admin: sumar stock (registra movimiento)
 * - POST   /:id/salida    → admin/mod: VENTA/salida de stock (descuenta stock
 *                           automáticamente y acredita el monto en la
 *                           Caja de Bebidas)
 * - GET    /movimientos   → admin/mod: historial de movimientos
 */
const express = require('express');
const db = require('../db');
const { authRequired, requireRole } = require('../middleware/auth');
const { ah, registrarMovimientoCaja, saldoCaja, cajaPorTipo } = require('../helpers');

const router = express.Router();
router.use(authRequired, requireRole('admin', 'moderador'));

const CATEGORIAS = ['bebida', 'comida', 'otro'];

function validarProducto(body) {
  const { producto, categoria, precio_unitario, combo_por_persona } = body || {};
  const nom = producto === undefined ? '' : String(producto).trim();
  if (!nom) return 'El nombre del producto es obligatorio.';
  if (nom.length > 80) return 'El nombre del producto no puede superar 80 caracteres.';
  if (!CATEGORIAS.includes(categoria)) return `Categoría inválida. Usa: ${CATEGORIAS.join(', ')}.`;
  if (precio_unitario !== undefined && (isNaN(Number(precio_unitario)) || Number(precio_unitario) < 0 || Number(precio_unitario) > 100000000)) {
    return 'Precio unitario inválido.';
  }
  if (combo_por_persona !== undefined && (!Number.isInteger(Number(combo_por_persona)) || Number(combo_por_persona) < 0 || Number(combo_por_persona) > 100)) {
    return 'La cantidad del combo por persona debe ser un entero entre 0 y 100.';
  }
  return null;
}

router.get(
  '/',
  ah(async (req, res) => {
    const productos = db.prepare('SELECT * FROM inventario ORDER BY categoria, producto').all();
    const totales = db
      .prepare(
        `SELECT COALESCE(SUM(cantidad_disponible),0) AS disponibles,
                COALESCE(SUM(cantidad_entregada),0) AS entregados,
                COALESCE(SUM(cantidad_total),0) AS total
         FROM inventario`
      )
      .get();

    // Monto total vendido (ingresos por ventas registrados en la Caja de Bebidas).
    // vendido_hoy en hora de Colombia: CURRENT_TIMESTAMP es UTC, Bogotá es UTC-5.
    const ventas = db
      .prepare(
        `SELECT COALESCE(SUM(m.monto), 0) AS vendido,
                COALESCE(SUM(CASE WHEN m.created_at >= datetime('now', '-5 hours', 'start of day', '+5 hours') THEN m.monto ELSE 0 END), 0) AS vendido_hoy
         FROM movimientos_caja m
         JOIN cajas c ON c.id = m.caja_id
         WHERE c.tipo = 'bebidas' AND m.tipo = 'ingreso' AND m.concepto LIKE 'Venta%'`
      )
      .get();

    res.json({ productos, totales, vendido: ventas.vendido, vendido_hoy: ventas.vendido_hoy });
  })
);

router.post(
  '/',
  requireRole('admin'),
  ah(async (req, res) => {
    const error = validarProducto(req.body);
    if (error) return res.status(400).json({ mensaje: error });

    const { producto, categoria, cantidad_total = 0, precio_unitario = 0, combo_por_persona = 0 } = req.body;
    const total = Number(cantidad_total) || 0;
    if (!Number.isInteger(total) || total < 0 || total > 1000000) {
      return res.status(400).json({ mensaje: 'La cantidad total debe ser un entero entre 0 y 1000000.' });
    }
    const cpp = Number(combo_por_persona) || 0;

    const tx = db.transaction(() => {
      const info = db
        .prepare(
          `INSERT INTO inventario (producto, categoria, cantidad_total, cantidad_disponible, cantidad_entregada, precio_unitario, es_combo, combo_por_persona)
           VALUES (?, ?, ?, ?, 0, ?, ?, ?)`
        )
        .run(
          String(producto).trim(),
          categoria,
          total,
          total,
          Number(precio_unitario) || 0,
          cpp > 0 ? 1 : 0,
          cpp
        );
      const id = info.lastInsertRowid;
      if (total > 0) {
        db.prepare(
          `INSERT INTO movimientos_inventario (inventario_id, tipo, cantidad, motivo) VALUES (?, 'ingreso', ?, 'Stock inicial')`
        ).run(id, total);
      }
      return id;
    });
    const id = tx();

    res.status(201).json({
      mensaje: 'Producto creado.',
      producto: db.prepare('SELECT * FROM inventario WHERE id = ?').get(id),
    });
  })
);

router.put(
  '/:id',
  requireRole('admin'),
  ah(async (req, res) => {
    const id = Number(req.params.id);
    const producto = db.prepare('SELECT * FROM inventario WHERE id = ?').get(id);
    if (!producto) return res.status(404).json({ mensaje: 'Producto no encontrado.' });

    // Las cantidades no se editan aquí: se usa Ingreso de stock (así queda trazabilidad).
    const body = req.body || {};
    if (body.cantidad_total !== undefined || body.cantidad_disponible !== undefined || body.cantidad_entregada !== undefined) {
      return res.status(400).json({ mensaje: 'Las cantidades no se editan aquí: usa "+ Ingreso" para sumar stock.' });
    }

    const error = validarProducto({ ...producto, ...(req.body || {}) });
    if (error) return res.status(400).json({ mensaje: error });

    const { producto: nombre, categoria, precio_unitario, combo_por_persona } = { ...producto, ...(req.body || {}) };
    const cpp = Number(combo_por_persona) || 0;
    db.prepare(
      'UPDATE inventario SET producto = ?, categoria = ?, precio_unitario = ?, es_combo = ?, combo_por_persona = ? WHERE id = ?'
    ).run(String(nombre).trim(), categoria, Number(precio_unitario) || 0, cpp > 0 ? 1 : 0, cpp, id);

    res.json({
      mensaje: 'Producto actualizado.',
      producto: db.prepare('SELECT * FROM inventario WHERE id = ?').get(id),
    });
  })
);

router.post(
  '/:id/ingreso',
  requireRole('admin'),
  ah(async (req, res) => {
    const id = Number(req.params.id);
    const producto = db.prepare('SELECT * FROM inventario WHERE id = ?').get(id);
    if (!producto) return res.status(404).json({ mensaje: 'Producto no encontrado.' });

    const cantidad = Number((req.body || {}).cantidad);
    const motivo = ((req.body || {}).motivo || 'Ingreso de stock').trim().slice(0, 200);
    if (!Number.isInteger(cantidad) || cantidad <= 0 || cantidad > 1000000) {
      return res.status(400).json({ mensaje: 'La cantidad debe ser un entero entre 1 y 1000000.' });
    }

    const tx = db.transaction(() => {
      db.prepare(
        'UPDATE inventario SET cantidad_total = cantidad_total + ?, cantidad_disponible = cantidad_disponible + ? WHERE id = ?'
      ).run(cantidad, cantidad, id);
      db.prepare(
        `INSERT INTO movimientos_inventario (inventario_id, usuario_id, tipo, cantidad, motivo) VALUES (?, ?, 'ingreso', ?, ?)`
      ).run(id, req.user.id, cantidad, motivo);
    });
    tx();

    res.json({
      mensaje: 'Stock ingresado.',
      producto: db.prepare('SELECT * FROM inventario WHERE id = ?').get(id),
    });
  })
);

/**
 * VENTA / SALIDA de stock (admin y moderador - solo ellos pueden sacar productos).
 * - Valida stock suficiente.
 * - Descuenta `cantidad_disponible` y suma `cantidad_entregada` automáticamente.
 * - Registra el movimiento de salida en el inventario.
 * - Acredita el MONTO vendido en la Caja de Bebidas (precio × cantidad,
 *   salvo que se indique otro monto, ej. un descuento).
 * - Si se indica el usuario comprador, queda también en su historial
 *   de compras (entregas_usuario tipo 'venta_extra').
 */
router.post(
  '/:id/salida',
  ah(async (req, res) => {
    const id = Number(req.params.id);
    const producto = db.prepare('SELECT * FROM inventario WHERE id = ?').get(id);
    if (!producto) return res.status(404).json({ mensaje: 'Producto no encontrado.' });

    const { cantidad, usuario_id, motivo, monto } = req.body || {};
    const cant = Number(cantidad);
    if (!Number.isInteger(cant) || cant <= 0 || cant > 1000000) {
      return res.status(400).json({ mensaje: 'La cantidad debe ser un entero entre 1 y 1000000.' });
    }
    if (producto.cantidad_disponible < cant) {
      return res
        .status(400)
        .json({ mensaje: `Solo hay ${producto.cantidad_disponible} unidad(es) de ${producto.producto} disponibles.` });
    }

    // Comprador opcional (si se indica, debe existir)
    let comprador = null;
    if (usuario_id) {
      comprador = db.prepare('SELECT id, nombre FROM usuarios WHERE id = ?').get(Number(usuario_id));
      if (!comprador) return res.status(404).json({ mensaje: 'Usuario comprador no encontrado.' });
    }

    // Monto de la venta: precio × cantidad, salvo que llegue uno explícito.
    // Cortesía ($0): exige motivo para que quede rastro en el inventario.
    const motivoTxt = motivo !== undefined && motivo !== null ? String(motivo).trim().slice(0, 200) : '';
    const montoVenta = monto !== undefined && monto !== null && monto !== '' ? Number(monto) : producto.precio_unitario * cant;
    if (isNaN(montoVenta) || montoVenta < 0 || montoVenta > 100000000) {
      return res.status(400).json({ mensaje: 'El monto de la venta es inválido.' });
    }
    if (montoVenta === 0 && !motivoTxt) {
      return res.status(400).json({ mensaje: 'La cortesía ($0) exige un motivo (ej: premio o degustación).' });
    }

    const concepto = `Venta - ${producto.producto} x${cant}${comprador ? ` (${comprador.nombre})` : ''}`;

    const tx = db.transaction(() => {
      // 1) Actualizar stock automáticamente
      db.prepare(
        `UPDATE inventario SET cantidad_disponible = MAX(0, cantidad_disponible - ?),
         cantidad_entregada = cantidad_entregada + ? WHERE id = ?`
      ).run(cant, cant, id);

      // 2) Movimiento de salida en el inventario
      db.prepare(
        `INSERT INTO movimientos_inventario (inventario_id, usuario_id, tipo, cantidad, motivo)
         VALUES (?, ?, 'salida', ?, ?)`
      ).run(id, comprador ? comprador.id : req.user.id, cant, motivoTxt || concepto);

      // 3) Historial de compra del usuario (opcional)
      if (comprador) {
        db.prepare(
          `INSERT INTO entregas_usuario (usuario_id, inventario_id, cantidad, tipo, entregado_por)
           VALUES (?, ?, ?, 'venta_extra', ?)`
        ).run(comprador.id, id, cant, req.user.id);
      }

      // 4) Acreditar el monto vendido en la Caja de Bebidas
      let movimiento = null;
      if (montoVenta > 0) {
        movimiento = registrarMovimientoCaja({
          tipoCaja: 'bebidas',
          usuarioId: comprador ? comprador.id : req.user.id,
          tipo: 'ingreso',
          concepto,
          monto: montoVenta,
          metodo: 'efectivo',
        });
      }
      return movimiento;
    });

    let movimientoCaja = null;
    try {
      movimientoCaja = tx();
    } catch (e) {
      return res.status(400).json({ mensaje: e.message });
    }

    const cajaBebidas = cajaPorTipo('bebidas');
    res.status(201).json({
      mensaje: `Venta registrada: ${cant} × ${producto.producto} por ${montoVenta.toLocaleString('es-CO')}.`,
      producto: db.prepare('SELECT * FROM inventario WHERE id = ?').get(id),
      venta: { cantidad: cant, monto: montoVenta, concepto },
      movimiento_caja: movimientoCaja,
      caja_bebidas: cajaBebidas ? saldoCaja(cajaBebidas.id) : null,
    });
  })
);

/**
 * AJUSTE de stock (SOLO admin): fija el disponible (y opcionalmente el total)
 * con motivo obligatorio. Es para iniciar/corregir el stock según reservas;
 * NO mueve cajas (no es venta). Queda en el historial como tipo 'ajuste'.
 */
router.post(
  '/:id/ajuste',
  requireRole('admin'),
  ah(async (req, res) => {
    const id = Number(req.params.id);
    const producto = db.prepare('SELECT * FROM inventario WHERE id = ?').get(id);
    if (!producto) return res.status(404).json({ mensaje: 'Producto no encontrado.' });

    const { cantidad_disponible, cantidad_total, motivo } = req.body || {};
    const disp = Number(cantidad_disponible);
    if (!Number.isInteger(disp) || disp < 0 || disp > 1000000) {
      return res.status(400).json({ mensaje: 'El disponible debe ser un entero entre 0 y 1000000.' });
    }
    let total = Number(producto.cantidad_total);
    if (cantidad_total !== undefined && cantidad_total !== null && cantidad_total !== '') {
      total = Number(cantidad_total);
      if (!Number.isInteger(total) || total < 0 || total > 1000000) {
        return res.status(400).json({ mensaje: 'El total debe ser un entero entre 0 y 1000000.' });
      }
      if (total < disp) {
        return res.status(400).json({ mensaje: 'El total no puede ser menor que el disponible.' });
      }
    } else {
      total = Math.max(total, disp);
    }
    const motivoTxt = String(motivo || '').trim().slice(0, 200);
    if (!motivoTxt) return res.status(400).json({ mensaje: 'El motivo del ajuste es obligatorio.' });
    if (disp === Number(producto.cantidad_disponible) && total === Number(producto.cantidad_total)) {
      return res.status(400).json({ mensaje: 'Sin cambios: el stock ya tiene esos valores.' });
    }

    const delta = Math.abs(disp - Number(producto.cantidad_disponible));
    const tx = db.transaction(() => {
      db.prepare('UPDATE inventario SET cantidad_disponible = ?, cantidad_total = ? WHERE id = ?').run(
        disp,
        total,
        id
      );
      db.prepare(
        `INSERT INTO movimientos_inventario (inventario_id, usuario_id, tipo, cantidad, motivo)
         VALUES (?, ?, 'ajuste', ?, ?)`
      ).run(id, req.user.id, delta, `Ajuste de stock: ${motivoTxt}`);
    });
    tx();

    res.json({
      mensaje: `Stock ajustado: ${producto.producto} ahora tiene ${disp} disponible(s).`,
      producto: db.prepare('SELECT * FROM inventario WHERE id = ?').get(id),
    });
  })
);

router.get(
  '/movimientos',
  ah(async (req, res) => {
    const movimientos = db
      .prepare(
        `SELECT m.*, i.producto, u.nombre AS usuario_nombre
         FROM movimientos_inventario m
         JOIN inventario i ON i.id = m.inventario_id
         LEFT JOIN usuarios u ON u.id = m.usuario_id
         ORDER BY m.created_at DESC, m.id DESC
         LIMIT 500`
      )
      .all();
    res.json(movimientos);
  })
);

module.exports = router;
