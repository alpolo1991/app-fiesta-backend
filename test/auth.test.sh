#!/usr/bin/env bash
# Pruebas del flujo de autenticación:
# registro (campos obligatorios y longitudes), login, recuperar,
# cambio de contraseña (incluye alias password_nueva) y temporal.
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

echo "=== U1. Validaciones de registro ==="
check "sin campos → 400" "obligatorios" "$(curl -s -X POST $API/auth/registro -H 'Content-Type: application/json' -d '{}')"
check "nombre corto → 400" "entre 3 y 80" "$(curl -s -X POST $API/auth/registro -H 'Content-Type: application/json' -d '{"nombre":"Al","cedula":"12345678","email":"corto@e2e.com","password":"secret123","whatsapp":"3001234567"}')"
check "cédula con letras → 400" "solo dígitos" "$(curl -s -X POST $API/auth/registro -H 'Content-Type: application/json' -d '{"nombre":"Nombre Largo","cedula":"ABC123","email":"ced@e2e.com","password":"secret123","whatsapp":"3001234567"}')"
check "cédula corta → 400" "solo dígitos" "$(curl -s -X POST $API/auth/registro -H 'Content-Type: application/json' -d '{"nombre":"Nombre Largo","cedula":"123","email":"ced2@e2e.com","password":"secret123","whatsapp":"3001234567"}')"
check "email inválido → 400" "no es válido" "$(curl -s -X POST $API/auth/registro -H 'Content-Type: application/json' -d '{"nombre":"Nombre Largo","cedula":"12345678","email":"no-es-email","password":"secret123","whatsapp":"3001234567"}')"
check "password corta → 400" "entre 6 y 72" "$(curl -s -X POST $API/auth/registro -H 'Content-Type: application/json' -d '{"nombre":"Nombre Largo","cedula":"12345678","email":"pass@e2e.com","password":"123","whatsapp":"3001234567"}')"
check "sin whatsapp → 400" "WhatsApp es obligatorio" "$(curl -s -X POST $API/auth/registro -H 'Content-Type: application/json' -d '{"nombre":"Nombre Largo","cedula":"12345678","email":"nowa@e2e.com","password":"secret123"}')"
check "whatsapp inválido → 400" "solo dígitos" "$(curl -s -X POST $API/auth/registro -H 'Content-Type: application/json' -d '{"nombre":"Nombre Largo","cedula":"12345678","email":"wa2@e2e.com","password":"secret123","whatsapp":"abc"}')"
check "duplicado → 409" "ya están registrados" "$(curl -s -X POST $API/auth/registro -H 'Content-Type: application/json' -d '{"nombre":"Otro","cedula":"1000000001","email":"otro@e2e.com","password":"secret123","whatsapp":"3001234567"}')"

echo "=== U2. Registro válido y login ==="
REG=$(curl -s -X POST $API/auth/registro -H 'Content-Type: application/json' -d '{"nombre":"Auth E2E","cedula":"777888999","email":"auth@e2e.com","password":"secret123","whatsapp":"3007778888"}')
check "registro 201" '"token"' "$REG"
TOKEN_AUTH=$(echo "$REG" | json "d['token']")
check "login con mayúsculas y espacios" '"token"' "$(curl -s -X POST $API/auth/login -H 'Content-Type: application/json' -d '{"email":"  AUTH@e2e.com  ","password":"secret123"}')"
check "login malo → 401 genérico" "Credenciales incorrectas" "$(curl -s -X POST $API/auth/login -H 'Content-Type: application/json' -d '{"email":"auth@e2e.com","password":"mala"}')"

echo "=== U3. Cambiar contraseña (alias password_nueva) ==="
check "sin token → 401" "Sesión no iniciada" "$(curl -s -X POST $API/auth/cambiar-password -H 'Content-Type: application/json' -d '{"password_nueva":"nueva123"}')"
check "corta → 400" "entre 6 y 72" "$(curl -s -H "Authorization: Bearer $TOKEN_AUTH" -X POST $API/auth/cambiar-password -H 'Content-Type: application/json' -d '{"password_actual":"secret123","password_nueva":"123"}')"
check "sin actual → 400" "contraseña actual" "$(curl -s -H "Authorization: Bearer $TOKEN_AUTH" -X POST $API/auth/cambiar-password -H 'Content-Type: application/json' -d '{"password_nueva":"nueva123456"}')"
check "actual mala → 400" "no es correcta" "$(curl -s -H "Authorization: Bearer $TOKEN_AUTH" -X POST $API/auth/cambiar-password -H 'Content-Type: application/json' -d '{"password_actual":"otra","password_nueva":"nueva123456"}')"
check "cambio válido" "actualizada" "$(curl -s -H "Authorization: Bearer $TOKEN_AUTH" -X POST $API/auth/cambiar-password -H 'Content-Type: application/json' -d '{"password_actual":"secret123","password_nueva":"nueva123456"}')"
check "login con la nueva" '"token"' "$(curl -s -X POST $API/auth/login -H 'Content-Type: application/json' -d '{"email":"auth@e2e.com","password":"nueva123456"}')"
check "alias antiguo password_nuevo también sirve" "actualizada" "$(curl -s -H "Authorization: Bearer $(curl -s -X POST $API/auth/login -H 'Content-Type: application/json' -d '{"email":"auth@e2e.com","password":"nueva123456"}' | json "d['token']")" -X POST $API/auth/cambiar-password -H 'Content-Type: application/json' -d '{"password_actual":"nueva123456","password_nuevo":"final123456"}')"

echo "=== U4. Recuperar no revela existencia ==="
M1=$(curl -s -X POST $API/auth/recuperar -H 'Content-Type: application/json' -d '{"email":"auth@e2e.com"}' | json "d['mensaje']")
M2=$(curl -s -X POST $API/auth/recuperar -H 'Content-Type: application/json' -d '{"email":"nadie@e2e.com"}' | json "d['mensaje']")
check "mensaje existente" "Solicitud enviada" "$M1"
[ "$M1" = "$M2" ] && check "mensajes idénticos" "OK" "OK" || check "mensajes idénticos" "iguales" "$M1 / $M2"

echo "=== U5. Temporal + WhatsApp en perfil ==="
TOKEN_ADMIN=$(curl -s -X POST $API/auth/login -H 'Content-Type: application/json' -d '{"email":"admin@fiesta.com","password":"admin123"}' | json "d['token']")
E2E_ID=$(curl -s -H "Authorization: Bearer $TOKEN_ADMIN" $API/usuarios | python3 -c "import sys,json;print([u['id'] for u in json.load(sys.stdin) if u['email']=='auth@e2e.com'][0])")
RST=$(curl -s -X PUT -H "Authorization: Bearer $TOKEN_ADMIN" $API/usuarios/$E2E_ID/reset-password)
check "reset devuelve whatsapp" '"whatsapp"' "$RST"
TEMP=$(echo "$RST" | json "d['password_temporal']")
check "temporal exige cambio (flag)" '"password_temporal":1' "$(curl -s -H "Authorization: Bearer $(curl -s -X POST $API/auth/login -H 'Content-Type: application/json' -d "{\"email\":\"auth@e2e.com\",\"password\":\"$TEMP\"}" | json "d['token']")" $API/usuarios/me)"
check "con temporal no pide actual" "actualizada" "$(curl -s -H "Authorization: Bearer $(curl -s -X POST $API/auth/login -H 'Content-Type: application/json' -d "{\"email\":\"auth@e2e.com\",\"password\":\"$TEMP\"}" | json "d['token']")" -X POST $API/auth/cambiar-password -H 'Content-Type: application/json' -d '{"password_nueva":"otra123456"}')"
check "whatsapp inválido en perfil → 400" "solo dígitos" "$(curl -s -X PUT -H "Authorization: Bearer $TOKEN_ADMIN" $API/usuarios/me -H 'Content-Type: application/json' -d '{"whatsapp":"abc"}')"

echo "=== U6. Admin edita datos de usuarios ==="
check "sin token → 401" "Sesión no iniciada" "$(curl -s -X PUT $API/usuarios/$E2E_ID -H 'Content-Type: application/json' -d '{"nombre":"X"}')"
TOKEN_MOD2=$(curl -s -X POST $API/auth/login -H 'Content-Type: application/json' -d '{"email":"roaruizedwinyesid@gmail.com","password":"roa123"}' | json "d['token']")
check "moderador → 403" "permisos" "$(curl -s -X PUT -H "Authorization: Bearer $TOKEN_MOD2" $API/usuarios/$E2E_ID -H 'Content-Type: application/json' -d '{"nombre":"Otro Nombre"}')"
check "nombre corto → 400" "entre 3 y 80" "$(curl -s -X PUT -H "Authorization: Bearer $TOKEN_ADMIN" $API/usuarios/$E2E_ID -H 'Content-Type: application/json' -d '{"nombre":"Al"}')"
check "cédula inválida → 400" "solo dígitos" "$(curl -s -X PUT -H "Authorization: Bearer $TOKEN_ADMIN" $API/usuarios/$E2E_ID -H 'Content-Type: application/json' -d '{"cedula":"abc"}')"
check "cédula duplicada → 409" "ya está registrada" "$(curl -s -X PUT -H "Authorization: Bearer $TOKEN_ADMIN" $API/usuarios/$E2E_ID -H 'Content-Type: application/json' -d '{"cedula":"1000000001"}')"
check "email duplicado → 409" "ya está en uso" "$(curl -s -X PUT -H "Authorization: Bearer $TOKEN_ADMIN" $API/usuarios/$E2E_ID -H 'Content-Type: application/json' -d '{"email":"roaruizedwinyesid@gmail.com"}')"
check "sin datos → 400" "No hay datos" "$(curl -s -X PUT -H "Authorization: Bearer $TOKEN_ADMIN" $API/usuarios/$E2E_ID -H 'Content-Type: application/json' -d '{}')"
check "inexistente → 404" "no encontrado" "$(curl -s -H "Authorization: Bearer $TOKEN_ADMIN" -X PUT $API/usuarios/99999 -H 'Content-Type: application/json' -d '{"nombre":"Nadie"}' | tr '[:upper:]' '[:lower:]')"
check "edición válida" "Usuario actualizado" "$(curl -s -X PUT -H "Authorization: Bearer $TOKEN_ADMIN" $API/usuarios/$E2E_ID -H 'Content-Type: application/json' -d '{"nombre":"Auth Editado","whatsapp":"3001112233"}')"
check "nombre quedó guardado" "Auth Editado" "$(curl -s -H "Authorization: Bearer $TOKEN_ADMIN" $API/usuarios/$E2E_ID | json "d['usuario']['nombre']")"

echo "=== U7. Solicitudes de recuperación (notifican al staff) ==="
curl -s -X POST $API/auth/recuperar -H 'Content-Type: application/json' -d '{"email":"auth@e2e.com"}' >/dev/null
check "admin ve la solicitud" 'auth@e2e.com' "$(curl -s -H "Authorization: Bearer $TOKEN_ADMIN" $API/recuperaciones)"
curl -s -X POST $API/auth/recuperar -H 'Content-Type: application/json' -d '{"email":"auth@e2e.com"}' >/dev/null
check "repetida no duplica" '"cantidad":1' "$(curl -s -H "Authorization: Bearer $TOKEN_ADMIN" $API/recuperaciones)"
curl -s -X POST $API/auth/recuperar -H 'Content-Type: application/json' -d '{"email":"nadie@e2e.com"}' >/dev/null
check "inexistente no crea solicitud" '"cantidad":1' "$(curl -s -H "Authorization: Bearer $TOKEN_ADMIN" $API/recuperaciones)"
curl -s -X POST $API/auth/recuperar -H 'Content-Type: application/json' -d '{"email":"roaruizedwinyesid@gmail.com"}' >/dev/null
check "mod ve la de usuarios pero no la de staff" 'auth@e2e.com' "$(curl -s -H "Authorization: Bearer $TOKEN_MOD2" $API/recuperaciones)"
check "mod ve solo 1 (oculta la del staff)" '"cantidad":1' "$(curl -s -H "Authorization: Bearer $TOKEN_MOD2" $API/recuperaciones)"
TOKEN_U=$(curl -s -X POST $API/auth/login -H 'Content-Type: application/json' -d '{"email":"auth@e2e.com","password":"otra123456"}' | json "d['token']")
check "usuario → 403" "403" "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN_U" $API/recuperaciones)"
check "sin token → 401" "Sesión no iniciada" "$(curl -s $API/recuperaciones)"
curl -s -X PUT -H "Authorization: Bearer $TOKEN_ADMIN" $API/usuarios/$E2E_ID/reset-password >/dev/null
check "reset marca atendida (queda solo la del mod)" '"cantidad":1' "$(curl -s -H "Authorization: Bearer $TOKEN_ADMIN" $API/recuperaciones)"

check "abono a staff → 400" "staff no tiene saldo" "$(curl -s -X POST -H "Authorization: Bearer $TOKEN_ADMIN" -H 'Content-Type: application/json' -d '{"monto":10000}' $API/usuarios/1/abono)"
check "validar a staff → 400" "staff no tiene saldo" "$(curl -s -X PUT -H "Authorization: Bearer $TOKEN_ADMIN" -H 'Content-Type: application/json' -d '{"pago_validado":1}' $API/usuarios/1/validar-pago)"

echo ""
echo "Resultado auth: $PASS OK, $FAIL errores"
[ "$FAIL" -eq 0 ]
