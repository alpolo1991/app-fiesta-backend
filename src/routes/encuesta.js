/**
 * /api/encuesta
 * - POST /           → usuario envía sus respuestas (UNA sola vez)
 * - GET  /mia        → usuario: sus respuestas
 * - GET  /           → admin/mod: respuestas de todos
 * - GET  /exportar   → admin: CSV
 *
 * Las respuestas de tipo "multiple" se guardan como JSON y se
 * serializan como "Opción A | Opción B" al leer/exportar.
 */
const express = require('express');
const db = require('../db');
const { authRequired, requireRole } = require('../middleware/auth');
const { ah, textoRespuesta } = require('../helpers');

const router = express.Router();
router.use(authRequired);

// ---------------------------------------------------------
// Enviar encuesta (usuario, una sola vez)
// ---------------------------------------------------------
router.post(
  '/',
  requireRole('usuario', 'moderador', 'admin'),
  ah(async (req, res) => {
    const yaCompletada = db.prepare('SELECT id FROM encuestas_completadas WHERE usuario_id = ?').get(req.user.id);
    if (yaCompletada) return res.status(400).json({ mensaje: 'Ya has respondido la encuesta.' });

    const enviadas = (req.body && req.body.respuestas) || [];
    if (!Array.isArray(enviadas)) return res.status(400).json({ mensaje: 'Formato de respuestas inválido.' });

    const preguntas = db
      .prepare('SELECT * FROM preguntas_encuesta WHERE activa = 1 ORDER BY orden, id')
      .all();
    if (!preguntas.length) return res.status(400).json({ mensaje: 'La encuesta no tiene preguntas activas.' });

    // Índice de opciones por pregunta
    const opcionesPorPregunta = {};
    db.prepare('SELECT * FROM opciones_pregunta ORDER BY orden, id')
      .all()
      .forEach((o) => {
        opcionesPorPregunta[o.pregunta_id] = opcionesPorPregunta[o.pregunta_id] || [];
        opcionesPorPregunta[o.pregunta_id].push(o.texto);
      });

    // Mapa pregunta_id -> respuesta enviada
    const mapa = {};
    enviadas.forEach((r) => {
      if (r && r.pregunta_id) mapa[Number(r.pregunta_id)] = r.respuesta;
    });

    const errores = [];
    const aGuardar = [];

    preguntas.forEach((p) => {
      const valor = mapa[p.id];
      const opciones = opcionesPorPregunta[p.id] || [];

      const vacio =
        valor === undefined ||
        valor === null ||
        (typeof valor === 'string' && !valor.trim()) ||
        (Array.isArray(valor) && valor.length === 0);

      if (vacio) {
        if (p.es_obligatoria) errores.push(`La pregunta "${p.texto}" es obligatoria.`);
        return;
      }

      if (p.tipo === 'multiple') {
        if (!Array.isArray(valor)) {
          errores.push(`La pregunta "${p.texto}" requiere múltiples opciones.`);
          return;
        }
        if (p.max_selecciones > 0 && valor.length > p.max_selecciones) {
          errores.push(`"${p.texto}" permite máximo ${p.max_selecciones} selecciones.`);
          return;
        }
        const invalidas = valor.filter((v) => !opciones.includes(v));
        if (opciones.length && invalidas.length) {
          errores.push(`Opciones inválidas en "${p.texto}".`);
          return;
        }
        aGuardar.push({ pregunta_id: p.id, respuesta: JSON.stringify(valor) });
      } else if (p.tipo === 'texto') {
        aGuardar.push({ pregunta_id: p.id, respuesta: String(valor).slice(0, 1000) });
      } else {
        // unica | si_no
        if (Array.isArray(valor)) {
          errores.push(`La pregunta "${p.texto}" admite una sola respuesta.`);
          return;
        }
        const respuesta = String(valor).trim();
        if (opciones.length && !opciones.includes(respuesta)) {
          errores.push(`Respuesta inválida en "${p.texto}".`);
          return;
        }
        aGuardar.push({ pregunta_id: p.id, respuesta });
      }
    });

    if (errores.length) return res.status(400).json({ mensaje: errores[0], errores });

    const tx = db.transaction(() => {
      const insert = db.prepare(
        'INSERT INTO respuestas_encuesta (usuario_id, pregunta_id, respuesta) VALUES (?, ?, ?)'
      );
      aGuardar.forEach((r) => insert.run(req.user.id, r.pregunta_id, r.respuesta));

      db.prepare('INSERT OR IGNORE INTO encuestas_completadas (usuario_id) VALUES (?)').run(req.user.id);
    });
    tx();

    res.status(201).json({ mensaje: 'Encuesta enviada. ¡Gracias por participar!' });
  })
);

// ---------------------------------------------------------
// Mis respuestas (usuario)
// ---------------------------------------------------------
router.get(
  '/mia',
  ah(async (req, res) => {
    const completada = db.prepare('SELECT * FROM encuestas_completadas WHERE usuario_id = ?').get(req.user.id);
    const filas = db
      .prepare(
        `SELECT r.pregunta_id, r.respuesta, p.texto AS pregunta_texto, p.tipo
         FROM respuestas_encuesta r
         JOIN preguntas_encuesta p ON p.id = r.pregunta_id
         WHERE r.usuario_id = ?
         ORDER BY p.orden, p.id`
      )
      .all(req.user.id);

    res.json({
      completada: !!completada,
      completada_en: completada ? completada.completada_en : null,
      respuestas: filas.map((f) => ({ ...f, respuesta: textoRespuesta(f.respuesta) })),
    });
  })
);

// ---------------------------------------------------------
// Exportar CSV (SOLO admin)
// ---------------------------------------------------------
router.get(
  '/exportar',
  requireRole('admin'),
  ah(async (req, res) => {
    const preguntas = db.prepare('SELECT * FROM preguntas_encuesta ORDER BY orden, id').all();

    const esc = (v) => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };

    const encabezado = ['Cedula', 'Nombre', 'Email', 'Completada_en', ...preguntas.map((p) => p.texto)].map(esc).join(';');

    const usuarios = db
      .prepare(
        `SELECT u.id, u.cedula, u.nombre, u.email, c.completada_en
         FROM usuarios u
         JOIN encuestas_completadas c ON c.usuario_id = u.id
         ORDER BY u.nombre`
      )
      .all();

    const respuestas = db.prepare('SELECT usuario_id, pregunta_id, respuesta FROM respuestas_encuesta').all();
    const indice = {};
    respuestas.forEach((r) => {
      indice[`${r.usuario_id}-${r.pregunta_id}`] = textoRespuesta(r.respuesta);
    });

    const lineas = usuarios.map((u) =>
      [u.cedula, u.nombre, u.email, u.completada_en, ...preguntas.map((p) => indice[`${u.id}-${p.id}`] || '')]
        .map(esc)
        .join(';')
    );

    const csv = [encabezado, ...lineas].join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="encuesta-fiesta.csv"');
    res.send('\ufeff' + csv); // BOM para Excel
  })
);

// ---------------------------------------------------------
// Ver respuestas de todos (admin y moderador)
// ---------------------------------------------------------
router.get(
  '/',
  requireRole('admin', 'moderador'),
  ah(async (req, res) => {
    const preguntas = db.prepare('SELECT * FROM preguntas_encuesta ORDER BY orden, id').all();

    const usuarios = db
      .prepare(
        `SELECT u.id, u.nombre, u.cedula, u.email, c.completada_en,
                (SELECT COUNT(*) FROM acompanantes a WHERE a.usuario_id = u.id) AS n_acompanantes
         FROM usuarios u
         LEFT JOIN encuestas_completadas c ON c.usuario_id = u.id
         ORDER BY c.completada_en IS NULL, u.nombre`
      )
      .all();

    const filas = db.prepare('SELECT usuario_id, pregunta_id, respuesta FROM respuestas_encuesta').all();
    const indice = {};
    filas.forEach((f) => {
      indice[`${f.usuario_id}-${f.pregunta_id}`] = textoRespuesta(f.respuesta);
    });

    // Resumen por pregunta para gráficas: conteo por opción (multiple/unica/si_no)
    // y total de respuestas en texto. Lo calcula el backend (una sola pasada).
    const opciones = db.prepare('SELECT pregunta_id, texto FROM opciones_pregunta ORDER BY orden, id').all();
    const opcionesPorPregunta = {};
    opciones.forEach((o) => {
      opcionesPorPregunta[o.pregunta_id] = opcionesPorPregunta[o.pregunta_id] || [];
      opcionesPorPregunta[o.pregunta_id].push(o.texto);
    });
    const resumen = preguntas.map((p) => {
      const conteo = {};
      let total = 0;
      filas
        .filter((f) => f.pregunta_id === p.id)
        .forEach((f) => {
          total += 1;
          let vals = [];
          const t = String(f.respuesta || '').trim();
          if (t.startsWith('[')) {
            try {
              const arr = JSON.parse(t);
              if (Array.isArray(arr)) vals = arr;
            } catch (e) {
              vals = [t];
            }
          } else if (t) vals = [t];
          vals.forEach((v) => {
            conteo[v] = (conteo[v] || 0) + 1;
          });
        });
      const base = opcionesPorPregunta[p.id] || [];
      const vistas = base.length ? base : Object.keys(conteo).sort();
      return {
        pregunta_id: p.id,
        texto: p.texto,
        tipo: p.tipo,
        total,
        opciones: vistas.map((t) => ({ texto: t, cantidad: conteo[t] || 0 })),
      };
    });

    res.json({
      preguntas,
      resumen,
      usuarios: usuarios.map((u) => ({
        ...u,
        completada: !!u.completada_en,
        respuestas: Object.fromEntries(preguntas.map((p) => [p.id, indice[`${u.id}-${p.id}`] || null])),
      })),
    });
  })
);

module.exports = router;
