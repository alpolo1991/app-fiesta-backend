/**
 * Conexión a la base de datos: SQLite local o Turso (nube).
 * - development/test → SQLite en archivo (better-sqlite3, sync).
 * - production con TURSO_* → Turso remoto (driver `libsql`, API sync
 *   compatible: prepare/get/all/run, transaction, exec).
 * El resto del código no cambia: la interfaz es la misma.
 */
const path = require('path');
const fs = require('fs');
const config = require('./config');

let db;
if (config.USA_TURSO) {
  const Database = require('libsql');
  db = new Database(config.TURSO_DATABASE_URL, { authToken: config.TURSO_AUTH_TOKEN });
  // FK por conexión (best-effort en remoto); journal_mode no aplica en nube.
  try {
    db.pragma('foreign_keys = ON');
  } catch (e) {
    console.error('Aviso Turso (foreign_keys):', e.message);
  }
  // Las filas remotas traen `_metadata` extra: se quita para no filtrarlo
  // en las respuestas de la API (local no lo tiene).
  const preparar = db.prepare.bind(db);
  const limpiar = (fila) => {
    if (fila && typeof fila === 'object' && '_metadata' in fila) delete fila._metadata;
    return fila;
  };
  db.prepare = (sql) => {
    const st = preparar(sql);
    const get = st.get.bind(st);
    const all = st.all.bind(st);
    st.get = (...p) => limpiar(get(...p));
    st.all = (...p) => (all(...p) || []).map(limpiar);
    return st;
  };
} else {
  const Database = require('better-sqlite3');
  // En pruebas (npm test) se usa una BD temporal vía FIESTA_DB_PATH.
  db = new Database(config.DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
}

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
    if (process.env.NODE_ENV !== 'production') console.log(`⚙️  Migración: ${tabla}.${columna}`);
  }
}

migrarColumna('usuarios', 'acompanante_nombre', 'TEXT');
migrarColumna('usuarios', 'acompanante_monto', 'REAL NOT NULL DEFAULT 0');
migrarColumna('preguntas_encuesta', 'es_acompanante', 'INTEGER NOT NULL DEFAULT 0');
migrarColumna('cuentas_pago', 'qr', 'TEXT');
migrarColumna('inventario', 'cantidad_reservada', 'INTEGER NOT NULL DEFAULT 0');
migrarColumna('inventario', 'combo_por_persona', 'INTEGER NOT NULL DEFAULT 0');
migrarColumna('usuarios', 'combo_reservado', 'INTEGER NOT NULL DEFAULT 0');

// UUID único por usuario (generado por el backend, solo lectura).
// En BDs anteriores se agrega y se rellena una sola vez.
migrarColumna('usuarios', 'uuid', 'TEXT');
try {
  const crypto = require('crypto');
  const sinUuid = db.prepare("SELECT id FROM usuarios WHERE uuid IS NULL OR TRIM(uuid) = ''").all();
  const upd = db.prepare('UPDATE usuarios SET uuid = ? WHERE id = ?');
  sinUuid.forEach((u) => upd.run(crypto.randomUUID(), u.id));
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_usuarios_uuid ON usuarios(uuid)');
} catch (e) {
  /* tabla recién creada, nada que migrar */
}

// Combo por producto: los marcados como combo sin cantidad heredan la base
// (Cerveza 4, Comida 1). Torta/Gaseosa los define el admin al crearlos.
try {
  db.prepare(
    `UPDATE inventario SET combo_por_persona = 4
     WHERE es_combo = 1 AND combo_por_persona = 0 AND LOWER(producto) LIKE '%cerveza%'`
  ).run();
  db.prepare(
    `UPDATE inventario SET combo_por_persona = 1
     WHERE es_combo = 1 AND combo_por_persona = 0 AND LOWER(producto) LIKE '%comida%'`
  ).run();
} catch (e) {
  /* tabla recién creada, nada que migrar */
}

// Combo vigente (4 cervezas + 1 comida): aplica a los productos estándar en
// BDs anteriores; Torta/Gaseosa salen del combo (quedan para venta extra).
try {
  db.prepare(
    `UPDATE inventario SET combo_por_persona = 4 WHERE LOWER(producto) LIKE '%cerveza%'`
  ).run();
  db.prepare(
    `UPDATE inventario SET combo_por_persona = 1 WHERE LOWER(producto) LIKE '%comida%'`
  ).run();
  db.prepare(
    `UPDATE inventario SET combo_por_persona = 0
     WHERE LOWER(producto) LIKE '%torta%' OR LOWER(producto) LIKE '%gaseosa%'`
  ).run();
} catch (e) {
  /* tabla recién creada, el seed la llenará */
}

// Tabla de acompañantes (máx 1 por usuario).
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
  monto_inscripcion: '50000',
  tamano_max_imagen_mb: '1',
  nombre_admin: 'Administrador',
  nombre_moderador: 'Edwin Roa',
  hora_evento: '19:00',
  fecha_abono: '',
  fecha_limite_pago: '',
  direccion_evento: '',
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

// El combo de cada acompañante (+4 cervezas, +1 comida) se otorga solo cuando
// el usuario ya pagó su parte (abonado acumulado cubre sus montos, en orden).
// Nivela una sola vez las filas que ya cumplen la condición (solo aumenta).
try {
  const baseInscripcion = (() => {
    try {
      const f = db.prepare("SELECT valor FROM configuracion WHERE clave = 'monto_inscripcion'").get();
      const n = Number(f && f.valor);
      if (!isNaN(n) && n > 0) return Math.round(n);
    } catch (e) { /* tabla aún no creada */ }
    return 50000;
  })();
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
    const disponible = Math.max(0, Number(abonado || 0) - baseInscripcion); // base primero
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
    const objCerv = 4 + 4 * k;
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
  const baseInscripcion2 = (() => {
    try {
      const f = db.prepare("SELECT valor FROM configuracion WHERE clave = 'monto_inscripcion'").get();
      const n = Number(f && f.valor);
      if (!isNaN(n) && n > 0) return Math.round(n);
    } catch (e) { /* tabla aún no creada */ }
    return 50000;
  })();
  const pagadosDe = (uid, abonado) => {
    const filas = db.prepare('SELECT monto FROM acompanantes WHERE usuario_id = ? ORDER BY id').all(uid);
    const disponible = Math.max(0, Number(abonado || 0) - baseInscripcion2); // base primero
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
