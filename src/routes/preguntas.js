/**
 * /api/preguntas  (CRUD dinámico de la encuesta - admin)
 * GET    /                    → usuarios ven solo activas; admin con ?todas=1 ve todas
 * POST   /                    → crear pregunta (con opciones opcionales)
 * PUT    /:id                 → editar pregunta
 * DELETE /:id                 → eliminar (borra en cascada opciones y respuestas)
 * PUT    /:id/activa          → activar / desactivar
 * POST   /:id/opciones        → agregar opción
 * DELETE /opciones/:id        → eliminar opción
 *
 * (Montado también en /api/opciones para DELETE /api/opciones/:id)
 */
const express = require('express');
const db = require('../db');
const { authRequired, requireRole } = require('../middleware/auth');
const { ah } = require('../helpers');

const TIPOS_VALIDOS = ['multiple', 'unica', 'texto', 'si_no'];
const router = express.Router();
router.use(authRequired);

// Router montado además en /api/opciones (DELETE /api/opciones/:id)
const opcionesRouter = express.Router();
opcionesRouter.use(authRequired, requireRole('admin'));

/** Devuelve la pregunta con sus opciones. */
function conOpciones(pregunta) {
  const opciones = db
    .prepare('SELECT * FROM opciones_pregunta WHERE pregunta_id = ? ORDER BY orden, id')
    .all(pregunta.id);
  return { ...pregunta, opciones };
}

/** Valida los campos de una pregunta (es_acompanante en desuso: siempre 0). */
function validarPregunta(body) {
  const { texto, tipo, max_selecciones, es_obligatoria, orden, activa } = body || {};
  if (!texto || !String(texto).trim()) return 'El texto de la pregunta es obligatorio.';
  if (!TIPOS_VALIDOS.includes(tipo)) return `Tipo inválido. Usa: ${TIPOS_VALIDOS.join(', ')}.`;
  if (max_selecciones !== undefined && (isNaN(Number(max_selecciones)) || Number(max_selecciones) < 0)) {
    return 'max_selecciones debe ser un número mayor o igual a 0.';
  }
  if (es_obligatoria !== undefined && ![0, 1, true, false].includes(es_obligatoria)) return 'es_obligatoria inválido.';
  if (orden !== undefined && isNaN(Number(orden))) return 'orden inválido.';
  if (activa !== undefined && ![0, 1, true, false].includes(activa)) return 'activa inválido.';
  return null;
}

// ---------------------------------------------------------
// Listado
// ---------------------------------------------------------
router.get(
  '/',
  ah(async (req, res) => {
    const verTodas = req.user.rol === 'admin' && req.query.todas === '1';
    const filas = verTodas
      ? db.prepare('SELECT * FROM preguntas_encuesta ORDER BY orden, id').all()
      : db.prepare('SELECT * FROM preguntas_encuesta WHERE activa = 1 ORDER BY orden, id').all();
    res.json(filas.map(conOpciones));
  })
);

// ---------------------------------------------------------
// Crear (admin)
// ---------------------------------------------------------
router.post(
  '/',
  requireRole('admin'),
  ah(async (req, res) => {
    const error = validarPregunta(req.body);
    if (error) return res.status(400).json({ mensaje: error });

    const { texto, tipo, max_selecciones = 0, es_obligatoria = 1, orden = 0, activa = 1, opciones = [] } = req.body;

    const tx = db.transaction(() => {
      const info = db
        .prepare(
          `INSERT INTO preguntas_encuesta (texto, tipo, max_selecciones, es_obligatoria, es_acompanante, orden, activa)
           VALUES (?, ?, ?, ?, 0, ?, ?)`
        )
        .run(
          String(texto).trim(),
          tipo,
          tipo === 'multiple' ? Number(max_selecciones) || 0 : 0,
          es_obligatoria ? 1 : 0,
          Number(orden) || 0,
          activa ? 1 : 0
        );
      const id = info.lastInsertRowid;
      const insertOpcion = db.prepare(
        'INSERT INTO opciones_pregunta (pregunta_id, texto, orden) VALUES (?, ?, ?)'
      );
      opciones.filter((o) => String(o).trim()).forEach((o, i) => insertOpcion.run(id, String(o).trim(), i));
      return id;
    });
    const id = tx();

    res.status(201).json({ mensaje: 'Pregunta creada.', pregunta: conOpciones(db.prepare('SELECT * FROM preguntas_encuesta WHERE id = ?').get(id)) });
  })
);

// ---------------------------------------------------------
// Editar (admin)
// ---------------------------------------------------------
router.put(
  '/:id',
  requireRole('admin'),
  ah(async (req, res) => {
    const id = Number(req.params.id);
    const pregunta = db.prepare('SELECT * FROM preguntas_encuesta WHERE id = ?').get(id);
    if (!pregunta) return res.status(404).json({ mensaje: 'Pregunta no encontrada.' });

    const error = validarPregunta({ ...pregunta, ...(req.body || {}) });
    if (error) return res.status(400).json({ mensaje: error });

    const { texto, tipo, max_selecciones, es_obligatoria, orden, activa } = { ...pregunta, ...(req.body || {}) };
    db.prepare(
      `UPDATE preguntas_encuesta SET texto = ?, tipo = ?, max_selecciones = ?, es_obligatoria = ?, es_acompanante = 0, orden = ?, activa = ?
       WHERE id = ?`
    ).run(
      String(texto).trim(),
      tipo,
      tipo === 'multiple' ? Number(max_selecciones) || 0 : 0,
      es_obligatoria ? 1 : 0,
      Number(orden) || 0,
      activa ? 1 : 0,
      id
    );

    res.json({ mensaje: 'Pregunta actualizada.', pregunta: conOpciones(db.prepare('SELECT * FROM preguntas_encuesta WHERE id = ?').get(id)) });
  })
);

// ---------------------------------------------------------
// Eliminar (admin)
// ---------------------------------------------------------
router.delete(
  '/:id',
  requireRole('admin'),
  ah(async (req, res) => {
    const id = Number(req.params.id);
    const pregunta = db.prepare('SELECT * FROM preguntas_encuesta WHERE id = ?').get(id);
    if (!pregunta) return res.status(404).json({ mensaje: 'Pregunta no encontrada.' });

    db.prepare('DELETE FROM preguntas_encuesta WHERE id = ?').run(id);
    res.json({ mensaje: 'Pregunta eliminada.' });
  })
);

// ---------------------------------------------------------
// Activar / desactivar (admin)
// ---------------------------------------------------------
router.put(
  '/:id/activa',
  requireRole('admin'),
  ah(async (req, res) => {
    const id = Number(req.params.id);
    const pregunta = db.prepare('SELECT * FROM preguntas_encuesta WHERE id = ?').get(id);
    if (!pregunta) return res.status(404).json({ mensaje: 'Pregunta no encontrada.' });

    const valor = req.body && req.body.activa !== undefined ? Number(req.body.activa) : pregunta.activa ? 0 : 1;
    db.prepare('UPDATE preguntas_encuesta SET activa = ? WHERE id = ?').run(valor ? 1 : 0, id);

    res.json({ mensaje: valor ? 'Pregunta activada.' : 'Pregunta desactivada.', activa: valor ? 1 : 0 });
  })
);

// ---------------------------------------------------------
// Opciones (admin)
// ---------------------------------------------------------
router.post(
  '/:id/opciones',
  requireRole('admin'),
  ah(async (req, res) => {
    const id = Number(req.params.id);
    const pregunta = db.prepare('SELECT * FROM preguntas_encuesta WHERE id = ?').get(id);
    if (!pregunta) return res.status(404).json({ mensaje: 'Pregunta no encontrada.' });

    const texto = ((req.body || {}).texto || '').trim();
    if (!texto) return res.status(400).json({ mensaje: 'El texto de la opción es obligatorio.' });

    const maxOrden = db.prepare('SELECT COALESCE(MAX(orden), -1) AS m FROM opciones_pregunta WHERE pregunta_id = ?').get(id).m;
    const info = db
      .prepare('INSERT INTO opciones_pregunta (pregunta_id, texto, orden) VALUES (?, ?, ?)')
      .run(id, texto, maxOrden + 1);

    res.status(201).json({
      mensaje: 'Opción agregada.',
      opcion: db.prepare('SELECT * FROM opciones_pregunta WHERE id = ?').get(info.lastInsertRowid),
    });
  })
);

opcionesRouter.delete(
  '/:id',
  ah(async (req, res) => {
    const id = Number(req.params.id);
    const opcion = db.prepare('SELECT * FROM opciones_pregunta WHERE id = ?').get(id);
    if (!opcion) return res.status(404).json({ mensaje: 'Opción no encontrada.' });

    db.prepare('DELETE FROM opciones_pregunta WHERE id = ?').run(id);
    res.json({ mensaje: 'Opción eliminada.' });
  })
);

module.exports = router;
module.exports.opciones = opcionesRouter;
