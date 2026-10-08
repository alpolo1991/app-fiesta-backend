# AGENTS.md — Backend (API)

Instrucciones para agentes que trabajen en este repositorio.

## Qué es

API de la **fiesta empresarial de fin de año** (inscripción configurable,
default $50.000 con clave `monto_inscripcion`, abono mínimo $20.000):
inscripción con soporte de pago en imagen, acompañantes (máx 1),
encuesta dinámica, inventario, entregas de combo y **dos cajas separadas**
(inscripción y bebidas), roles ADMIN / MODERADOR / USUARIO. Idioma: español.

## Stack y estructura

Express + better-sqlite3 + JWT + bcrypt + multer + Cloudinary
(+ express-rate-limit, cors, dotenv). SQLite en archivo.

- `src/schema.sql` → creación idempotente (`IF NOT EXISTS`).
- `src/db.js` → abre `fiesta.db` (o `FIESTA_DB_PATH`), ejecuta schema + migraciones.
- `src/seed.js` → siembra si `usuarios` está vacío (`npm run seed`).
  Al arrancar (`src/index.js`) corre solo y deja log: siembra o
  `Seed omitido: ya hay N usuario(s), datos intactos` (nunca borra).
- `src/storage.js` → soportes en Cloudinary (con vars) o disco local.
- `src/index.js` → routers bajo `/api`, CORS por lista, `trust proxy`, SPA fallback.
- `src/helpers.js` → `refrescarEstadoPago`, `reservarCombo`, `registrarMovimientoCaja`,
  `saldoCaja`, `usuarioPublico` (úsalo SIEMPRE al devolver usuarios).
- `src/middleware/auth.js` → `authRequired` + `requireRole(...)`.

## Comandos

```bash
npm install
npm run dev    # :4000 con reload
npm start      # producción
npm test       # 6 suites (node test/run.js), BD temporal por suite
npm run seed   # solo si `usuarios` está vacío
npm run reset  # BORRA fiesta.db* + uploads y re-siembra
```

Variables (`cp .env.example .env`): `JWT_SECRET` (obligatorio en prod), `PORT`,
`FRONTEND_URL` (lista con comas), `FIESTA_DB_PATH` (Render: `/data/fiesta.db`),
`FIESTA_UPLOADS_DIR`, `CLOUDINARY_*` (sin ellas usa disco local).
En pruebas (`test/run.js`): `FIESTA_DB_PATH`, `FIESTA_UPLOADS_DIR`,
`FIESTA_TEST_PORT`/`FIESTA_TEST_URL`. **Nunca** apuntes a datos reales.

## Convenciones

- **RBAC siempre en backend**, no solo en frontend.
- **Acompañantes (máx 1)**: tabla `acompanantes`; montos **fijos** de config
  (`monto_inscripcion` usuario + `monto_acompanante` acompañante, solo admin,
  default 50000); suma `saldo_pendiente`; FIFO con base primero (el abonado
  cubre la inscripción y luego al acompañante). Combo por producto
  (`combo_por_persona`: 4 cervezas + 1 comida; el seed solo trae esos dos,
  el resto los crea el admin para venta extra); al pagar el total se **reserva** (`reservarCombo()`,
  nunca frena dinero). Columnas legacy solo por compatibilidad.
- **Entregas estrictas**: `POST /entregas` tipo `combo` y
  `POST /entregas/:id/completar` exigen `estado_pago === 'pagado'` en rol
  usuario (staff exento); `venta_extra` no se bloquea. El completar solo
  confirma si todo ya fue entregado, nunca fuerza incompletos (la UI ya no
  lo usa, el auto-marcado va en `POST /`).
- Cajas **nunca se suman** y quedan siempre abiertas.
- Aprobar = transacción (montos + estado + Caja Inscripción); sin
  auto-aprobación; rechazar exige `comentario`.
- Subir soporte acepta `usuario_id` (solo staff, solo rol usuario): queda
  `pendiente` igual que si lo subiera él; resto del flujo sin cambios.
- Ventas (`/:id/salida`, admin/mod) acreditan **Caja Bebidas**; ingresos
  (`/:id/ingreso`) y **ajustes** (`/:id/ajuste`, motivo obligatorio) solo admin.
- **Imágenes**: `tamano_max_imagen_mb` (solo admin, hasta 3 MB, default 1);
  multer corta en 3 MB absolutos y la ruta valida el configurado
  (`soportes-pago` y `cuentas-pago/qr`); mensajes con la etiqueta vigente.
- Fechas informativas `fecha_abono` / `fecha_limite_pago` (solo admin,
  `YYYY-MM-DD` o vacío; no bloquean nada, solo las muestra la UI).
- `direccion_evento` (solo admin, texto ≤120) para info y WhatsApp.
- `/auth/recuperar` idéntico exista o no el email; con email crea solicitud
  (`GET /recuperaciones`); el reset la marca atendida.
- Eliminar usuario (solo admin) bloqueado si `monto_abonado > 0`: lo pagado
  ya está en caja y borrar rompería la auditoría.
- Registro manual `POST /usuarios` (admin y moderador): mismos datos y
  validaciones que `/auth/registro`, sin pedir clave (genera temporal,
  cambiarla al ingresar) y la devuelve una sola vez para compartirla.
- Cédula opcional: si no la informan se asigna código interno consecutivo
  `900…` (`siguienteCodigoSinCedula()`); con valor se valida y chequea
  duplicado. El email sigue siendo la llave antiduplicados.
- UUID (`usuarios.uuid`, UNIQUE): lo genera el servidor al crear; lo que
  mande el cliente se ignora y ningún `PUT` lo modifica (ficha solo lectura).
- Tablas nuevas en `schema.sql` + creación en `db.js`; columnas con
  `migrarColumna(...)`; el `SELECT` de `authRequired` es explícito.

## Credenciales (seed)

admin `admin@fiesta.com`/`admin123` · Edwin Roa
`roaruizedwinyesid@gmail.com`/`roa123` (mod) · Isaac Fontalvo
`isaacfontalvo@gmail.com`/`isaac123` (mod) · demo
`demo@fiesta.com`/`demo123` (se elimina en producción).

## Verificación mínima

1. `npm test` → exit 0 (6 suites, BD temporal, requiere `bash`, `curl`, `python3`).
2. Tras pruebas manuales con BD real: `npm run reset` + reiniciar.
