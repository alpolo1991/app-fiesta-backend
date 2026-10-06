#!/usr/bin/env node
/**
 * ============================================================
 *  Runner de pruebas:  npm test   (dentro de server/)
 * ============================================================
 * Por cada suite *.test.sh:
 *   1. Crea una base de datos y carpeta de subidas TEMPORALES.
 *   2. Arranca el backend en un puerto libre (4999 por defecto).
 *   3. Ejecuta la suite contra esa instancia.
 *   4. Detiene el servidor y borra los temporales.
 *
 * Así las pruebas nunca tocan server/fiesta.db (tus datos reales)
 * ni interfieren con un backend corriendo en :4000.
 *
 * Requisitos: node, bash, curl y python3.
 */
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PUERTO = process.env.FIESTA_TEST_PORT || '4999';
const URL = `http://localhost:${PUERTO}/api`;
const SERVER = path.join(__dirname, '..', 'src', 'index.js');

/** Espera a que el backend responda /api/salud. */
async function esperarSalud(url, timeoutMs = 20000) {
  const inicio = Date.now();
  while (Date.now() - inicio < timeoutMs) {
    try {
      const r = await fetch(url + '/salud');
      if (r.ok) return true;
    } catch (e) {
      /* aún no está listo */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`El backend no respondió en ${timeoutMs} ms (${url}/salud)`);
}

/** Lanza el backend con BD/subidas temporales y devuelve el proceso. */
function arrancarServidor(temporal) {
  const env = {
    ...process.env,
    PORT: PUERTO,
    JWT_SECRET: 'secreto-de-pruebas',
    FRONTEND_URL: 'http://localhost:5173',
    FIESTA_DB_PATH: path.join(temporal, 'fiesta.db'),
    FIESTA_UPLOADS_DIR: path.join(temporal, 'uploads'),
    // Los tests siempre usan disco temporal: nunca tocan Cloudinary.
    CLOUDINARY_ENABLED: '0',
  };
  const hijo = spawn(process.execPath, [SERVER], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  hijo.stdout.on('data', (d) => process.stdout.write(`   [server] ${d}`));
  hijo.stderr.on('data', (d) => process.stderr.write(`   [server] ${d}`));
  return hijo;
}

/** Ejecuta una suite bash y devuelve true si terminó con exit 0. */
function correrSuite(script) {
  const resultado = spawnSync('bash', [script], {
    env: { ...process.env, FIESTA_TEST_URL: URL },
    stdio: 'inherit',
  });
  return resultado.status === 0;
}

function limpiar(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    /* ignorar */
  }
}

(async () => {
  const suites = fs
    .readdirSync(__dirname)
    .filter((f) => f.endsWith('.test.sh'))
    .sort();

  if (!suites.length) {
    console.error('No se encontraron suites (*.test.sh) en test/');
    process.exit(1);
  }

  console.log(`\n🧪 Pruebas de la API · ${suites.length} suite(s) · servidor temporal en ${URL}\n`);

  const resultados = [];

  for (const nombre of suites) {
    console.log(`\n${'='.repeat(68)}\n▶ ${nombre}\n${'='.repeat(68)}`);
    const temporal = fs.mkdtempSync(path.join(os.tmpdir(), 'fiesta-test-'));
    let servidor = null;
    let ok = false;
    try {
      servidor = arrancarServidor(temporal);
      await esperarSalud(URL);
      ok = correrSuite(path.join(__dirname, nombre));
    } catch (e) {
      console.error(`   ✖ Error al preparar la suite ${nombre}: ${e.message}`);
      ok = false;
    } finally {
      if (servidor) {
        servidor.kill('SIGTERM');
        await new Promise((r) => setTimeout(r, 300));
        if (!servidor.killed) servidor.kill('SIGKILL');
      }
      limpiar(temporal);
    }
    resultados.push({ nombre, ok });
  }

  // ---------- Resumen ----------
  console.log(`\n${'='.repeat(68)}`);
  console.log('RESUMEN DE PRUEBAS');
  console.log('='.repeat(68));
  resultados.forEach((r) => console.log(`  ${r.ok ? '✅' : '❌'} ${r.nombre}`));
  const fallas = resultados.filter((r) => !r.ok).length;
  console.log(
    fallas === 0
      ? `\n🎉 Todas las suites pasaron (${resultados.length}/${resultados.length}).`
      : `\n💥 ${fallas} suite(s) fallaron.`
  );
  process.exit(fallas === 0 ? 0 : 1);
})();
