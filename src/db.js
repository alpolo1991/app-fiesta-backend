/**
 * Conexión a la base de datos SQLite (fiesta.db).
 * - Se crea el archivo automáticamente si no existe.
 * - Se ejecuta el script schema.sql (idempotente: usa IF NOT EXISTS).
 * - Se activan las claves foráneas.
 */
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

// En pruebas (npm test) se usa una BD temporal vía FIESTA_DB_PATH.
const DB_PATH = process.env.FIESTA_DB_PATH || path.join(__dirname, '..', 'fiesta.db'); // server/fiesta.db

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Creación de tablas (script SQL entregable)
const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

// ------------------------------------------------------------
// Migraciones para bases de datos creadas con versiones previas:
// schema.sql solo crea tablas nuevas (IF NOT EXISTS), así que las
// columnas agregadas después se añaden aquí de forma idempotente.
// ------------------------------------------------------------
function migrarColumna(tabla, columna, definicion) {
  const columnas = db.prepare(`PRAGMA table_info(${tabla})`).all().map((c) => c.name);
  if (!columnas.includes(columna)) {
    db.exec(`ALTER TABLE ${tabla} ADD COLUMN ${columna} ${definicion}`);
    console.log(`⚙️  Migración: ${tabla}.${columna}`);
  }
}

migrarColumna('usuarios', 'acompanante_nombre', 'TEXT');
migrarColumna('usuarios', 'acompanante_monto', 'REAL NOT NULL DEFAULT 0');
migrarColumna('preguntas_encuesta', 'es_acompanante', 'INTEGER NOT NULL DEFAULT 0');
migrarColumna('cuentas_pago', 'qr', 'TEXT');
migrarColumna('inventario', 'cantidad_reservada', 'INTEGER NOT NULL DEFAULT 0');
migrarColumna('inventario', 'combo_por_persona', 'INTEGER NOT NULL DEFAULT 0');
migrarColumna('usuarios', 'combo_reservado', 'INTEGER NOT NULL DEFAULT 0');

// Combo por producto: los marcados como combo sin cantidad heredan la base
// (Cerveza 3, Comida 1). Torta/Gaseosa los define el admin al crearlos.
try {
  db.prepare(
    `UPDATE inventario SET combo_por_persona = 3
     WHERE es_combo = 1 AND combo_por_persona = 0 AND LOWER(producto) LIKE '%cerveza%'`
  ).run();
  db.prepare(
    `UPDATE inventario SET combo_por_persona = 1
     WHERE es_combo = 1 AND combo_por_persona = 0 AND LOWER(producto) LIKE '%comida%'`
  ).run();
} catch (e) {
  /* tabla recién creada, nada que migrar */
}

// Tabla de acompañantes (múltiples por usuario, máx 4).
// Migra el acompañante único legacy (columnas de usuarios) una sola vez.
try {
  db.exec(
    `CREATE TABLE IF NOT EXISTS acompanantes (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      usuario_id  INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
      nombre      TEXT NOT NULL,
      monto       REAL NOT NULL,
      created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`
  );
  db.exec(`CREATE INDEX IF NOT EXISTS idx_acompanantes_usuario ON acompanantes(usuario_id)`);
  const legacy = db
    .prepare(
      `SELECT id, acompanante_nombre, acompanante_monto FROM usuarios
       WHERE (acompanante_nombre IS NOT NULL AND TRIM(acompanante_nombre) != '')
          OR acompanante_monto > 0`
    )
    .all();
  const ins = db.prepare('INSERT INTO acompanantes (usuario_id, nombre, monto) VALUES (?, ?, ?)');
  const yaMigrado = (uid) => db.prepare('SELECT COUNT(*) AS n FROM acompanantes WHERE usuario_id = ?').get(uid).n > 0;
  legacy.forEach((u) => {
    if (!yaMigrado(u.id)) ins.run(u.id, u.acompanante_nombre || 'Acompañante', Number(u.acompanante_monto) || 0);
  });
} catch (e) {
  console.error('Migración acompañantes:', e.message);
}

// El flag es_acompanante quedó en desuso: los acompañantes viven en el menú
// Acompañantes. Se apaga en BD existentes para que la encuesta sea normal.
try {
  db.prepare('UPDATE preguntas_encuesta SET es_acompanante = 0 WHERE es_acompanante = 1').run();
} catch (e) {
  /* tabla recién creada, nada que hacer */
}

// Claves de configuración agregadas después del seed inicial.
// Se insertan vacías/por defecto sin pisar valores ya personalizados.
const CONFIG_DEFAULTS = {
  monto_acompanante: '50000',
  nombre_admin: 'Administrador',
  nombre_moderador: 'Moderador',
  hora_evento: '19:00',
};
try {
  const ins = db.prepare(
    `INSERT INTO configuracion (clave, valor) VALUES (?, ?)
     ON CONFLICT(clave) DO NOTHING`
  );
  for (const [clave, valor] of Object.entries(CONFIG_DEFAULTS)) ins.run(clave, valor);
  // fecha_evento legacy "Por definir" (texto libre) → vacío para el input de fecha.
  const f = db.prepare("SELECT valor FROM configuracion WHERE clave = 'fecha_evento'").get();
  if (f && !/^\d{4}-\d{2}-\d{2}$/.test(String(f.valor || ''))) {
    db.prepare("UPDATE configuracion SET valor = '' WHERE clave = 'fecha_evento'").run();
  } else if (!f) {
    ins.run('fecha_evento', '');
  }
} catch (e) {
  /* tabla recién creada, el seed la llenará */
}

// El staff (admin/moderador) no tiene saldo a pagar: siempre en cero.
// Solo los usuarios con rol 'usuario' entran en Por cobrar/Recaudado.
try {
  db.prepare(
    `UPDATE usuarios SET saldo_pendiente = 0, monto_abonado = 0
     WHERE rol IN ('admin', 'moderador') AND (saldo_pendiente != 0 OR monto_abonado != 0)`
  ).run();
} catch (e) {
  /* tabla recién creada, nada que migrar */
}

// Sin cierre de cajas: todo queda abierto y auditado por fecha.
try {
  db.prepare("UPDATE cajas SET estado = 'abierta' WHERE estado != 'abierta'").run();
} catch (e) {
  /* tabla recién creada, nada que migrar */
}

// El combo de cada acompañante (+3 cervezas, +1 comida) se otorga solo cuando
// el usuario ya pagó su parte (abonado acumulado cubre sus montos, en orden).
// Nivela una sola vez las filas que ya cumplen la condición (solo aumenta).
try {
  const usuarios = db
    .prepare(
      `SELECT u.id, u.monto_abonado, u.combo_cervezas_asignadas, u.combo_comidas_asignadas,
              COALESCE((SELECT SUM(monto) FROM acompanantes a WHERE a.usuario_id = u.id), 0) AS total_acomp,
              (SELECT COUNT(*) FROM acompanantes a WHERE a.usuario_id = u.id) AS n_acomp
       FROM usuarios u WHERE u.rol = 'usuario' AND EXISTS (SELECT 1 FROM acompanantes a WHERE a.usuario_id = u.id)`
    )
    .all();
  const pagadosDe = (uid, abonado) => {
    const filas = db.prepare('SELECT monto FROM acompanantes WHERE usuario_id = ? ORDER BY id').all(uid);
    const disponible = Math.max(0, Number(abonado || 0) - 50000); // base primero
    let cubierto = 0;
    let k = 0;
    for (const f of filas) {
      if (disponible >= cubierto + Number(f.monto)) {
        cubierto += Number(f.monto);
        k += 1;
      } else break;
    }
    return k;
  };
  const upd = db.prepare(
    `UPDATE usuarios SET combo_cervezas_asignadas = ?, combo_comidas_asignadas = ? WHERE id = ?`
  );
  usuarios.forEach((u) => {
    const k = pagadosDe(u.id, u.monto_abonado);
    const objCerv = 3 + 3 * k;
    const objCom = 1 + 1 * k;
    if (objCerv > Number(u.combo_cervezas_asignadas) || objCom > Number(u.combo_comidas_asignadas)) {
      upd.run(
        Math.max(objCerv, Number(u.combo_cervezas_asignadas)),
        Math.max(objCom, Number(u.combo_comidas_asignadas)),
        u.id
      );
    }
  });
} catch (e) {
  /* tabla recién creada, nada que migrar */
}

// Reserva el combo de usuarios ya pagados y del staff (una sola vez).
// Nunca frena nada: reserva lo disponible y marca solo si queda completo.
try {
  const pendientes = db
    .prepare(
      `SELECT id, nombre, rol, monto_abonado FROM usuarios
       WHERE combo_reservado = 0 AND (estado_pago = 'pagado' OR rol IN ('admin', 'moderador'))`
    )
    .all();
  const comboProds = db.prepare('SELECT id, producto, combo_por_persona FROM inventario WHERE combo_por_persona > 0 ORDER BY id').all();
  const pagadosDe = (uid, abonado) => {
    const filas = db.prepare('SELECT monto FROM acompanantes WHERE usuario_id = ? ORDER BY id').all(uid);
    const disponible = Math.max(0, Number(abonado || 0) - 50000); // base primero
    let cubierto = 0;
    let k = 0;
    for (const f of filas) {
      if (disponible >= cubierto + Number(f.monto)) {
        cubierto += Number(f.monto);
        k += 1;
      } else break;
    }
    return k;
  };
  const reservar = db.transaction((u) => {
    const persons = u.rol === 'usuario' ? 1 + pagadosDe(u.id, u.monto_abonado) : 1;
    let completa = comboProds.length > 0;
    comboProds.forEach((p) => {
      const need = Number(p.combo_por_persona) * persons;
      const disp = db.prepare('SELECT cantidad_disponible FROM inventario WHERE id = ?').get(p.id).cantidad_disponible;
      const toma = Math.max(0, Math.min(need, Number(disp || 0)));
      if (toma > 0) {
        db.prepare(
          `UPDATE inventario SET cantidad_disponible = cantidad_disponible - ?,
           cantidad_reservada = cantidad_reservada + ? WHERE id = ?`
        ).run(toma, toma, p.id);
        db.prepare(
          `INSERT INTO movimientos_inventario (inventario_id, usuario_id, tipo, cantidad, motivo)
           VALUES (?, ?, 'reserva', ?, ?)`
        ).run(p.id, u.id, toma, `Reserva combo - ${u.nombre}`);
      }
      if (toma < need) completa = false;
    });
    if (completa) db.prepare('UPDATE usuarios SET combo_reservado = 1 WHERE id = ?').run(u.id);
  });
  pendientes.forEach((u) => {
    try {
      reservar(u);
    } catch (e) {
      /* sigue con el siguiente */
    }
  });
} catch (e) {
  /* nada que migrar */
}

module.exports = db;
