-- ============================================================
-- FIESTA FIN DE AÑO 2026 - Script de creación de base de datos
-- SQLite (fiesta.db)
-- ============================================================

PRAGMA foreign_keys = ON;

-- ------------------------------------------------------------
-- Usuarios (empleados, moderadores y administradores)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS usuarios (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid                      TEXT UNIQUE,                                -- identificador único generado por el backend (solo lectura)
  nombre                    TEXT NOT NULL,
  cedula                    TEXT NOT NULL UNIQUE,
  email                     TEXT NOT NULL COLLATE NOCASE UNIQUE,
  password_hash             TEXT NOT NULL,
  rol                       TEXT NOT NULL DEFAULT 'usuario',      -- 'usuario' | 'moderador' | 'admin'
  estado_pago               TEXT NOT NULL DEFAULT 'no_pago',      -- 'no_pago' | 'abonado' | 'pagado'
  monto_abonado             REAL NOT NULL DEFAULT 0,
  saldo_pendiente           REAL NOT NULL DEFAULT 50000,
  pago_validado             INTEGER NOT NULL DEFAULT 0,
  combo_cervezas_asignadas  INTEGER NOT NULL DEFAULT 4,
  combo_comidas_asignadas   INTEGER NOT NULL DEFAULT 1,
  combo_completado          INTEGER NOT NULL DEFAULT 0,
  combo_reservado           INTEGER NOT NULL DEFAULT 0,         -- 1 = stock del combo ya reservado
  acompanante_nombre        TEXT,                                 -- registrado en la encuesta
  acompanante_monto         REAL NOT NULL DEFAULT 0,               -- se suma al saldo pendiente
  whatsapp                  TEXT,
  password_temporal         INTEGER NOT NULL DEFAULT 0,           -- 1 = debe cambiar la contraseña al ingresar
  created_at                DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ------------------------------------------------------------
-- Acompañantes (hasta 4 por usuario, monto fijo de configuración)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS acompanantes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario_id  INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  nombre      TEXT NOT NULL,
  monto       REAL NOT NULL,                                   -- fijo (config monto_acompanante al crear)
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_acompanantes_usuario ON acompanantes(usuario_id);

-- ------------------------------------------------------------
-- Cajas separadas: inscripción y venta de bebidas
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cajas (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tipo        TEXT NOT NULL UNIQUE,                               -- 'inscripcion' | 'bebidas'
  descripcion TEXT,
  estado      TEXT NOT NULL DEFAULT 'abierta',                    -- 'abierta' | 'cerrada'
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS movimientos_caja (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  caja_id     INTEGER NOT NULL REFERENCES cajas(id) ON DELETE CASCADE,
  usuario_id  INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  tipo        TEXT NOT NULL,                                      -- 'ingreso' | 'egreso'
  concepto    TEXT NOT NULL,
  monto       REAL NOT NULL,
  metodo      TEXT,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_movimientos_caja ON movimientos_caja(caja_id, created_at);

-- ------------------------------------------------------------
-- Cuentas de pago (Daviplata / Nequi / Bre-B) - solo admin edita
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cuentas_pago (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  tipo       TEXT NOT NULL,                                       -- 'daviplata' | 'nequi' | 'bre-b'
  numero     TEXT NOT NULL,
  titular    TEXT NOT NULL,
  qr         TEXT,                                                -- QR de pago (public_id nube o archivo local)
  activa     INTEGER NOT NULL DEFAULT 1,
  orden      INTEGER,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ------------------------------------------------------------
-- Soportes de pago subidos por los usuarios (imágenes)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS soportes_pago (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario_id          INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  archivo             TEXT NOT NULL,
  monto_reportado     REAL NOT NULL,
  tipo                TEXT NOT NULL,                              -- 'abono' | 'pago_total'
  estado              TEXT NOT NULL DEFAULT 'pendiente',          -- 'pendiente' | 'aprobado' | 'rechazado'
  revisado_por        INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  revisado_en         DATETIME,
  comentario_revision TEXT,
  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_soportes_estado ON soportes_pago(estado, created_at);

-- ------------------------------------------------------------
-- Encuesta DINÁMICA (preguntas y opciones administrables)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS preguntas_encuesta (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  texto           TEXT NOT NULL,
  tipo            TEXT NOT NULL,                                  -- 'multiple' | 'unica' | 'texto' | 'si_no'
  max_selecciones INTEGER NOT NULL DEFAULT 0,                     -- 0 = sin límite (solo múltiple)
  es_obligatoria  INTEGER NOT NULL DEFAULT 1,
  es_acompanante  INTEGER NOT NULL DEFAULT 0,                      -- 1 = pide nombre + monto de acompañante
  orden           INTEGER NOT NULL DEFAULT 0,
  activa          INTEGER NOT NULL DEFAULT 1,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS opciones_pregunta (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  pregunta_id INTEGER NOT NULL REFERENCES preguntas_encuesta(id) ON DELETE CASCADE,
  texto       TEXT NOT NULL,
  orden       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_opciones_pregunta ON opciones_pregunta(pregunta_id, orden);

CREATE TABLE IF NOT EXISTS respuestas_encuesta (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario_id  INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  pregunta_id INTEGER NOT NULL REFERENCES preguntas_encuesta(id) ON DELETE CASCADE,
  respuesta   TEXT NOT NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_respuestas_usuario ON respuestas_encuesta(usuario_id);

CREATE TABLE IF NOT EXISTS encuestas_completadas (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario_id    INTEGER NOT NULL UNIQUE REFERENCES usuarios(id) ON DELETE CASCADE,
  completada_en DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ------------------------------------------------------------
-- Inventario (bebidas, comida y otros)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS inventario (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  producto            TEXT NOT NULL,
  categoria           TEXT NOT NULL,                              -- 'bebida' | 'comida' | 'otro'
  cantidad_total      INTEGER NOT NULL DEFAULT 0,
  cantidad_disponible INTEGER NOT NULL DEFAULT 0,
  cantidad_entregada  INTEGER NOT NULL DEFAULT 0,
  cantidad_reservada  INTEGER NOT NULL DEFAULT 0,               -- apartado para combos pagados
  precio_unitario     REAL NOT NULL DEFAULT 0,
  es_combo            INTEGER NOT NULL DEFAULT 0,
  combo_por_persona   INTEGER NOT NULL DEFAULT 0,               -- unidades del combo por persona (0 = no es combo)
  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ------------------------------------------------------------
-- Entregas por persona (combo o venta extra)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS entregas_usuario (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario_id    INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  inventario_id INTEGER NOT NULL REFERENCES inventario(id) ON DELETE CASCADE,
  cantidad      INTEGER NOT NULL DEFAULT 1,
  tipo          TEXT NOT NULL DEFAULT 'combo',                    -- 'combo' | 'venta_extra'
  entregado_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_entregas_usuario ON entregas_usuario(usuario_id);

CREATE TABLE IF NOT EXISTS movimientos_inventario (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  inventario_id INTEGER NOT NULL REFERENCES inventario(id) ON DELETE CASCADE,
  usuario_id    INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  tipo          TEXT NOT NULL,                                    -- 'ingreso' | 'salida'
  cantidad      INTEGER NOT NULL,
  motivo        TEXT,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ------------------------------------------------------------
-- Solicitudes de recuperación de contraseña (notifican al staff)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS solicitudes_recuperacion (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario_id  INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  email       TEXT NOT NULL,
  estado      TEXT NOT NULL DEFAULT 'pendiente',               -- 'pendiente' | 'atendida'
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  atendida_en DATETIME,
  atendida_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_solicitudes_estado ON solicitudes_recuperacion(estado, created_at);

-- ------------------------------------------------------------
-- Configuración clave-valor (WhatsApp, datos del evento, ...)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS configuracion (
  clave      TEXT PRIMARY KEY,
  valor      TEXT,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
