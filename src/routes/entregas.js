/**
 * /api/entregas
 * - GET  /usuario/:id          → combo por producto de un usuario
 * - GET  /pendientes           → admin/mod: todos (incluye staff) con progreso
 * - POST /                     → admin/mod: entregar producto del combo o venta extra
 * - POST /:usuario_id/completar → admin/mod: marcar combo como completado
 *
 * El combo se define por producto (inventario.combo_por_persona) y se
 * multiplica por personas (1 + acompañantes pagados; staff = 1).
 */
const express = require('express');
const db = require('../db');
const { authRequired, requireRole } = require('../middleware/auth');
const { ah, cajaPorTipo, registrarMovimientoCaja, usuarioPublico, comboEstado } = require('../helpers');

const router = express.Router();
router.use(authRequired);

// Cualquier usuario logueado puede ver SU propio combo; el resto requiere admin/mod
function esMismoUsuario(req, res, next) {
  if (Number(req.params.id) === req.user.id) return next();
  if (['admin', 'moderador'].includes(req.user.rol)) return next();
  return res.status(403).json({ mensaje: 'No tienes permisos para ver estas entregas.' });
}

// ---------------------------------------------------------
// Entregas de un usuario
// ---------------------------------------------------------
router.get(
  '/usuario/:id',
  esMismoUsuario,
  ah(async (req, res) => {
    const id = Number(req.params.id);
    const usuario = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(id);
    if (!usuario) return res.status(404).json({ mensaje: 'Usuario no encontrado.' });

    const combo = comboEstado(id);
    const entregas = db
      .prepare(
        `SELECT e.*, i.producto, i.precio_unitario
         FROM entregas_usuario e JOIN inventario i ON i.id = e.inventario_id
         WHERE e.usuario_id = ? AND e.tipo = 'combo'
         ORDER BY e.created_at DESC`
      )
      .all(id);
    const extras = db
      .prepare(
        `SELECT e.*, i.producto, i.precio_unitario
         FROM entregas_usuario e JOIN inventario i ON i.id = e.inventario_id
         WHERE e.usuario_id = ? AND e.tipo = 'venta_extra'
         ORDER BY e.created_at DESC`
      )
      .all(id);

    const comboDinamico = combo.items.length ? combo.completado : !!usuario.combo_completado;
    if (!!usuario.combo_completado !== comboDinamico) {
      db.prepare('UPDATE usuarios SET combo_completado = ? WHERE id = ?').run(comboDinamico ? 1 : 0, id);
    }
    res.json({
      usuario: usuarioPublico(usuario),
      combo: { ...combo, completado: comboDinamico },
      entregas,
      ventas_extras: extras,
    });
  })
);

// ---------------------------------------------------------
// Listado con progreso (para /entregas y pestaña Entregas)
// ---------------------------------------------------------
  router.get(
  '/pendientes',
  requireRole('admin', 'moderador'),
  ah(async (req, res) => {
    // Incluye al staff: también tiene combo asignado (3/1) para trazabilidad.
    const usuarios = db
      .prepare(
        `SELECT id, nombre, cedula, email, rol, estado_pago,
                combo_completado, combo_reservado,
                (SELECT COUNT(*) FROM acompanantes a WHERE a.usuario_id = u.id) AS n_acompanantes,
                (SELECT GROUP_CONCAT(a.nombre, ' | ') FROM acompanantes a WHERE a.usuario_id = u.id) AS nombres_acompanantes
         FROM usuarios u
         ORDER BY combo_completado ASC, nombre ASC`
      )
      .all();

    res.json(
      usuarios.map((u) => {
        const combo = comboEstado(u.id);
        // Dinámico (no el flag): al pagar un acompañante el requerido crece y
        // el "completado" viejo queda stale. Se auto-repara al consultar.
        const completado = combo.items.length ? combo.completado : !!u.combo_completado;
        if (!!u.combo_completado !== completado) {
          db.prepare('UPDATE usuarios SET combo_completado = ? WHERE id = ?').run(completado ? 1 : 0, u.id);
          u.combo_completado = completado ? 1 : 0;
        }
        const faltan = combo.items.reduce((acc, i) => acc + i.faltante, 0);
        const entregados = combo.items.reduce((acc, i) => acc + i.entregado, 0);
        return {
          ...u,
          combo_personas: combo.persons,
          combo_items: combo.items,
          combo_cliente: combo.cliente,
          combo_acompanantes: combo.acompanantes,
          combo_total: combo.requeridoTotal,
          combo_reservado: !!u.combo_reservado,
          entregados,
          faltan,
          estado_combo: completado ? 'completado' : entregados === 0 ? 'pendiente' : 'parcial',
        };
      })
    );
  })
);

// ---------------------------------------------------------
// Registrar una entrega
// ---------------------------------------------------------
router.post(
  '/',
  requireRole('admin', 'moderador'),
  ah(async (req, res) => {
    const { usuario_id, inventario_id, cantidad = 1, tipo = 'combo', monto } = req.body || {};        const usuario = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(Number(usuario_id));
    if (!usuario) return res.status(404).json({ mensaje: 'Usuario no encontrado.' });

    const inv = db.prepare('SELECT * FROM inventario WHERE id = ?').get(Number(inventario_id));
    if (!inv) return res.status(404).json({ mensaje: 'Producto no encontrado.' });

    if (!['combo', 'venta_extra'].includes(tipo)) return res.status(400).json({ mensaje: 'Tipo de entrega inválido.' });

    // Cantidad inválida se rechaza (antes se convertía en 1 en silencio).
    const cant = Number(cantidad);
    if (!Number.isInteger(cant) || cant <= 0) {
      return res.status(400).json({ mensaje: 'La cantidad debe ser un número entero mayor a 0.' });
    }
    if (inv.cantidad_disponible < cant) {
      return res.status(400).json({ mensaje: `Solo hay ${inv.cantidad_disponible} unidad(es) de ${inv.producto} disponibles.` });
    }

    // El combo solo entrega productos del combo y hasta lo requerido por persona.
    if (tipo === 'combo') {
      if (!Number(inv.combo_por_persona)) {
        return res.status(400).json({ mensaje: `"${inv.producto}" no forma parte del combo.` });
      }
      const estado = comboEstado(usuario.id);
      const item = (estado.items || []).find((i) => i.inventario_id === inv.id);
      const requerido = item ? item.requerido : 0;
      const entregado = item ? item.entregado : 0;
      if (entregado + cant > requerido) {
        return res.status(400).json({
          mensaje: `${usuario.nombre} solo tiene ${requerido} × ${inv.producto} de combo (ya reclamó ${entregado}).`,
        });
      }
    }

    let movimientoCaja = null;

    const tx = db.transaction(() => {
      // Descontar inventario
      db.prepare(
        `UPDATE inventario SET cantidad_disponible = MAX(0, cantidad_disponible - ?),
         cantidad_entregada = cantidad_entregada + ? WHERE id = ?`
      ).run(cant, cant, inv.id);

      db.prepare(
        `INSERT INTO movimientos_inventario (inventario_id, usuario_id, tipo, cantidad, motivo) VALUES (?, ?, 'salida', ?, ?)`
      ).run(inv.id, usuario.id, cant, tipo === 'combo' ? `Combo entregado a ${usuario.nombre}` : `Venta extra a ${usuario.nombre}`);

      if (tipo === 'combo') {
        db.prepare(
          `INSERT INTO entregas_usuario (usuario_id, inventario_id, cantidad, tipo, entregado_por) VALUES (?, ?, ?, 'combo', ?)`
        ).run(usuario.id, inv.id, cant, req.user.id);

        // Auto-marcar combo completado cuando todo lo requerido fue entregado
        if (comboEstado(usuario.id).completado) {
          db.prepare('UPDATE usuarios SET combo_completado = 1 WHERE id = ?').run(usuario.id);
        }
      } else {
        db.prepare(
          `INSERT INTO entregas_usuario (usuario_id, inventario_id, cantidad, tipo, entregado_por) VALUES (?, ?, ?, 'venta_extra', ?)`
        ).run(usuario.id, inv.id, cant, req.user.id);

        // Venta extra con monto → ingresa a la Caja de Bebidas
        const traeMonto = monto !== undefined && monto !== null && monto !== '';
        const precio = traeMonto ? Number(monto) : inv.precio_unitario * cant;
        if (traeMonto && (isNaN(precio) || precio < 0 || precio > 100000000)) {
          throw new Error('El monto de la venta extra es inválido.');
        }
        if (!isNaN(precio) && precio > 0) {
          movimientoCaja = registrarMovimientoCaja({
            tipoCaja: 'bebidas',
            usuarioId: usuario.id,
            tipo: 'ingreso',
            concepto: `Venta extra - ${inv.producto} x${cant} (${usuario.nombre})`,
            monto: precio,
            metodo: 'efectivo',
          });
        }
      }
    });

    try {
      tx();
    } catch (e) {
      return res.status(400).json({ mensaje: e.message });
    }

    const actualizado = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(usuario.id);
    res.status(201).json({
      mensaje: tipo === 'combo' ? 'Combo entregado.' : 'Venta extra registrada.',
      usuario: usuarioPublico(actualizado),
      movimiento_caja: movimientoCaja,
    });
  })
);

// ---------------------------------------------------------
// Completar combo manualmente
// ---------------------------------------------------------
router.post(
  '/:usuario_id/completar',
  requireRole('admin', 'moderador'),
  ah(async (req, res) => {
    const id = Number(req.params.usuario_id);
    const usuario = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(id);
    if (!usuario) return res.status(404).json({ mensaje: 'Usuario no encontrado.' });

    db.prepare('UPDATE usuarios SET combo_completado = 1 WHERE id = ?').run(id);
    res.json({
      mensaje: `Combo de ${usuario.nombre} marcado como completado.`,
      usuario: usuarioPublico(db.prepare('SELECT * FROM usuarios WHERE id = ?').get(id)),
    });
  })
);

module.exports = router;
