#!/usr/bin/env bash
# Pruebas del menú ACOMPAÑANTES (máx 1 por usuario, monto fijo de config):
# alta/baja, saldo, combo por cada uno pagado, KPIs, CSV y ficha.
set -u
API="${FIESTA_TEST_URL:-http://localhost:4000/api}"
PASS=0; FAIL=0

check() { # check "descripcion" "esperado" "obtenido"
  local desc="$1" esp="$2" obt="$3"
  if echo "$obt" | grep -q "$esp"; then
    PASS=$((PASS+1)); echo "  ✅ $desc"
  else
    FAIL=$((FAIL+1)); echo "  ❌ $desc"; echo "     esperado: $esp"; echo "     obtenido: ${obt:0:300}"
  fi
}

json() { python3 -c "import sys,json;d=json.load(sys.stdin);print(eval(sys.argv[1],{'d':d}))" "$1" 2>/dev/null; }

echo "=== A1. Sesiones ==="
TOKEN_ADMIN=$(curl -s -X POST $API/auth/login -H 'Content-Type: application/json' -d '{"email":"admin@fiesta.com","password":"admin123"}' | json "d['token']")
TOKEN_MOD=$(curl -s -X POST $API/auth/login -H 'Content-Type: application/json' -d '{"email":"roaruizedwinyesid@gmail.com","password":"roa123"}' | json "d['token']")
REGU=$(curl -s -X POST $API/auth/registro -H 'Content-Type: application/json' -d '{"nombre":"Usuario Acomp","cedula":"444555666","email":"acomp@e2e.com","password":"user123","whatsapp":"3004445556"}')
TOKEN_USER=$(echo "$REGU" | json "d['token']")
[ -n "$TOKEN_ADMIN" ] && check "login admin" "OK" "OK" || check "login admin" "token" "$TOKEN_ADMIN"
[ -n "$TOKEN_MOD" ] && check "login moderador" "OK" "OK" || check "login moderador" "token" "$TOKEN_MOD"
[ -n "$TOKEN_USER" ] && check "registro+login usuario" "OK" "OK" || check "registro+login usuario" "token" "$TOKEN_USER"

echo "=== A2. Encuesta sin acompañante (pregunta normal) ==="
PREGS=$(curl -s -H "Authorization: Bearer $TOKEN_USER" $API/preguntas)
check "ninguna pregunta con flag (es_acompanante:0)" '"es_acompanante":0' "$PREGS"
ENC=$(curl -s -X POST -H "Authorization: Bearer $TOKEN_USER" -H 'Content-Type: application/json' -d '{"respuestas":[{"pregunta_id":1,"respuesta":["Cerveza","Ron"]},{"pregunta_id":2,"respuesta":"Ninguna"},{"pregunta_id":3,"respuesta":"Sí"},{"pregunta_id":4,"respuesta":["Salsa"]}]}' $API/encuesta)
check "responder Sí ya no pide acompañante → 201" "Gracias" "$ENC"
check "saldo intacto (50000)" '"saldo_pendiente":50000' "$(curl -s -H "Authorization: Bearer $TOKEN_USER" $API/usuarios/me)"

echo "=== A3. Alta de acompañantes (máx 1, monto fijo) ==="
check "sin nombre → 400" "nombre del acompañante" "$(curl -s -X POST -H "Authorization: Bearer $TOKEN_USER" -H 'Content-Type: application/json' -d '{"nombre":""}' $API/acompanantes)"
A1=$(curl -s -X POST -H "Authorization: Bearer $TOKEN_USER" -H 'Content-Type: application/json' -d '{"nombre":"Ana Prueba"}' $API/acompanantes)
check "agregar 1/1 → 201" "Ana Prueba" "$A1"
check "monto fijo 50000" '"monto":50000' "$A1"
check "duplicado → 409" "ya está registrado" "$(curl -s -X POST -H "Authorization: Bearer $TOKEN_USER" -H 'Content-Type: application/json' -d '{"nombre":"ana prueba"}' $API/acompanantes)"
ANA_ID=$(curl -s -H "Authorization: Bearer $TOKEN_USER" $API/acompanantes/mios | python3 -c "import sys,json;print([a['id'] for a in json.load(sys.stdin)['lista'] if a['nombre']=='Ana Prueba'][0])")
check "editar nombre → 200" "Nombre actualizado" "$(curl -s -X PUT -H "Authorization: Bearer $TOKEN_USER" -H 'Content-Type: application/json' -d '{"nombre":"Anita Prueba"}' $API/acompanantes/$ANA_ID)"
check "editar sin nombre → 400" "indicar el nombre" "$(curl -s -X PUT -H "Authorization: Bearer $TOKEN_USER" -H 'Content-Type: application/json' -d '{"nombre":""}' $API/acompanantes/$ANA_ID)"
REG_E=$(curl -s -X POST $API/auth/registro -H 'Content-Type: application/json' -d '{"nombre":"Editor E2E","cedula":"121212121","email":"editor@e2e.com","password":"secret123","whatsapp":"3001212121"}')
TOKEN_E=$(echo "$REG_E" | json "d['token']")
check "editar ajeno → 403" "permisos" "$(curl -s -X PUT -H "Authorization: Bearer $TOKEN_E" -H 'Content-Type: application/json' -d '{"nombre":"Robado"}' $API/acompanantes/$ANA_ID)"
check "nombre quedó guardado" "Anita Prueba" "$(curl -s -H "Authorization: Bearer $TOKEN_USER" $API/acompanantes/mios)"
check "1/1 registrado" '"cantidad":1' "$(curl -s -H "Authorization: Bearer $TOKEN_USER" $API/acompanantes/mios)"
check "2do → 400 (máximo 1)" "Máximo 1" "$(curl -s -X POST -H "Authorization: Bearer $TOKEN_USER" -H 'Content-Type: application/json' -d '{"nombre":"Extra Prueba"}' $API/acompanantes)"
check "saldo 50000 + 1×50000 = 100000" '"saldo_pendiente":100000' "$(curl -s -H "Authorization: Bearer $TOKEN_USER" $API/usuarios/me)"
check "combo aún base sin pagar (3/1)" '"combo_cervezas_asignadas":3' "$(curl -s -H "Authorization: Bearer $TOKEN_USER" $API/usuarios/me)"

echo "=== A4. Permisos ==="
check "staff no agrega (admin → 403)" "permisos" "$(curl -s -X POST -H "Authorization: Bearer $TOKEN_ADMIN" -H 'Content-Type: application/json' -d '{"nombre":"X"}' $API/acompanantes)"
check "sin token → 401" "Sesión no iniciada" "$(curl -s $API/acompanantes/mios)"
check "usuario ve todos → 403" "permisos" "$(curl -s -H "Authorization: Bearer $TOKEN_USER" $API/acompanantes | head -c 200)"

echo "=== A5. Pago otorga combos (uno por cada pagado) ==="
USER_ID=$(curl -s -H "Authorization: Bearer $TOKEN_ADMIN" $API/usuarios | python3 -c "import sys,json;print([u['id'] for u in json.load(sys.stdin) if u['email']=='acomp@e2e.com'][0])")
AB1=$(curl -s -X POST -H "Authorization: Bearer $TOKEN_ADMIN" -H 'Content-Type: application/json' -d '{"monto":50000}' $API/usuarios/$USER_ID/abono)
COMBO1=$(curl -s -H "Authorization: Bearer $TOKEN_ADMIN" $API/entregas/usuario/$USER_ID)
check "base cubierta, 0 acompañantes pagos → 3 cervezas (fijo)" '"requerido": 3' "$(echo "$COMBO1" | python3 -c "import sys,json;d=json.load(sys.stdin);print(json.dumps([i for i in d['combo']['items'] if i['producto']=='Cerveza'][0]))")"
AB2=$(curl -s -X POST -H "Authorization: Bearer $TOKEN_ADMIN" -H 'Content-Type: application/json' -d '{"monto":50000}' $API/usuarios/$USER_ID/abono)
COMBO2=$(curl -s -H "Authorization: Bearer $TOKEN_ADMIN" $API/entregas/usuario/$USER_ID)
check "1 pagado → sigue 3 cervezas (fijo por usuario)" '"requerido": 3' "$(echo "$COMBO2" | python3 -c "import sys,json;d=json.load(sys.stdin);print(json.dumps([i for i in d['combo']['items'] if i['producto']=='Cerveza'][0]))")"
check "1 pagado → 1 comida (fijo)" '"requerido": 1' "$(echo "$COMBO2" | python3 -c "import sys,json;d=json.load(sys.stdin);print(json.dumps([i for i in d['combo']['items'] if i['producto']=='Comida'][0]))")"
check "flag pagado en lista" '"pagado":true' "$(curl -s -H "Authorization: Bearer $TOKEN_USER" $API/acompanantes/mios | tr -d ' ')"

echo "=== A5b. Recién agregado tras pagar base NO queda pagado (admin) ==="
REG_N=$(curl -s -X POST $API/auth/registro -H 'Content-Type: application/json' -d '{"nombre":"Nuevo E2E","cedula":"777888999","email":"nuevoacompa@e2e.com","password":"secret123","whatsapp":"3007778889"}')
TOKEN_N=$(echo "$REG_N" | json "d['token']")
ID_N=$(echo "$REG_N" | json "d['usuario']['id']")
curl -s -X POST -H "Authorization: Bearer $TOKEN_ADMIN" -H 'Content-Type: application/json' -d '{"monto":50000}' $API/usuarios/$ID_N/abono >/dev/null
curl -s -X POST -H "Authorization: Bearer $TOKEN_N" -H 'Content-Type: application/json' -d '{"nombre":"Hijo Nuevo"}' $API/acompanantes >/dev/null
check "admin ve recién agregado como no pagado" '"pagado":false' "$(curl -s -H "Authorization: Bearer $TOKEN_ADMIN" "$API/acompanantes?usuario_id=$ID_N" | tr -d ' ')"
curl -s -X POST -H "Authorization: Bearer $TOKEN_ADMIN" -H 'Content-Type: application/json' -d '{"monto":50000}' $API/usuarios/$ID_N/abono >/dev/null
check "tras pagarlo admin lo ve pagado" '"pagado":true' "$(curl -s -H "Authorization: Bearer $TOKEN_ADMIN" "$API/acompanantes?usuario_id=$ID_N" | tr -d ' ')"

echo "=== A6. Baja ==="
A1_ID=$(curl -s -H "Authorization: Bearer $TOKEN_USER" $API/acompanantes/mios | python3 -c "import sys,json;print([a['id'] for a in json.load(sys.stdin)['lista'] if a['nombre']=='Anita Prueba'][0])")
check "eliminar pagado → 400" "ya está pagado" "$(curl -s -X DELETE -H "Authorization: Bearer $TOKEN_USER" $API/acompanantes/$A1_ID)"
REG_OTRO=$(curl -s -X POST $API/auth/registro -H 'Content-Type: application/json' -d '{"nombre":"Otro E2E","cedula":"999111222","email":"otroacompa@e2e.com","password":"secret123","whatsapp":"3009991112"}')
TOKEN_OTRO=$(echo "$REG_OTRO" | json "d['token']")
check "otro usuario no elimina ajeno → 403" "permisos" "$(curl -s -X DELETE -H "Authorization: Bearer $TOKEN_OTRO" $API/acompanantes/$A1_ID)"

echo "=== A7. KPIs y reportes ==="
RES=$(curl -s -H "Authorization: Bearer $TOKEN_ADMIN" $API/dashboard/resumen)
check "KPI acompañantes: 2 por 100000" '"acompanantes":{"cantidad":2,"total":100000}' "$RES"
check "2 confirmados × 100000" '"acompanantesConfirmados": 2' "$(echo "$RES" | python3 -c "import sys,json;print(json.dumps(json.load(sys.stdin)['ganancias']))")"
check "0 por cobrar" '"montoAcompanantesPorCobrar": 0' "$(echo "$RES" | python3 -c "import sys,json;print(json.dumps(json.load(sys.stdin)['ganancias']))")"
check "personal incluye acompañantes" '"acompanantes":2' "$RES"
TODAS=$(curl -s -H "Authorization: Bearer $TOKEN_ADMIN" $API/acompanantes)
check "admin ve todos" '"usuario_nombre"' "$TODAS"
CSV=$(curl -s -H "Authorization: Bearer $TOKEN_ADMIN" "$API/soportes-pago/exportar?estado=todas")
check "CSV pagos trae columnas de acompañantes" "Cantidad_acompanantes" "$CSV"
FICHA=$(curl -s -H "Authorization: Bearer $TOKEN_ADMIN" $API/usuarios/$USER_ID)
check "ficha trae lista de acompañantes" '"acompanantes":{"lista"' "$FICHA"
ENT=$(curl -s -H "Authorization: Bearer $TOKEN_MOD" $API/entregas/pendientes)
check "entregas trae conteo" '"n_acompanantes"' "$ENT"

echo "=== A8. Permisos mod/admin sobre pagados ==="
ANA2_ID=$(curl -s -H "Authorization: Bearer $TOKEN_USER" $API/acompanantes/mios | python3 -c "import sys,json;print([a['id'] for a in json.load(sys.stdin)['lista'] if a['nombre']=='Anita Prueba'][0])")
check "mod edita pagado → 200" "Nombre actualizado" "$(curl -s -X PUT -H "Authorization: Bearer $TOKEN_MOD" -H 'Content-Type: application/json' -d '{"nombre":"Anita Mod"}' $API/acompanantes/$ANA2_ID)"
check "mod borra pagado → 400" "ya está pagado" "$(curl -s -X DELETE -H "Authorization: Bearer $TOKEN_MOD" $API/acompanantes/$ANA2_ID)"
check "admin borra pagado → 200" "eliminado" "$(curl -s -X DELETE -H "Authorization: Bearer $TOKEN_ADMIN" $API/acompanantes/$ANA2_ID | tr '[:upper:]' '[:lower:]')"
check "saldo recalculado sin negativo" '"saldo_pendiente":0' "$(curl -s -H "Authorization: Bearer $TOKEN_USER" $API/usuarios/me)"

echo ""
echo "Resultado acompañantes: $PASS OK, $FAIL errores"
[ "$FAIL" -eq 0 ]
