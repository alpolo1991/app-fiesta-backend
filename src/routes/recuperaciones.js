/**
 * /api/recuperaciones
 * - GET / → solicitudes de recuperación pendientes. El admin ve todo;
 *           el moderador ve las de usuarios + admin (nunca de otros mods,
 *           y sin emails ajenos). Al resetear, la solicitud se atiende sola.
 * Al resetear la contraseña (PUT /usuarios/:id/reset-password) la
 * solicitud pendiente se marca atendida automáticamente.
 */
const express = require('express');
const db = require('../db');
const { authRequired, requireRole } = require('../middleware/auth');
const { ah } = require('../helpers');

const router = express.Router();
router.use(authRequired, requireRole('admin', 'moderador'));

router.get(
  '/',
  ah(async (req, res) => {
    const esMod = req.user.rol === 'moderador';
    const filtroRol = esMod ? "AND u.rol IN ('usuario', 'admin')" : '';
    const filas = db
      .prepare(
        `SELECT s.id, s.usuario_id, s.email, s.created_at,
                u.nombre AS usuario_nombre, u.cedula AS usuario_cedula,
                u.email AS usuario_email, u.whatsapp AS usuario_whatsapp, u.rol AS usuario_rol
         FROM solicitudes_recuperacion s
         JOIN usuarios u ON u.id = s.usuario_id
         WHERE s.estado = 'pendiente' ${filtroRol}
         ORDER BY s.created_at ASC, s.id ASC`
      )
      .all();
    // Al moderador no se le muestran emails ajenos.
    const lista = esMod
      ? filas.map((f) => ({ ...f, email: null, usuario_email: null }))
      : filas;
    res.json({ cantidad: lista.length, solicitudes: lista });
  })
);

module.exports = router;
