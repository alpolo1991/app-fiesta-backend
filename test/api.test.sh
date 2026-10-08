#!/usr/bin/env bash
# Pruebas end-to-end de la API de la fiesta (corre contra el servidor
# que indique FIESTA_TEST_URL; lo levanta npm test → test/run.js).
set -u
API="${FIESTA_TEST_URL:-http://localhost:4000/api}"
# Carpeta temporal para las imágenes de prueba
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
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

echo "=== 1. Salud y configuración ==="
check "GET /salud" '"ok":true' "$(curl -s $API/salud)"
check "GET /configuracion tiene whatsapp_admin" 'whatsapp_admin' "$(curl -s $API/configuracion)"

echo "=== 2. Login de los 3 roles (usuario se registra) ==="
TOKEN_ADMIN=$(curl -s -X POST $API/auth/login -H 'Content-Type: application/json' -d '{"email":"admin@fiesta.com","password":"admin123"}' | json "d['token']")
TOKEN_MOD=$(curl -s -X POST $API/auth/login -H 'Content-Type: application/json' -d '{"email":"moderador@fiesta.com","password":"mod123"}' | json "d['token']")
REGU=$(curl -s -X POST $API/auth/registro -H 'Content-Type: application/json' -d '{"nombre":"Usuario E2E","cedula":"111222333","email":"usuario@e2e.com","password":"user123","whatsapp":"3001112223"}')
TOKEN_USER=$(echo "$REGU" | json "d['token']")
UID_USER=$(echo "$REGU" | json "d['usuario']['id']")
[ -n "$TOKEN_ADMIN" ] && check "login admin" "OK" "OK" || check "login admin" "token" "$TOKEN_ADMIN"
[ -n "$TOKEN_MOD" ] && check "login moderador" "OK" "OK" || check "login moderador" "token" "$TOKEN_MOD"
[ -n "$TOKEN_USER" ] && check "registro+login usuario" "OK" "OK" || check "registro+login usuario" "token" "$TOKEN_USER"
check "login malo → 401" "Credenciales incorrectas" "$(curl -s -X POST $API/auth/login -H 'Content-Type: application/json' -d '{"email":"admin@fiesta.com","password":"mala"}')"

echo "=== 2b. Inventario demo del seed (combo) ==="
INV0=$(curl -s -H "Authorization: Bearer $TOKEN_ADMIN" $API/inventario)
CERV_ID=$(echo "$INV0" | python3 -c "import sys,json;print([p['id'] for p in json.load(sys.stdin)['productos'] if p['producto']=='Cerveza'][0])")
COM_ID=$(echo "$INV0" | python3 -c "import sys,json;print([p['id'] for p in json.load(sys.stdin)['productos'] if p['producto']=='Comida'][0])")
[ -n "$CERV_ID" ] && check "productos demo presentes" "OK" "OK" || check "productos demo presentes" "ids" "$CERV_ID/$COM_ID"

echo "=== 3. Registro de usuario nuevo ==="
REG=$(curl -s -X POST $API/auth/registro -H 'Content-Type: application/json' -d '{"nombre":"Prueba E2E","cedula":"999888777","email":"prueba@e2e.com","password":"secret123","whatsapp":"3009998888"}')
check "registro 201" '"token"' "$REG"
TOKEN_E2E=$(echo "$REG" | json "d['token']")

echo "=== 4. Recuperar (no revela existencia) ==="
M1=$(curl -s -X POST $API/auth/recuperar -H 'Content-Type: application/json' -d '{"email":"usuario@e2e.com"}' | json "d['mensaje']")
M2=$(curl -s -X POST $API/auth/recuperar -H 'Content-Type: application/json' -d '{"email":"noexistente@e2e.com"}' | json "d['mensaje']")
check "mensaje igual con email existente" "Solicitud enviada" "$M1"
check "mensaje igual con email inexistente" "Solicitud enviada" "$M2"
[ "$M1" = "$M2" ] && check "mensajes idénticos" "OK" "OK" || check "mensajes idénticos" "iguales" "$M1 / $M2"

echo "=== 5. RBAC: usuario no puede entrar a admin ==="
check "GET /usuarios sin token → 401" "Sesión no iniciada" "$(curl -s $API/usuarios)"
check "GET /usuarios con token de usuario → 403" "permisos" "$(curl -s -H "Authorization: Bearer $TOKEN_USER" $API/usuarios)"
check "GET /dashboard con token de usuario → 403" "permisos" "$(curl -s -H "Authorization: Bearer $TOKEN_USER" $API/dashboard/resumen)"
check "mod no puede editar cuentas → 403" "permisos" "$(curl -s -X PUT -H "Authorization: Bearer $TOKEN_MOD" -H 'Content-Type: application/json' -d '{"numero":"1"}' $API/cuentas-pago/1)"

echo "=== 6. Subida de soporte ==="
# PNG de 1 KB
python3 -c "
import struct,zlib
def png(path,w=40,h=40):
    def chunk(t,d):
        c=struct.pack('>I',len(d))+t+d
        return c+struct.pack('>I',zlib.crc32(t+d)&0xffffffff)
    raw=b''.join(b'\x00'+bytes([ (i*7)%256, (i*13)%256, (i*29)%256 ])*w for i in range(h))
    data=b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',w,h,8,2,0,0,0))+chunk(b'IDAT',zlib.compress(raw))+chunk(b'IEND',b'')
    open(path,'wb').write(data)
png('$TMP/soporte.png')
png('$TMP/grande.png',1400,1400)
"
# Archivo de >1 MB real (texto aleatorio) para probar el límite de multer
head -c 1200000 /dev/urandom > "$TMP/grande2.png"
SOP=$(curl -s -X POST -H "Authorization: Bearer $TOKEN_USER" -F "archivo=@$TMP/soporte.png;type=image/png" -F "monto=30000" -F "tipo=abono" $API/soportes-pago)
check "subir soporte 201" "pendiente" "$SOP"
check "archivo de >1MB rechazado" "1 MB" "$(curl -s -X POST -H "Authorization: Bearer $TOKEN_USER" -F "archivo=@$TMP/grande2.png;type=image/png" -F "monto=30000" -F "tipo=abono" $API/soportes-pago)"
check "abono bajo mínimo rechazado" "mínimo" "$(curl -s -X POST -H "Authorization: Bearer $TOKEN_USER" -F "archivo=@$TMP/soporte.png;type=image/png" -F "monto=5000" -F "tipo=abono" $API/soportes-pago)"
check "mis soportes" "pendiente" "$(curl -s -H "Authorization: Bearer $TOKEN_USER" $API/soportes-pago/mios)"

echo "=== 7. Aprobar soporte (moderador) ==="
PEND=$(curl -s -H "Authorization: Bearer $TOKEN_MOD" "$API/soportes-pago?estado=pendiente")
SOP_ID=$(echo "$PEND" | json "d[0]['id']" 2>/dev/null || echo "$PEND" | json "d['id']")
[ -z "$SOP_ID" ] && SOP_ID=$(echo "$PEND" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d[0]['id'] if d else '')")
check "hay soporte pendiente" "[0-9]" "$SOP_ID"
APR=$(curl -s -X PUT -H "Authorization: Bearer $TOKEN_MOD" -H 'Content-Type: application/json' $API/soportes-pago/$SOP_ID/aprobar)
check "aprobar → saldo 20000" '"saldo_pendiente": 20000' "$(echo "$APR" | python3 -c "import sys,json;print(json.dumps(json.load(sys.stdin)['usuario']))")"
check "aprobar → estado abonado" '"estado_pago": "abonado"' "$(echo "$APR" | python3 -c "import sys,json;print(json.dumps(json.load(sys.stdin)['usuario']))")"
check "aprobar dos veces → error" "ya fue revisado" "$(curl -s -X PUT -H "Authorization: Bearer $TOKEN_MOD" -H 'Content-Type: application/json' $API/soportes-pago/$SOP_ID/aprobar)"
check "queda registrado quién aprobó" 'revisado_por_nombre' "$(curl -s -H "Authorization: Bearer $TOKEN_MOD" "$API/soportes-pago?estado=todas")"
REG3=$(curl -s -X POST $API/auth/registro -H 'Content-Type: application/json' -d '{"nombre":"Motivo E2E","cedula":"444555666","email":"motivo@e2e.com","password":"secret123","whatsapp":"3004445556"}')
TOKEN_M3=$(echo "$REG3" | json "d['token']")
SOP3=$(curl -s -X POST -H "Authorization: Bearer $TOKEN_M3" -F "archivo=@$TMP/soporte.png;type=image/png" -F "monto=20000" -F "tipo=abono" $API/soportes-pago)
SOP3_ID=$(echo "$SOP3" | json "d['soporte']['id']")
check "aprobar con motivo opcional" "aprobado" "$(curl -s -X PUT -H "Authorization: Bearer $TOKEN_ADMIN" -H 'Content-Type: application/json' -d '{"comentario":"verificado nequi"}' $API/soportes-pago/$SOP3_ID/aprobar | tr '[:upper:]' '[:lower:]')"
check "motivo de aprobación guardado" "verificado nequi" "$(curl -s -H "Authorization: Bearer $TOKEN_ADMIN" "$API/soportes-pago?estado=todas")"

echo "=== 8. Rechazar exige comentario ==="
SOP2=$(curl -s -X POST -H "Authorization: Bearer $TOKEN_USER" -F "archivo=@$TMP/soporte.png;type=image/png" -F "monto=20000" -F "tipo=abono" $API/soportes-pago)
SOP2_ID=$(echo "$SOP2" | json "d['soporte']['id']")
check "rechazar sin comentario → 400" "comentario" "$(curl -s -X PUT -H "Authorization: Bearer $TOKEN_ADMIN" -H 'Content-Type: application/json' -d '{}' $API/soportes-pago/$SOP2_ID/rechazar)"
check "rechazar con comentario" "rechazado" "$(curl -s -X PUT -H "Authorization: Bearer $TOKEN_ADMIN" -H 'Content-Type: application/json' -d '{"comentario":"foto borrosa"}' $API/soportes-pago/$SOP2_ID/rechazar)"
check "visor de archivo" "PNG" "$(curl -s -H "Authorization: Bearer $TOKEN_ADMIN" $API/soportes-pago/$SOP_ID/archivo | head -c 4 | od -An -c | tr -d ' \n')"

echo "=== 8b. QR de cuentas de pago ==="
CUENTA1=$(curl -s -H "Authorization: Bearer $TOKEN_ADMIN" "$API/cuentas-pago?todas=1" | json "d[0]['id']")
check "mod no sube QR → 403" "403" "$(curl -s -o /dev/null -w '%{http_code}' -X PUT -H "Authorization: Bearer $TOKEN_MOD" -F "archivo=@$TMP/soporte.png;type=image/png" $API/cuentas-pago/$CUENTA1/qr)"
echo "texto" > "$TMP/nota.txt"
check "archivo no imagen → 400" "Solo se permiten" "$(curl -s -X PUT -H "Authorization: Bearer $TOKEN_ADMIN" -F "archivo=@$TMP/nota.txt;type=text/plain" $API/cuentas-pago/$CUENTA1/qr)"
check "subir QR → 201" '"tiene_qr": true' "$(curl -s -X PUT -H "Authorization: Bearer $TOKEN_ADMIN" -F "archivo=@$TMP/soporte.png;type=image/png" $API/cuentas-pago/$CUENTA1/qr | python3 -c "import sys,json;print(json.dumps(json.load(sys.stdin)['cuenta']))")"
check "ver QR devuelve imagen" "PNG" "$(curl -s -H "Authorization: Bearer $TOKEN_USER" $API/cuentas-pago/$CUENTA1/qr | head -c 4 | od -An -c | tr -d ' \n')"
check "quitar QR" '"tiene_qr": false' "$(curl -s -X DELETE -H "Authorization: Bearer $TOKEN_ADMIN" $API/cuentas-pago/$CUENTA1/qr | python3 -c "import sys,json;print(json.dumps(json.load(sys.stdin)['cuenta']))")"
check "QR quitado → 404" "404" "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN_USER" $API/cuentas-pago/$CUENTA1/qr)"

echo "=== 9. Cajas separadas ==="
CI=$(curl -s -H "Authorization: Bearer $TOKEN_ADMIN" $API/cajas/inscripcion/movimientos)
CB=$(curl -s -H "Authorization: Bearer $TOKEN_ADMIN" $API/cajas/bebidas/movimientos)
check "caja inscripción tiene ingreso del soporte" 'Abono aprobado' "$CI"
check "caja bebidas no recibe el pago de inscripción (separadas)" 'no hay' "$(echo "$CB" | python3 -c "import sys,json;d=json.load(sys.stdin);ms=d['movimientos'];print('movimientos:'+str(len(ms)))" | grep -q 'movimientos:0' && echo 'no hay' || echo 'si hay')"
check "saldo caja inscripción = 50000 (30000 + 20000 con motivo)" '"saldo": 50000' "$(echo "$CI" | python3 -c "import sys,json;print(json.dumps(json.load(sys.stdin)['saldo']))" | python3 -c "import sys,json;s=json.load(sys.stdin);print(json.dumps({'saldo':s}))")"

echo "=== 9b. CSV de pagos validados ==="
check "export pagos solo admin/mod: usuario → 403" "403" "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN_USER" $API/soportes-pago/exportar)"
check "export CSV admin" "Monto_reportado" "$(curl -s -H "Authorization: Bearer $TOKEN_ADMIN" "$API/soportes-pago/exportar?estado=aprobado" | head -3)"
check "CSV trae al usuario con su abono" "usuario@e2e.com" "$(curl -s -H "Authorization: Bearer $TOKEN_ADMIN" "$API/soportes-pago/exportar?estado=aprobado")"
check "export CSV mod también puede" "Monto_reportado" "$(curl -s -H "Authorization: Bearer $TOKEN_MOD" "$API/soportes-pago/exportar?estado=todas" | head -3)"
check "contactos staff públicos (sin token)" '"rol":"admin"' "$(curl -s $API/configuracion/contactos | tr -d ' ')"

echo "=== 15. Controles de seguridad contable ==="
check "pago_total sin saldo → 400" "saldo pendiente" "$(curl -s -X POST -H "Authorization: Bearer $TOKEN_MOD" -F "archivo=@$TMP/soporte.png;type=image/png" -F "monto=1000" -F "tipo=pago_total" $API/soportes-pago)"
E2E_15=$(curl -s -H "Authorization: Bearer $TOKEN_ADMIN" $API/usuarios | python3 -c "import sys,json;print([u['id'] for u in json.load(sys.stdin) if u['email']=='prueba@e2e.com'][0])")
curl -s -X PUT -H "Authorization: Bearer $TOKEN_ADMIN" -H 'Content-Type: application/json' -d '{"monto_abonado":0,"saldo_pendiente":50000}' $API/usuarios/2/pago >/dev/null
SOPM=$(curl -s -X POST -H "Authorization: Bearer $TOKEN_MOD" -F "archivo=@$TMP/soporte.png;type=image/png" -F "monto=20000" -F "tipo=abono" $API/soportes-pago)
SOPM_ID=$(echo "$SOPM" | json "d['soporte']['id']")
check "auto-aprobarse → 403" "propio soporte" "$(curl -s -X PUT -H "Authorization: Bearer $TOKEN_MOD" -H 'Content-Type: application/json' $API/soportes-pago/$SOPM_ID/aprobar)"
SOPU=$(curl -s -X POST -H "Authorization: Bearer $TOKEN_USER" -F "archivo=@$TMP/soporte.png;type=image/png" -F "monto=20000" -F "tipo=abono" $API/soportes-pago)
SOPU_ID=$(echo "$SOPU" | json "d['soporte']['id']")
curl -s -X PUT -H "Authorization: Bearer $TOKEN_ADMIN" -H 'Content-Type: application/json' -d '{"monto_abonado":45000}' $API/usuarios/$UID_USER/pago >/dev/null
check "aprobar sobre saldo actual → 400" "supera el saldo actual" "$(curl -s -X PUT -H "Authorization: Bearer $TOKEN_ADMIN" -H 'Content-Type: application/json' $API/soportes-pago/$SOPU_ID/aprobar)"
check "PUT pago saldo negativo → 400" "inválido" "$(curl -s -X PUT -H "Authorization: Bearer $TOKEN_ADMIN" -H 'Content-Type: application/json' -d '{"monto_abonado":0,"saldo_pendiente":-5}' $API/usuarios/$E2E_15/pago)"
check "PUT pago abonado mayor al total → 400" "no puede superar" "$(curl -s -X PUT -H "Authorization: Bearer $TOKEN_ADMIN" -H 'Content-Type: application/json' -d '{"monto_abonado":999999}' $API/usuarios/$E2E_15/pago)"
check "config clave desconocida → 400" "desconocida" "$(curl -s -X PUT -H "Authorization: Bearer $TOKEN_ADMIN" -H 'Content-Type: application/json' -d '{"valor":"1"}' $API/configuracion/clave_rara)"
check "config monto inválido → 400" "entero entre" "$(curl -s -X PUT -H "Authorization: Bearer $TOKEN_ADMIN" -H 'Content-Type: application/json' -d '{"valor":"abc"}' $API/configuracion/monto_acompanante)"
check "eliminar último admin → 400" "último administrador" "$(curl -s -X DELETE -H "Authorization: Bearer $TOKEN_ADMIN" $API/usuarios/1)"
check "eliminar con pagos → 400 (protege caja)" "pagos registrados" "$(REG_DEL=$(curl -s -X POST $API/auth/registro -H 'Content-Type: application/json' -d '{"nombre":"Borrar Pagado","cedula":"555666777","email":"borrarpagado@e2e.com","password":"secret123","whatsapp":"3005556667"}'); ID_DEL=$(echo "$REG_DEL" | json "d['usuario']['id']"); curl -s -X POST -H "Authorization: Bearer $TOKEN_ADMIN" -H 'Content-Type: application/json' -d '{"monto":20000}' $API/usuarios/$ID_DEL/abono >/dev/null; curl -s -X DELETE -H "Authorization: Bearer $TOKEN_ADMIN" $API/usuarios/$ID_DEL)"
check "eliminar sin pagos → 200" "eliminado" "$(REG_OK=$(curl -s -X POST $API/auth/registro -H 'Content-Type: application/json' -d '{"nombre":"Borrar Limpio","cedula":"666777888","email":"borrarlimpio@e2e.com","password":"secret123","whatsapp":"3006667778"}'); ID_OK=$(echo "$REG_OK" | json "d['usuario']['id']"); curl -s -X DELETE -H "Authorization: Bearer $TOKEN_ADMIN" $API/usuarios/$ID_OK | tr '[:upper:]' '[:lower:]')"
check "quitar rol al último admin → 400" "último administrador" "$(curl -s -X PUT -H "Authorization: Bearer $TOKEN_ADMIN" -H 'Content-Type: application/json' -d '{"rol":"moderador"}' $API/usuarios/1/rol)"
check "PUT /me email inválido → 400" "no es válido" "$(curl -s -X PUT -H "Authorization: Bearer $TOKEN_ADMIN" $API/usuarios/me -H 'Content-Type: application/json' -d '{"email":"xxx"}')"

echo "=== 9b. Registro manual por staff (temporal automática) ==="
REG_MAN=$(curl -s -X POST -H "Authorization: Bearer $TOKEN_ADMIN" -H 'Content-Type: application/json' -d '{"nombre":"Manual E2E","cedula":"313233444","email":"manual@e2e.com","whatsapp":"3003132334"}' $API/usuarios)
check "admin registra → 201 + temporal" '"password_temporal"' "$REG_MAN"
check "manual con saldo base" '"saldo_pendiente": 50000' "$(echo "$REG_MAN" | python3 -c "import sys,json;print(json.dumps(json.load(sys.stdin)['usuario']))")"
check "mod registra → 201" '"password_temporal"' "$(curl -s -X POST -H "Authorization: Bearer $TOKEN_MOD" -H 'Content-Type: application/json' -d '{"nombre":"Manual Mod","cedula":"414233444","email":"manualmod@e2e.com","whatsapp":"3004142334"}' $API/usuarios)"
check "usuario NO registra → 403" "403" "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $TOKEN_USER" -H 'Content-Type: application/json' -d '{"nombre":"X","cedula":"515233444","email":"x@e2e.com","whatsapp":"3005152334"}' $API/usuarios)"
check "duplicado → 409" "ya están registrados" "$(curl -s -X POST -H "Authorization: Bearer $TOKEN_ADMIN" -H 'Content-Type: application/json' -d '{"nombre":"Dup","cedula":"313233444","email":"otro@e2e.com","whatsapp":"3006162334"}' $API/usuarios)"
check "sin whatsapp → 400" "obligatorios" "$(curl -s -X POST -H "Authorization: Bearer $TOKEN_ADMIN" -H 'Content-Type: application/json' -d '{"nombre":"Sin Wa","cedula":"616233444","email":"sinwa@e2e.com"}' $API/usuarios)"
TEMP_MAN=$(echo "$REG_MAN" | json "d['password_temporal']")
check "login del registrado manual con temporal" '"token"' "$(curl -s -X POST $API/auth/login -H 'Content-Type: application/json' -d "{\"email\":\"manual@e2e.com\",\"password\":\"$TEMP_MAN\"}")"
UUID_MAN=$(echo "$REG_MAN" | python3 -c "import sys,json;print(json.load(sys.stdin)['usuario'].get('uuid',''))")
check "uuid con formato v4" "^[0-9a-f-]*$" "$UUID_MAN"
python3 -c "import sys,uuid;uuid.UUID('$UUID_MAN', version=4)" 2>/dev/null && check "uuid válido v4" "OK" "OK" || check "uuid válido v4" "v4" "$UUID_MAN"
check "uuid del cliente se ignora" '"uuid-ignorado": false' "$(curl -s -X POST -H "Authorization: Bearer $TOKEN_ADMIN" -H 'Content-Type: application/json' -d '{"nombre":"UUID Ignorado","cedula":"717233444","email":"uuidign@e2e.com","whatsapp":"3007172334","uuid":"00000000-0000-0000-0000-000000000000"}' $API/usuarios | python3 -c "import sys,json;u=json.load(sys.stdin)['usuario'];print('{\"uuid-ignorado\": ' + str(u['uuid']=='00000000-0000-0000-0000-000000000000').lower() + '}')")"
ID_MAN=$(echo "$REG_MAN" | json "d['usuario']['id']")
curl -s -X PUT -H "Authorization: Bearer $TOKEN_ADMIN" -H 'Content-Type: application/json' -d "{\"uuid\":\"11111111-1111-1111-1111-111111111111\"}" $API/usuarios/$ID_MAN >/dev/null
check "PUT no cambia uuid" "$UUID_MAN" "$(curl -s -H "Authorization: Bearer $TOKEN_ADMIN" $API/usuarios/$ID_MAN | python3 -c "import sys,json;print(json.load(sys.stdin)['usuario']['uuid'])")"
echo "=== 9c. Cédula opcional con código interno 900… ==="
REG_SINCED=$(curl -s -X POST $API/auth/registro -H 'Content-Type: application/json' -d '{"nombre":"Sin Cedula Uno","email":"sinced1@e2e.com","password":"secret123","whatsapp":"3001112223"}')
check "registro sin cédula → 201" '"token"' "$REG_SINCED"
CED1=$(echo "$REG_SINCED" | python3 -c "import sys,json;print(json.load(sys.stdin)['usuario']['cedula'])")
check "código 900… asignado" "900" "$CED1"
REG_SINCED2=$(curl -s -X POST $API/auth/registro -H 'Content-Type: application/json' -d '{"nombre":"Sin Cedula Dos","email":"sinced2@e2e.com","password":"secret123","whatsapp":"3001112224"}')
CED2=$(echo "$REG_SINCED2" | python3 -c "import sys,json;print(json.load(sys.stdin)['usuario']['cedula'])")
check "segundo código consecutivo distinto" "OK" "$([ "$CED1" != "$CED2" ] && [ -n "$CED2" ] && echo OK || echo "iguales: $CED1/$CED2")"
check "manual sin cédula → 201" "900" "$(curl -s -X POST -H "Authorization: Bearer $TOKEN_ADMIN" -H 'Content-Type: application/json' -d '{"nombre":"Sin Cedula Manual","email":"sinced3@e2e.com","whatsapp":"3001112225"}' $API/usuarios | python3 -c "import sys,json;print(json.load(sys.stdin)['usuario']['cedula'])")"
check "cédula inválida sigue 400" "solo dígitos" "$(curl -s -X POST $API/auth/registro -H 'Content-Type: application/json' -d '{"nombre":"Mala Cedula","cedula":"abc","email":"malaced@e2e.com","password":"secret123","whatsapp":"3001112226"}')"

echo "=== 10. Abono manual admin ==="
E2E_ID=$(curl -s -H "Authorization: Bearer $TOKEN_ADMIN" $API/usuarios | python3 -c "import sys,json;print([u['id'] for u in json.load(sys.stdin) if u['email']=='prueba@e2e.com'][0])")
AB=$(curl -s -X POST -H "Authorization: Bearer $TOKEN_ADMIN" -H 'Content-Type: application/json' -d '{"monto":20000}' $API/usuarios/$E2E_ID/abono)
check "abono → estado abonado" '"estado_pago": "abonado"' "$(echo "$AB" | python3 -c "import sys,json;print(json.dumps(json.load(sys.stdin)['usuario']))")"
AB2=$(curl -s -X POST -H "Authorization: Bearer $TOKEN_ADMIN" -H 'Content-Type: application/json' -d '{"monto":40000}' $API/usuarios/$E2E_ID/abono)
check "abono que supera saldo → 400" "supera" "$AB2"

echo "=== 11. Reset de contraseña ==="
RST=$(curl -s -X PUT -H "Authorization: Bearer $TOKEN_MOD" $API/usuarios/$E2E_ID/reset-password)
check "mod resetea usuario y devuelve temporal" '"password_temporal"' "$RST"
TEMP=$(echo "$RST" | json "d['password_temporal']")
check "login con contraseña temporal" '"token"' "$(curl -s -X POST $API/auth/login -H 'Content-Type: application/json' -d "{\"email\":\"prueba@e2e.com\",\"password\":\"$TEMP\"}")"
check "mod NO resetea a otro moderador" "solo puede resetear" "$(curl -s -X PUT -H "Authorization: Bearer $TOKEN_MOD" $API/usuarios/2/reset-password)"
check "mod NO resetea al admin" "solo puede resetear" "$(curl -s -X PUT -H "Authorization: Bearer $TOKEN_MOD" $API/usuarios/1/reset-password)"

echo "=== 12. Preguntas / encuesta ==="
check "usuario ve solo preguntas activas" '¿Qué tipo de bebida' "$(curl -s -H "Authorization: Bearer $TOKEN_USER" $API/preguntas)"
check "mod NO crea preguntas" "permisos" "$(curl -s -X POST -H "Authorization: Bearer $TOKEN_MOD" -H 'Content-Type: application/json' -d '{"texto":"x","tipo":"texto"}' $API/preguntas)"
NP=$(curl -s -X POST -H "Authorization: Bearer $TOKEN_ADMIN" -H 'Content-Type: application/json' -d '{"texto":"Pregunta nueva E2E","tipo":"texto","es_obligatoria":0,"orden":99}' $API/preguntas)
NP_ID=$(echo "$NP" | json "d['pregunta']['id']")
check "admin crea pregunta" "Pregunta nueva E2E" "$NP"
check "borrar pregunta" "eliminada" "$(curl -s -X DELETE -H "Authorization: Bearer $TOKEN_ADMIN" $API/preguntas/$NP_ID)"

# Respuesta incompleta → error
check "encuesta incompleta → 400" "obligatoria" "$(curl -s -X POST -H "Authorization: Bearer $TOKEN_USER" -H 'Content-Type: application/json' -d '{"respuestas":[{"pregunta_id":1,"respuesta":["Cerveza"]}]}' $API/encuesta)"
ENC=$(curl -s -X POST -H "Authorization: Bearer $TOKEN_USER" -H 'Content-Type: application/json' -d '{"respuestas":[{"pregunta_id":1,"respuesta":["Cerveza","Ron"]},{"pregunta_id":2,"respuesta":"Ninguna"},{"pregunta_id":3,"respuesta":"No"},{"pregunta_id":4,"respuesta":["Salsa"]}]}' $API/encuesta)
check "encuesta válida → 201" "Gracias" "$ENC"
check "música máx 3 → 400 con 4" "máximo 3" "$(curl -s -X POST -H "Authorization: Bearer $TOKEN_E2E" -H 'Content-Type: application/json' -d '{"respuestas":[{"pregunta_id":1,"respuesta":["Cerveza"]},{"pregunta_id":2,"respuesta":"Ninguna"},{"pregunta_id":3,"respuesta":"No"},{"pregunta_id":4,"respuesta":["Salsa","Rock","Pop","Vallenato"]}]}' $API/encuesta)"
check "segunda vez → 400" "respondido" "$(curl -s -X POST -H "Authorization: Bearer $TOKEN_USER" -H 'Content-Type: application/json' -d '{"respuestas":[]}' $API/encuesta)"
check "mía" '"completada":true' "$(curl -s -H "Authorization: Bearer $TOKEN_USER" $API/encuesta/mia)"
check "admin ve respuestas" 'Prueba E2E\|usuario@e2e.com' "$(curl -s -H "Authorization: Bearer $TOKEN_ADMIN" $API/encuesta | head -c 4000)"
check "resumen por pregunta para gráficas" '"resumen"' "$(curl -s -H "Authorization: Bearer $TOKEN_ADMIN" $API/encuesta | head -c 4000)"
check "resumen cuenta la opción elegida" '"texto":"Cerveza","cantidad":1' "$(curl -s -H "Authorization: Bearer $TOKEN_ADMIN" $API/encuesta | tr -d ' ')"
check "export CSV solo admin" "403" "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN_MOD" $API/encuesta/exportar)"
check "export CSV admin" "Cedula" "$(curl -s -H "Authorization: Bearer $TOKEN_ADMIN" $API/encuesta/exportar | head -3)"

echo "=== 13. Inventario y entregas ==="
INV=$(curl -s -H "Authorization: Bearer $TOKEN_ADMIN" $API/inventario)
CERV=$CERV_ID
COM=$COM_ID
check "ingreso de stock" '"cantidad_disponible": 301' "$(curl -s -X POST -H "Authorization: Bearer $TOKEN_ADMIN" -H 'Content-Type: application/json' -d '{"cantidad":1,"motivo":"test"}' $API/inventario/$CERV/ingreso | python3 -c "import sys,json;print(json.dumps(json.load(sys.stdin)['producto']))")"
check "combo bloqueado sin pago total (abonado)" "no tiene el pago" "$(curl -s -X POST -H "Authorization: Bearer $TOKEN_MOD" -H 'Content-Type: application/json' -d "{\"usuario_id\":$E2E_ID,\"inventario_id\":$CERV,\"cantidad\":1,\"tipo\":\"combo\"}" $API/entregas)"
check "completar bloqueado sin pago total" "no tiene el pago" "$(curl -s -X POST -H "Authorization: Bearer $TOKEN_MOD" -H 'Content-Type: application/json' $API/entregas/$E2E_ID/completar)"
check "pagar saldo restante → pagado" '"estado_pago": "pagado"' "$(curl -s -X POST -H "Authorization: Bearer $TOKEN_ADMIN" -H 'Content-Type: application/json' -d '{"monto":30000}' $API/usuarios/$E2E_ID/abono | python3 -c "import sys,json;print(json.dumps(json.load(sys.stdin)['usuario']))")"
check "completar con faltantes → 400 (no fuerza)" "Aún faltan" "$(curl -s -X POST -H "Authorization: Bearer $TOKEN_MOD" -H 'Content-Type: application/json' $API/entregas/$E2E_ID/completar)"
check "entregar cerveza" "Combo entregado" "$(curl -s -X POST -H "Authorization: Bearer $TOKEN_MOD" -H 'Content-Type: application/json' -d "{\"usuario_id\":$E2E_ID,\"inventario_id\":$CERV,\"cantidad\":1,\"tipo\":\"combo\"}" $API/entregas)"
check "no entregar más de 4 cervezas" "solo tiene" "$(for i in 1 2 3 4; do curl -s -X POST -H "Authorization: Bearer $TOKEN_MOD" -H 'Content-Type: application/json' -d "{\"usuario_id\":$E2E_ID,\"inventario_id\":$CERV,\"cantidad\":1,\"tipo\":\"combo\"}" $API/entregas >/dev/null; done; curl -s -X POST -H "Authorization: Bearer $TOKEN_MOD" -H 'Content-Type: application/json' -d "{\"usuario_id\":$E2E_ID,\"inventario_id\":$CERV,\"cantidad\":1,\"tipo\":\"combo\"}" $API/entregas)"
check "fuera del combo → 400" "no forma parte" "$(AGUA=$(curl -s -X POST -H "Authorization: Bearer $TOKEN_ADMIN" -H 'Content-Type: application/json' -d '{"producto":"Agua","categoria":"bebida","cantidad_total":10,"precio_unitario":2000,"combo_por_persona":0}' $API/inventario | python3 -c "import sys,json;print(json.load(sys.stdin)['producto']['id'])"); curl -s -X POST -H "Authorization: Bearer $TOKEN_MOD" -H 'Content-Type: application/json' -d "{\"usuario_id\":$E2E_ID,\"inventario_id\":$AGUA,\"cantidad\":1,\"tipo\":\"combo\"}" $API/entregas | tr '[:upper:]' '[:lower:]')"
check "entregar comida completa el combo" '"combo_completado": 1' "$(curl -s -X POST -H "Authorization: Bearer $TOKEN_MOD" -H 'Content-Type: application/json' -d "{\"usuario_id\":$E2E_ID,\"inventario_id\":$COM,\"cantidad\":1,\"tipo\":\"combo\"}" $API/entregas >/dev/null; curl -s -H "Authorization: Bearer $TOKEN_MOD" $API/entregas/usuario/$E2E_ID | python3 -c "import sys,json;print(json.dumps({'combo_completado': 1 if json.load(sys.stdin)['combo']['completado'] else 0}))")"
check "completar ya entregado → 200 confirmado" "confirmado como entregado" "$(curl -s -X POST -H "Authorization: Bearer $TOKEN_MOD" -H 'Content-Type: application/json' $API/entregas/$E2E_ID/completar)"
check "usuario ve SU combo sin password_hash" '"items"' "$(curl -s -H "Authorization: Bearer $TOKEN_USER" $API/entregas/usuario/$UID_USER)"
check "respuesta no filtra password_hash" "no_password_hash" "$(curl -s -H "Authorization: Bearer $TOKEN_USER" $API/entregas/usuario/$UID_USER | grep -c password_hash | sed 's/0/no_password_hash/')"
check "venta extra genera ingreso en caja bebidas" 'Venta extra' "$(curl -s -X POST -H "Authorization: Bearer $TOKEN_ADMIN" -H 'Content-Type: application/json' -d "{\"usuario_id\":$UID_USER,\"inventario_id\":$COM,\"cantidad\":1,\"tipo\":\"venta_extra\"}" $API/entregas >/dev/null; curl -s -H "Authorization: Bearer $TOKEN_ADMIN" $API/cajas/bebidas/movimientos)"

echo "=== 13b. Tamaño máx de imagen configurable (solo admin, 0.5–3 MB) ==="
REG_IMG=$(curl -s -X POST $API/auth/registro -H 'Content-Type: application/json' -d '{"nombre":"Imagen E2E","cedula":"777666555","email":"imagen@e2e.com","password":"secret123","whatsapp":"3007776665"}')
TOKEN_IMG=$(echo "$REG_IMG" | json "d['token']")
head -c 600000 /dev/urandom > "$TMP/medio.png"
check "default 1 MB rechaza 1.2 MB" "máximo permitido de 1 MB" "$(curl -s -X POST -H "Authorization: Bearer $TOKEN_IMG" -F "archivo=@$TMP/grande2.png;type=image/png" -F "monto=20000" -F "tipo=abono" $API/soportes-pago)"
check "tamano 5 → 400" "hasta 3 MB" "$(curl -s -X PUT -H "Authorization: Bearer $TOKEN_ADMIN" -H 'Content-Type: application/json' -d '{"valor":"5"}' $API/configuracion/tamano_max_imagen_mb)"
check "tamano 0 → 400" "hasta 3 MB" "$(curl -s -X PUT -H "Authorization: Bearer $TOKEN_ADMIN" -H 'Content-Type: application/json' -d '{"valor":"0"}' $API/configuracion/tamano_max_imagen_mb)"
check "tamano abc → 400" "hasta 3 MB" "$(curl -s -X PUT -H "Authorization: Bearer $TOKEN_ADMIN" -H 'Content-Type: application/json' -d '{"valor":"abc"}' $API/configuracion/tamano_max_imagen_mb)"
check "tamano 0.2 → 200 (sin piso de 0.5)" "actualizada" "$(curl -s -X PUT -H "Authorization: Bearer $TOKEN_ADMIN" -H 'Content-Type: application/json' -d '{"valor":"0.2"}' $API/configuracion/tamano_max_imagen_mb | tr '[:upper:]' '[:lower:]')"
check "mod NO edita tamano → 403" "403" "$(curl -s -o /dev/null -w '%{http_code}' -X PUT -H "Authorization: Bearer $TOKEN_MOD" -H 'Content-Type: application/json' -d '{"valor":"2"}' $API/configuracion/tamano_max_imagen_mb)"
check "admin fija 3 MB" "actualizada" "$(curl -s -X PUT -H "Authorization: Bearer $TOKEN_ADMIN" -H 'Content-Type: application/json' -d '{"valor":"3"}' $API/configuracion/tamano_max_imagen_mb | tr '[:upper:]' '[:lower:]')"
check "con 3 MB acepta 1.2 MB" "pendiente" "$(curl -s -X POST -H "Authorization: Bearer $TOKEN_IMG" -F "archivo=@$TMP/grande2.png;type=image/png" -F "monto=20000" -F "tipo=abono" $API/soportes-pago)"
check "admin fija 0.5 MB" "actualizada" "$(curl -s -X PUT -H "Authorization: Bearer $TOKEN_ADMIN" -H 'Content-Type: application/json' -d '{"valor":"0.5"}' $API/configuracion/tamano_max_imagen_mb | tr '[:upper:]' '[:lower:]')"
check "con 0.5 MB rechaza 600 KB" "máximo permitido de 0.5 MB" "$(curl -s -X POST -H "Authorization: Bearer $TOKEN_IMG" -F "archivo=@$TMP/medio.png;type=image/png" -F "monto=20000" -F "tipo=abono" $API/soportes-pago)"
check "admin restaura 1 MB" '"valor": "1"' "$(curl -s -X PUT -H "Authorization: Bearer $TOKEN_ADMIN" -H 'Content-Type: application/json' -d '{"valor":"1"}' $API/configuracion/tamano_max_imagen_mb | python3 -c "import sys,json;print(json.dumps(json.load(sys.stdin)))")"

echo "=== 13c. Staff sube soporte por el usuario ==="
ID_IMG=$(curl -s -H "Authorization: Bearer $TOKEN_ADMIN" $API/usuarios | python3 -c "import sys,json;print([u['id'] for u in json.load(sys.stdin) if u['email']=='imagen@e2e.com'][0])")
SOP_STAFF=$(curl -s -X POST -H "Authorization: Bearer $TOKEN_MOD" -F "archivo=@$TMP/soporte.png;type=image/png" -F "monto=20000" -F "tipo=abono" -F "usuario_id=$ID_IMG" $API/soportes-pago)
check "mod sube por usuario → 201 pendiente" '"estado": "pendiente"' "$(echo "$SOP_STAFF" | python3 -c "import sys,json;print(json.dumps(json.load(sys.stdin)['soporte']))")"
check "dueño correcto" "\"usuario_id\": $ID_IMG" "$(echo "$SOP_STAFF" | python3 -c "import sys,json;print(json.dumps(json.load(sys.stdin)['soporte']))")"
check "usuario NO sube por otro → 403" "otro usuario" "$(curl -s -X POST -H "Authorization: Bearer $TOKEN_USER" -F "archivo=@$TMP/soporte.png;type=image/png" -F "monto=20000" -F "tipo=abono" -F "usuario_id=$ID_IMG" $API/soportes-pago | tr '[:upper:]' '[:lower:]')"
check "monto sobre saldo del dueño → 400" "supera" "$(curl -s -X POST -H "Authorization: Bearer $TOKEN_ADMIN" -F "archivo=@$TMP/soporte.png;type=image/png" -F "monto=999999" -F "tipo=abono" -F "usuario_id=$ID_IMG" $API/soportes-pago)"
check "usuario inexistente → 400" "no encontrado" "$(curl -s -X POST -H "Authorization: Bearer $TOKEN_ADMIN" -F "archivo=@$TMP/soporte.png;type=image/png" -F "monto=20000" -F "tipo=abono" -F "usuario_id=999999" $API/soportes-pago | tr '[:upper:]' '[:lower:]')"
check "para staff → 400" "solo se suben" "$(curl -s -X POST -H "Authorization: Bearer $TOKEN_ADMIN" -F "archivo=@$TMP/soporte.png;type=image/png" -F "monto=20000" -F "tipo=abono" -F "usuario_id=2" $API/soportes-pago | tr '[:upper:]' '[:lower:]')"

echo "=== 14. Configuración y dashboard ==="
check "admin edita config" "actualizada" "$(curl -s -X PUT -H "Authorization: Bearer $TOKEN_ADMIN" -H 'Content-Type: application/json' -d '{"valor":"3133506369"}' $API/configuracion/whatsapp_admin)"
check "config trae contacto admin/mod" '"nombre_admin"' "$(curl -s $API/configuracion)"
check "config trae hora del evento" '"hora_evento"' "$(curl -s $API/configuracion)"
check "mod NO edita config" "permisos" "$(curl -s -X PUT -H "Authorization: Bearer $TOKEN_MOD" -H 'Content-Type: application/json' -d '{"valor":"1"}' $API/configuracion/whatsapp_admin)"
check "dashboard" '"cajaInscripcion"' "$(curl -s -H "Authorization: Bearer $TOKEN_ADMIN" $API/dashboard/resumen)"
check "dashboard mod" '"stock"' "$(curl -s -H "Authorization: Bearer $TOKEN_MOD" $API/dashboard/resumen)"
check "cierre eliminado → 404" "404" "$(curl -s -o /dev/null -w '%{http_code}' -X PUT -H "Authorization: Bearer $TOKEN_ADMIN" $API/cajas/2/cerrar)"
check "movimiento manual siempre abierto" "Movimiento registrado" "$(curl -s -X POST -H "Authorization: Bearer $TOKEN_ADMIN" -H 'Content-Type: application/json' -d '{"tipo":"ingreso","concepto":"ajuste prueba","monto":1000}' $API/cajas/bebidas/movimiento | python3 -c "import sys,json;print(json.load(sys.stdin)['mensaje'])")"

echo ""
echo "================================"
echo "RESULTADO: ✅ $PASS correctas  ❌ $FAIL incorrectas"
# El script falla si alguna comprobación falló
[ "$FAIL" -eq 0 ]
