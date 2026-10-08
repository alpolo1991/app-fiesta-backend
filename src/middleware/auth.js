/**
 * Autenticación (JWT) y control de roles (RBAC).
 * - authRequired: verifica el token y carga el usuario en req.user.
 * - requireRole(...roles): permite el paso solo a ciertos roles.
 * - firmarToken: crea un JWT con vigencia de 8 horas.
 */
const jwt = require('jsonwebtoken');
const db = require('../db');

const JWT_SECRET = process.env.JWT_SECRET || 'cambia-este-secret-en-produccion';
const JWT_EXPIRES = '8h';

function firmarToken(usuario) {
  return jwt.sign({ id: usuario.id, rol: usuario.rol }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
}

function authRequired(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ mensaje: 'Sesión no iniciada.' });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const usuario = db
      .prepare(
        `SELECT id, uuid, nombre, cedula, email, rol, estado_pago, monto_abonado, saldo_pendiente,
                pago_validado, combo_cervezas_asignadas, combo_comidas_asignadas,
                combo_completado, acompanante_nombre, acompanante_monto,
                whatsapp, password_temporal, created_at
         FROM usuarios WHERE id = ?`
      )
      .get(payload.id);
    if (!usuario) return res.status(401).json({ mensaje: 'Usuario no encontrado.' });
    req.user = usuario;
    next();
  } catch (e) {
    return res.status(401).json({ mensaje: 'Token inválido o expirado.' });
  }
}

/** Solo los roles indicados pueden pasar. Debe usarse después de authRequired. */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ mensaje: 'Sesión no iniciada.' });
    if (!roles.includes(req.user.rol)) {
      return res.status(403).json({ mensaje: 'No tienes permisos para realizar esta acción.' });
    }
    next();
  };
}

module.exports = { authRequired, requireRole, firmarToken, JWT_SECRET };
