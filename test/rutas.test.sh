#!/usr/bin/env bash
# Verifica que cada endpoint del especificación exista.
# 404 = la ruta NO existe; 401/403/400/200 = la ruta SÍ está montada.
API="${FIESTA_TEST_URL:-http://localhost:4000/api}"
FALTA=0; OK=0

verificar() { # metodo ruta [body]
  local m="$1" r="$2" body="${3:-}"
  local url="$API$r"
  local code
  if [ -n "$body" ]; then
    code=$(curl -s -o /dev/null -w '%{http_code}' -X "$m" -H 'Content-Type: application/json' -d "$body" "$url")
  else
    code=$(curl -s -o /dev/null -w '%{http_code}' -X "$m" "$url")
  fi
  if [ "$code" = "404" ]; then
    echo "  ❌ FALTA: $m $r"; FALTA=$((FALTA+1))
  else
    echo "  ✅ $m $r → $code"; OK=$((OK+1))
  fi
}

echo "--- AUTH ---"
verificar POST /auth/registro '{}'
verificar POST /auth/login '{}'
verificar POST /auth/recuperar '{}'
verificar POST /auth/cambiar-password '{}'

echo "--- USUARIOS ---"
verificar GET /usuarios/me
verificar PUT /usuarios/me '{}'
verificar GET /usuarios
verificar PUT /usuarios/1 '{}'
verificar PUT /usuarios/1/pago '{}'
verificar PUT /usuarios/1/validar-pago '{}'
verificar POST /usuarios/1/abono '{}'
verificar DELETE /usuarios/1
verificar PUT /usuarios/1/rol '{}'
verificar PUT /usuarios/1/reset-password

echo "--- CUENTAS DE PAGO ---"
verificar GET /cuentas-pago
verificar PUT /cuentas-pago/1 '{}'
verificar GET /cuentas-pago/1/qr
verificar PUT /cuentas-pago/1/qr

echo "--- SOPORTES DE PAGO ---"
verificar POST /soportes-pago
verificar GET /soportes-pago
verificar GET /soportes-pago/mios
verificar GET /soportes-pago/exportar
verificar GET /acompanantes/mios
verificar GET /acompanantes
verificar POST /acompanantes '{}'
verificar DELETE /acompanantes/1
verificar PUT /soportes-pago/1/aprobar
verificar PUT /soportes-pago/1/rechazar '{}'
verificar GET /soportes-pago/1/archivo

echo "--- CONFIGURACION ---"
verificar GET /configuracion
verificar GET /configuracion/contactos
verificar PUT /configuracion/whatsapp_admin '{}'

echo "--- DASHBOARD ---"
verificar GET /dashboard/resumen

echo "--- RECUPERACIONES ---"
verificar GET /recuperaciones

echo "--- CAJAS ---"
verificar GET /cajas
verificar GET /cajas/inscripcion/movimientos
verificar POST /cajas/inscripcion/movimiento '{}'

echo "--- PREGUNTAS / OPCIONES ---"
verificar GET /preguntas
verificar POST /preguntas '{}'
verificar PUT /preguntas/1 '{}'
verificar DELETE /preguntas/1
verificar PUT /preguntas/1/activa '{}'
verificar POST /preguntas/1/opciones '{}'
verificar DELETE /opciones/1

echo "--- ENCUESTA ---"
verificar POST /encuesta '{}'
verificar GET /encuesta/mia
verificar GET /encuesta
verificar GET /encuesta/exportar

echo "--- INVENTARIO ---"
verificar GET /inventario
verificar POST /inventario '{}'
verificar PUT /inventario/1 '{}'
verificar POST /inventario/1/ingreso '{}'
verificar POST /inventario/1/salida '{}'
verificar POST /inventario/1/ajuste '{}'
verificar GET /inventario/movimientos

echo "--- ENTREGAS ---"
verificar GET /entregas/usuario/1
verificar GET /entregas/pendientes
verificar POST /entregas '{}'
verificar POST /entregas/1/completar

echo ""
echo "Rutas montadas: $OK · Faltantes: $FALTA"
# El script falla si falta alguna ruta del especificación
[ "$FALTA" -eq 0 ]
