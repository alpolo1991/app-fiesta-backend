/**
 * /api/recuperaciones
 * - GET / → admin/mod: solicitudes de recuperación pendientes
 *           (el moderador solo ve las de rol 'usuario').
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
    const soloUsuarios = req.user.rol === 'moderador' ? 'AND u.rol = ?' : '';
    const params = req.user.rol === 'moderador' ? ['usuario'] : [];
    const filas = db
      .prepare(
        `SELECT s.id, s.usuario_id, s.email, s.created_at,
                u.nombre AS usuario_nombre, u.cedula AS usuario_cedula,
                u.email AS usuario_email, u.whatsapp AS usuario_whatsapp, u.rol AS usuario_rol
         FROM solicitudes_recuperacion s
         JOIN usuarios u ON u.id = s.usuario_id
         WHERE s.estado = 'pendiente' ${soloUsuarios}
         ORDER BY s.created_at ASC, s.id ASC`
      )
      .all(...params);
    res.json({ cantidad: filas.length, solicitudes: filas });
  })
);

module.exports = router;
