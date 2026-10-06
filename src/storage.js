/**
 * Almacenamiento de soportes de pago: Cloudinary o disco local.
 *
 * Regla estricta por entorno (ver src/config.js):
 * - development/test → SIEMPRE disco local (aunque haya claves en .env).
 * - production       → Cloudinary (exigido: sin claves la API no arranca).
 *
 * En la BD se guarda el `public_id` de Cloudinary o el nombre de archivo
 * local (ambos sin barras: a salvo de path traversal).
 */
const path = require('path');
const fs = require('fs');

const NUBE =
  // Estricto por entorno: solo producción usa la nube.
  process.env.NODE_ENV === 'production' &&
  !!process.env.CLOUDINARY_CLOUD_NAME &&
  !!process.env.CLOUDINARY_API_KEY &&
  !!process.env.CLOUDINARY_API_SECRET;

let cloudinary = null;
if (NUBE) {
  cloudinary = require('cloudinary').v2;
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });
}

const CARPETA = process.env.CLOUDINARY_FOLDER || 'fiesta';
const UPLOAD_DIR =
  process.env.FIESTA_UPLOADS_DIR || path.join(__dirname, '..', 'uploads');

if (!NUBE) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/** Sube el buffer a Cloudinary. Devuelve el public_id. */
function subirANube(buffer, nombreOriginal) {
  const ext = path.extname(nombreOriginal || '').toLowerCase().replace('.', '') || 'jpg';
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder: CARPETA, resource_type: 'image', format: ext },
      (error, resultado) => (error ? reject(error) : resolve(resultado.public_id))
    );
    stream.end(buffer);
  });
}

/** URL firmada y temporal del comprobante (el visor exige sesión). */
function urlDeNube(publicId) {
  return cloudinary.url(publicId, {
    secure: true,
    sign_url: true,
    type: 'upload',
    expires_at: Math.floor(Date.now() / 1000) + 300, // 5 minutos
  });
}

/** Borra de la nube (silencioso). */
async function borrarDeNube(publicId) {
  if (!publicId) return;
  try {
    await cloudinary.uploader.destroy(publicId, { resource_type: 'image' });
  } catch (e) {
    /* ignorar */
  }
}

/** Borra del disco local (silencioso). */
function borrarLocal(nombre) {
  if (!nombre) return;
  try {
    fs.unlinkSync(path.join(UPLOAD_DIR, path.basename(nombre)));
  } catch (e) {
    /* ignorar */
  }
}

module.exports = {
  NUBE,
  UPLOAD_DIR,
  subirANube,
  urlDeNube,
  borrarDeNube,
  borrarLocal,
};
