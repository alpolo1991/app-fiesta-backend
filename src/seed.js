/**
 * Seed inicial: admin, moderador y un usuario normal de prueba.
 *   npm run seed   (también se ejecuta solo desde src/index.js)
 *
 * Crea: admin/mod (sin cargo), usuario demo (cupo $50.000), cajas abiertas,
 * cuentas de pago, configuración base, preguntas iniciales (catálogo) e
 * inventario demo del combo (cerveza, comida, gaseosa, torta).
 */
const db = require('./db');
const bcrypt = require('bcrypt');

function seed() {
  const yaHayUsuarios = db.prepare('SELECT COUNT(*) AS n FROM usuarios').get().n > 0;
  if (yaHayUsuarios) return false;

  const tx = db.transaction(() => {
    // ---------- 1. Solo admin y moderador (saldo 0: sin cargo) ----------
    const hash = (pwd) => bcrypt.hashSync(pwd, 10);
    const crypto = require('crypto');
    const insertUsuario = db.prepare(`
      INSERT INTO usuarios (uuid, nombre, cedula, email, password_hash, rol, whatsapp, monto_abonado, saldo_pendiente)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0)
    `);
    insertUsuario.run(crypto.randomUUID(), 'Administrador', '1000000001', 'admin@fiesta.com', hash('admin123'), 'admin', '3133506369');
    insertUsuario.run(crypto.randomUUID(), 'Moderador', '1000000002', 'moderador@fiesta.com', hash('mod123'), 'moderador', '3133506369');
    // Usuario normal de prueba (cupo completo por pagar).
    db.prepare(
      `INSERT INTO usuarios (uuid, nombre, cedula, email, password_hash, rol, whatsapp, monto_abonado, saldo_pendiente)
       VALUES (?, ?, ?, ?, ?, 'usuario', ?, 0, 50000)`
    ).run(crypto.randomUUID(), 'Empleado Ejemplo', '1000000003', 'usuario@fiesta.com', hash('user123'), '3133506369');

    // ---------- 2. Cajas (siempre abiertas al inicio) ----------
    const insertCaja = db.prepare('INSERT INTO cajas (tipo, descripcion, estado) VALUES (?, ?, ?)');
    insertCaja.run('inscripcion', 'Caja de inscripciones (cupo $50.000)', 'abierta');
    insertCaja.run('bebidas', 'Caja de venta de bebidas', 'abierta');

    // ---------- 3. Cuentas de pago ----------
    const insertCuenta = db.prepare(
      'INSERT INTO cuentas_pago (tipo, numero, titular, activa, orden) VALUES (?, ?, ?, 1, ?)'
    );
    insertCuenta.run('daviplata', '3133506369', 'Administrador Fiesta', 1);
    insertCuenta.run('nequi', '3133506369', 'Administrador Fiesta', 2);
    insertCuenta.run('bre-b', '3133506369', 'Administrador Fiesta', 3);

    // ---------- 4. Configuración ----------
    const insertConfig = db.prepare(
      'INSERT INTO configuracion (clave, valor) VALUES (?, ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor'
    );
    insertConfig.run('whatsapp_admin', '3133506369');
    insertConfig.run('whatsapp_moderador', '3133506369');
    insertConfig.run('nombre_admin', 'Administrador');
    insertConfig.run('nombre_moderador', 'Moderador');
    insertConfig.run('monto_acompanante', '50000');
    insertConfig.run('monto_inscripcion', '50000');
    insertConfig.run('tamano_max_imagen_mb', '1');
    insertConfig.run('nombre_evento', 'Fiesta Fin de Año 2026');
    insertConfig.run('lugar_evento', 'Por definir');
    insertConfig.run('fecha_evento', '');
    insertConfig.run('hora_evento', '19:00');

    // ---------- 5. Inventario demo (combo: cerveza, comida, gaseosa, torta) ----------
    const insertInv = db.prepare(`
      INSERT INTO inventario (producto, categoria, cantidad_total, cantidad_disponible, cantidad_entregada, precio_unitario, es_combo, combo_por_persona)
      VALUES (?, ?, ?, ?, 0, ?, 1, ?)
    `);
    const invInicial = (producto, categoria, stock, precio, cpp) => {
      const id = insertInv.run(producto, categoria, stock, stock, precio, cpp).lastInsertRowid;
      db.prepare(
        `INSERT INTO movimientos_inventario (inventario_id, tipo, cantidad, motivo) VALUES (?, 'ingreso', ?, 'Stock inicial')`
      ).run(id, stock);
    };
    invInicial('Cerveza', 'bebida', 300, 5000, 3);
    invInicial('Comida', 'comida', 100, 15000, 1);
    invInicial('Gaseosa', 'bebida', 100, 3000, 1);
    invInicial('Torta', 'comida', 50, 5000, 1);

    // ---------- 6. Preguntas iniciales de la encuesta (catálogo) ----------
    const insertPregunta = db.prepare(`
      INSERT INTO preguntas_encuesta (texto, tipo, max_selecciones, es_obligatoria, orden, activa)
      VALUES (?, ?, ?, ?, ?, 1)
    `);
    const insertOpcion = db.prepare('INSERT INTO opciones_pregunta (pregunta_id, texto, orden) VALUES (?, ?, ?)');

    const p1 = insertPregunta.run('¿Qué tipo de bebida te gusta?', 'multiple', 3, 1, 1).lastInsertRowid;
    ['Cerveza', 'Ron', 'Vodka', 'Aguardiente', 'Tequila', 'Sin alcohol'].forEach((t, i) => insertOpcion.run(p1, t, i));

    const p2 = insertPregunta.run('¿Tienes alguna restricción alimentaria?', 'unica', 0, 1, 2).lastInsertRowid;
    ['Ninguna', 'Vegetariana', 'Vegana', 'Alergia o intolerancia', 'Otra'].forEach((t, i) => insertOpcion.run(p2, t, i));

    const p3 = insertPregunta.run('¿Vas a llevar acompañante?', 'si_no', 0, 1, 3).lastInsertRowid;
    ['Sí', 'No'].forEach((t, i) => insertOpcion.run(p3, t, i));
    // Los acompañantes se gestionan en el menú Acompañantes (máx 1 por usuario),
    // ya no en la encuesta: esta pregunta queda como una más.

    const p4 = insertPregunta.run('¿Cuál es tu música preferida?', 'multiple', 3, 1, 4).lastInsertRowid;
    ['Salsa', 'Reggaetón', 'Vallenato', 'Rock', 'Pop', 'Electrónica', 'Variada'].forEach((t, i) =>
      insertOpcion.run(p4, t, i)
    );

    insertPregunta.run('¿Algo más que quieras comentar?', 'texto', 0, 0, 5);
  });

  tx();
  console.log('✅ Seed ejecutado: base de datos inicializada.');
  return true;
}

module.exports = { seed };

// Ejecución directa: npm run seed
if (require.main === module) {
  seed();
}
