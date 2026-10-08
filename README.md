# 🎉 Fiesta Fin de Año 2026 — Backend (API)

API de gestión de fiesta empresarial: inscripción (monto configurable por admin,
default $50.000) y pagos con soporte en imagen, acompañantes (máx 1),
encuesta dinámica, inventario, entregas de combo solo con pago confirmado y dos
cajas separadas, con roles ADMIN / MODERADOR / USUARIO.

> Repo independiente del frontend. Despliegue: **Render** (`render.yaml`).

## 🧰 Stack

Node.js + Express + better-sqlite3 + bcrypt + JWT + multer + Cloudinary
+ express-rate-limit + cors. SQLite en archivo (`fiesta.db`, o `FIESTA_DB_PATH`).

## 🚀 Desarrollo local

```bash
npm install
cp .env.example .env   # ajusta JWT_SECRET
npm run dev            # API en :4000 (usa src/index.js --watch)
```

## 📜 Scripts

```bash
npm start   # producción (node src/index.js)
npm run dev # desarrollo con reload
npm test    # 6 suites (node test/run.js), BD temporal por suite
npm run seed  # siembra solo si `usuarios` está vacío
npm run reset # BORRA fiesta.db* + uploads y re-siembran desde cero
```

Seed: admin (`admin@fiesta.com`/`admin123`), Edwin Roa
(`roaruizedwinyesid@gmail.com`/`roa123`, mod), Isaac Fontalvo
(`isaacfontalvo@gmail.com`/`isaac123`, mod), demo (`demo@fiesta.com`/`demo123`,
se elimina en producción), cajas abiertas, cuentas de pago, configuración, preguntas e inventario demo.

## 🔑 Variables (`cp .env.example .env`)

| Variable | Ejemplo |
|---|---|
| `JWT_SECRET` | secreto largo único (obligatorio en prod) |
| `PORT` | `4000` (Render lo pone solo) |
| `FRONTEND_URL` | URL de Vercel, o lista con comas |
| `FIESTA_DB_PATH` | `/data/fiesta.db` (disco Render) |
| `CLOUDINARY_CLOUD_NAME` / `CLOUDINARY_API_KEY` / `CLOUDINARY_API_SECRET` | claves de Cloudinary |
| `CLOUDINARY_FOLDER` | `fiesta` |

Sin las 3 de Cloudinary usa disco local (`uploads/`).

## ☁️ Deploy en Render

1. New → **Blueprint** → conecta este repo (usa `render.yaml`: servicio +
   disco de 1 GB en `/data`).
2. Pon las variables de arriba (`JWT_SECRET` con *Generate*,
   `FRONTEND_URL` con tu URL de Vercel).
3. Verifica `https://tu-api.onrender.com/api/salud` → `{"ok":true}`.

> ⚠️ SQLite vive en el disco: no lo borres o pierdes los datos.
> Postgres queda como fase 2.

## 📡 Endpoints (base `/api`)

Auth: `POST /auth/registro|login|recuperar|cambiar-password` ·
Usuarios (RBAC) · Acompañantes (máx 1) · Recuperaciones (staff) ·
Soportes de pago (imagen jpg/png/webp, tamaño configurable hasta 3 MB, default 1 MB + CSV) · Cuentas de pago (+QR) ·
Cajas (inscripción/bebidas, siempre abiertas) · Encuesta (+resumen y CSV) ·
Inventario (+ventas, ajuste, reserva de combos) · Entregas (combo solo `pagado`) ·
Configuración (`monto_inscripcion`, `monto_acompanante` + contactos públicos) ·
Dashboard (KPIs + ganancias).
