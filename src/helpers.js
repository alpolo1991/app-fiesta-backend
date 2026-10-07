/**
 * Helpers compartidos del backend:
 * - Recalcular estado de pago de un usuario.
 * - Registrar movimientos en las cajas (inscripción / bebidas).
 * - Utilidades varias (async handler, validaciones).
 */
const db = require('./db');

/** Envuelve un handler async para pasar errores al middleware de errores de Express. */
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Cupo total de la fiesta por persona (default; configurable vía `monto_inscripcion`). */
const CUPO_TOTAL = 50000;
/** Tamaño máximo de imagen configurable (MB): default 1, rango 0.5–3. */
const TAMANO_MAX_IMAGEN_MB_DEFAULT = 1;
const TAMANO_MAX_IMAGEN_MB_MIN = 0.5;
const TAMANO_MAX_IMAGEN_MB_MAX = 3;
/** Abono mínimo permitido. */
const ABONO_MINIMO = 20000;
/** Combo por persona (el acompañante suma otro combo igual al usuario). */
const COMBO_CERVEZAS = 3;
const COMBO_COMIDAS = 1;

/** Devuelve el estado de pago derivado del monto abonado y el saldo. */
function estadoPorMontos(montoAbonado, saldoPendiente) {
  if (!montoAbonado || montoAbonado <= 0) return 'no_pago';
  return saldoPendiente <= 0 ? 'pagado' : 'abonado';
}

/** Recalcula estado_pago de un usuario a partir de sus montos actuales y devuelve la fila actualizada. */
function refrescarEstadoPago(usuarioId) {
  const u = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(usuarioId);
  if (!u) return null;
  const estado = estadoPorMontos(u.monto_abonado, u.saldo_pendiente);
  db.prepare('UPDATE usuarios SET estado_pago = ? WHERE id = ?').run(estado, usuarioId);
  return db.prepare('SELECT * FROM usuarios WHERE id = ?').get(usuarioId);
}

/**
 * Personas del combo: 1 + acompañantes ya pagados (FIFO). El staff es 1.
 */
function personasCombo(usuarioId) {
  const u = db.prepare('SELECT rol, monto_abonado FROM usuarios WHERE id = ?').get(usuarioId);
  if (!u) return 1;
  if (u.rol !== 'usuario') return 1;
  return 1 + acompanantesPagados(usuarioId, u.monto_abonado).pagados;
}

/** Productos que forman el combo (combo_por_persona > 0). */
function productosCombo() {
  return db
    .prepare('SELECT id, producto, categoria, combo_por_persona, cantidad_disponible FROM inventario WHERE combo_por_persona > 0 ORDER BY id')
    .all();
}

/**
 * Estado del combo por producto: requerido = por_persona × personas,
 * entregado = suma de entregas tipo combo. Sin productos combo definidos,
 * respeta el flag legacy combo_completado.
 */
function comboEstado(usuarioId) {
  const u = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(usuarioId);
  if (!u) return null;
  const persons = personasCombo(usuarioId);
  const prods = productosCombo();
  const items = prods.map((p) => {
    const requerido = Number(p.combo_por_persona) * persons;
    const fila = db
      .prepare(`SELECT COALESCE(SUM(cantidad), 0) AS n FROM entregas_usuario WHERE usuario_id = ? AND inventario_id = ? AND tipo = 'combo'`)
      .get(usuarioId, p.id);
    const entregado = Number(fila.n || 0);
    return {
      inventario_id: p.id,
      producto: p.producto,
      categoria: p.categoria,
      base: Number(p.combo_por_persona),
      requerido,
      entregado,
      faltante: Math.max(0, requerido - entregado),
    };
  });
  const completado = items.length ? items.every((i) => i.faltante === 0) : !!u.combo_completado;
  // Desglose por grupo: lo del cliente (1 persona) vs lo de acompañantes.
  // Las entregas son una sola bolsa: si lo base está completo, lo que falta
  // es del acompañante; si nadie reclamó, se muestra el total.
  const baseCompleto = items.length ? items.every((i) => i.entregado >= Number(i.base || 0)) : false;
  const entregadoTotal = items.reduce((acc, i) => acc + i.entregado, 0);
  const requeridoTotal = items.reduce((acc, i) => acc + i.requerido, 0);
  const cliente = !items.length
    ? 'pendiente'
    : baseCompleto
      ? 'completado'
      : entregadoTotal > 0
        ? 'parcial'
        : 'pendiente';
  const acompanantes =
    persons > 1
      ? {
          personas: persons - 1,
          estado: completado ? 'completado' : baseCompleto ? 'pendiente' : 'en espera',
          faltan: items.reduce((acc, i) => acc + i.faltante, 0),
        }
      : null;
  return {
    persons,
    items,
    completado,
    reservado: !!u.combo_reservado,
    cliente,
    acompanantes,
    entregadoTotal,
    requeridoTotal,
  };
}

/**
 * Reserva el stock del combo al pagarse el total (o al pasar a staff).
 * Descuenta disponible → reservada por producto y deja movimiento 'reserva'.
 * Nunca frena dinero: si falta stock, reserva lo que haya y reporta faltantes.
 * Solo marca combo_reservado cuando queda completo.
 */
function reservarCombo(usuarioId) {
  const u = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(usuarioId);
  if (!u || u.combo_reservado) return { completa: !!u?.combo_reservado, faltantes: [] };
  const est = comboEstado(usuarioId);
  if (!est || !est.items.length) return { completa: false, faltantes: [] };

  const faltantes = [];
  const tx = db.transaction(() => {
    est.items.forEach((it) => {
      if (it.requerido <= 0) return;
      const p = db.prepare('SELECT cantidad_disponible FROM inventario WHERE id = ?').get(it.inventario_id);
      const toma = Math.max(0, Math.min(it.requerido, Number(p.cantidad_disponible || 0)));
      if (toma > 0) {
        db.prepare(
          `UPDATE inventario SET cantidad_disponible = cantidad_disponible - ?,
           cantidad_reservada = cantidad_reservada + ? WHERE id = ?`
        ).run(toma, toma, it.inventario_id);
        db.prepare(
          `INSERT INTO movimientos_inventario (inventario_id, usuario_id, tipo, cantidad, motivo)
           VALUES (?, ?, 'reserva', ?, ?)`
        ).run(it.inventario_id, usuarioId, toma, `Reserva combo - ${u.nombre}`);
      }
      if (toma < it.requerido) faltantes.push({ producto: it.producto, faltan: it.requerido - toma });
    });
    if (!faltantes.length) db.prepare('UPDATE usuarios SET combo_reservado = 1 WHERE id = ?').run(usuarioId);
  });
  tx();
  return { completa: !faltantes.length, faltantes };
}

/**
 * Busca la caja por tipo ('inscripcion' | 'bebidas').
 * Prefiere una caja abierta; si no hay, usa la última creada.
 */
function cajaPorTipo(tipo) {
  return (
    db.prepare("SELECT * FROM cajas WHERE tipo = ? AND estado = 'abierta' ORDER BY id ASC LIMIT 1").get(tipo) ||
    db.prepare('SELECT * FROM cajas WHERE tipo = ? ORDER BY id DESC LIMIT 1').get(tipo)
  );
}

/** Registra un movimiento en la caja indicada. Devuelve el movimiento insertado. */
function registrarMovimientoCaja({ tipoCaja, usuarioId = null, tipo, concepto, monto, metodo = null }) {
  const caja = cajaPorTipo(tipoCaja);
  if (!caja) throw new Error(`No existe la caja "${tipoCaja}"`);
  const info = db
    .prepare(
      `INSERT INTO movimientos_caja (caja_id, usuario_id, tipo, concepto, monto, metodo)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(caja.id, usuarioId, tipo, concepto, monto, metodo);
  return db.prepare('SELECT * FROM movimientos_caja WHERE id = ?').get(info.lastInsertRowid);
}

/** Saldo actual de una caja = ingresos - egresos. */
function saldoCaja(cajaId) {
  const fila = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN tipo = 'ingreso' THEN monto ELSE 0 END), 0) AS ingresos,
         COALESCE(SUM(CASE WHEN tipo = 'egreso' THEN monto ELSE 0 END), 0) AS egresos
       FROM movimientos_caja WHERE caja_id = ?`
    )
    .get(cajaId);
  return { ingresos: fila.ingresos, egresos: fila.egresos, saldo: fila.ingresos - fila.egresos };
}

/** Fila de usuario sin el hash de contraseña. */
function usuarioPublico(u) {
  if (!u) return null;
  const { password_hash, ...resto } = u;
  return resto;
}

/** ¿Una respuesta Sí/No se considera afirmativa? ("Sí", "Si", "sí"). */
function esAfirmativa(valor) {
  return /^s/i.test(String(valor ?? '').trim());
}

/** Monto fijo por acompañante (configurable en tabla configuracion, default 50000). */
function montoAcompanante() {
  try {
    const fila = db.prepare("SELECT valor FROM configuracion WHERE clave = 'monto_acompanante'").get();
    const n = Number(fila && fila.valor);
    if (!isNaN(n) && n > 0) return Math.round(n);
  } catch (e) {
    /* tabla aún no creada */
  }
  return 50000;
}

/** Monto de inscripción por usuario (configurable por admin, default 50000). */
function montoInscripcion() {
  try {
    const fila = db.prepare("SELECT valor FROM configuracion WHERE clave = 'monto_inscripcion'").get();
    const n = Number(fila && fila.valor);
    if (!isNaN(n) && n > 0) return Math.round(n);
  } catch (e) {
    /* tabla aún no creada */
  }
  return CUPO_TOTAL;
}

/** Tamaño máximo de imagen en MB (configurable por admin, default 1, rango 0.5–3). */
function tamanoMaxImagenMB() {
  try {
    const fila = db.prepare("SELECT valor FROM configuracion WHERE clave = 'tamano_max_imagen_mb'").get();
    const n = Number(fila && fila.valor);
    if (!isNaN(n) && n >= TAMANO_MAX_IMAGEN_MB_MIN && n <= TAMANO_MAX_IMAGEN_MB_MAX) return n;
  } catch (e) {
    /* tabla aún no creada */
  }
  return TAMANO_MAX_IMAGEN_MB_DEFAULT;
}

/** Tamaño máximo de imagen en bytes (para multer y validaciones). */
function tamanoMaxImagenBytes() {
  return Math.round(tamanoMaxImagenMB() * 1024 * 1024);
}

/** Etiqueta legible del límite: 1 → "1 MB", 0.5 → "0.5 MB". */
function etiquetaTamanoMax() {
  return `${tamanoMaxImagenMB()} MB`;
}

/** Cupo total de un usuario incluyendo sus acompañantes (máx 1). */
function totalCupo(usuario) {
  const base = montoInscripcion();
  if (!usuario || usuario.id === undefined) return base + Number((usuario && usuario.acompanante_monto) || 0);
  const fila = db
    .prepare('SELECT COALESCE(SUM(monto), 0) AS total FROM acompanantes WHERE usuario_id = ?')
    .get(usuario.id);
  return base + Number(fila.total || 0);
}

/** Máximo de acompañantes por usuario. */
const MAX_ACOMPANANTES = 1;

/** Lista de acompañantes de un usuario + conteo y total. */
function acompanantesDe(usuarioId) {
  const lista = db
    .prepare('SELECT id, usuario_id, nombre, monto, created_at FROM acompanantes WHERE usuario_id = ? ORDER BY id')
    .all(usuarioId);
  const total = lista.reduce((acc, a) => acc + Number(a.monto || 0), 0);
  return { lista, cantidad: lista.length, total };
}

/**
 * ¿Qué acompañantes ya pagó el usuario? FIFO por orden de registro, pero el
 * abonado cubre PRIMERO el cupo base ($50.000): solo el excedente paga
 * acompañantes. Cada ítem lleva su flag `pagado`.
 */
function acompanantesPagados(usuarioId, montoAbonado) {
  const { lista } = acompanantesDe(usuarioId);
  let cubierto = 0;
  const base = montoInscripcion();
  const disponible = Math.max(0, Number(montoAbonado || 0) - base);
  let bloqueado = false;
  const conFlag = lista.map((a) => {
    const pagado = !bloqueado && disponible >= cubierto + Number(a.monto);
    if (pagado) cubierto += Number(a.monto);
    else bloqueado = true;
    return { ...a, pagado };
  });
  const pagados = conFlag.filter((a) => a.pagado).length;
  return { lista: conFlag, cantidad: conFlag.length, pagados };
}

/** Formatea un monto en pesos: 50000 → "$50.000". */
function dineroCol(valor) {
  return `$${Number(valor || 0).toLocaleString('es-CO', { maximumFractionDigits: 0 })}`;
}

/** Objeto acompañante de un usuario (null si no tiene). */
function acompananteDe(u) {
  if (!u || (!u.acompanante_nombre && !Number(u.acompanante_monto))) return null;
  return { nombre: u.acompanante_nombre || '', monto: Number(u.acompanante_monto || 0) };
}

/** Convierte el valor guardado en una respuesta de encuesta a texto legible. */
function textoRespuesta(valor) {
  if (typeof valor !== 'string') return String(valor ?? '');
  const t = valor.trim();
  if (t.startsWith('[')) {
    try {
      const arr = JSON.parse(t);
      if (Array.isArray(arr)) return arr.join(' | ');
    } catch (e) {
      /* no era JSON */
    }
  }
  return t;
}

module.exports = {
  ah,
  CUPO_TOTAL,
  ABONO_MINIMO,
  COMBO_CERVEZAS,
  COMBO_COMIDAS,
  MAX_ACOMPANANTES,
  montoAcompanante,
  montoInscripcion,
  TAMANO_MAX_IMAGEN_MB_DEFAULT,
  TAMANO_MAX_IMAGEN_MB_MIN,
  TAMANO_MAX_IMAGEN_MB_MAX,
  tamanoMaxImagenMB,
  tamanoMaxImagenBytes,
  etiquetaTamanoMax,
  acompanantesDe,
  acompanantesPagados,
  estadoPorMontos,
  refrescarEstadoPago,
  personasCombo,
  productosCombo,
  comboEstado,
  reservarCombo,
  cajaPorTipo,
  registrarMovimientoCaja,
  saldoCaja,
  usuarioPublico,
  esAfirmativa,
  totalCupo,
  dineroCol,
  acompananteDe,
  textoRespuesta,
};
