/**
 * Rate limiting para rutas sensibles (login y recuperación de contraseña).
 * El backend corre detrás de proxy (Render): index.js fija 'trust proxy' en 1
 * para que req.ip sea la IP real, y aquí se desactiva la validación estricta
 * de express-rate-limit (ya sabemos que hay un proxy de confianza).
 */
const rateLimit = require('express-rate-limit');

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 30, // máximo 30 intentos por IP por ventana
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false },
  message: { mensaje: 'Demasiados intentos. Intenta de nuevo en unos minutos.' },
});

module.exports = { authLimiter };
