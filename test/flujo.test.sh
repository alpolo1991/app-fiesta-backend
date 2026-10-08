#!/usr/bin/env bash
# Flujo completo end-to-end con todo el elenco:
# admin + moderador + 2 usuarios + 3 acompañantes (2 de uno, 1 del otro).
# Verifica persistencia cruzada: saldos, caja, combos, CSV, fichas y KPIs.
set -u
API="${FIESTA_TEST_URL:-http://localhost:4000/api}"
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

echo "=== F1. Elenco ==="
TA=$(curl -s -X POST $API/auth/login -H 'Content-Type: application/json' -d '{"email":"admin@fiesta.com","password":"admin123"}' | json "d['token']")
TOKEN_ADMIN=$TA
TM=$(curl -s -X POST $API/auth/login -H 'Content-Type: application/json' -d '{"email":"moderador@fiesta.com","password":"mod123"}' | json "d['token']")
TOKEN_MOD=$TM
TU1=$(curl -s -X POST $API/auth/registro -H 'Content-Type: application/json' -d '{"nombre":"Usuario Uno","cedula":"111222333","email":"uno@e2e.com","password":"user123","whatsapp":"3001112223"}' | json "d['token']")
[ -n "$TA" ] && check "login admin" "OK" "OK" || check "login admin" "token" "$TA"
[ -n "$TM" ] && check "login moderador" "OK" "OK" || check "login moderador" "token" "$TM"
[ -n "$TU1" ] && check "registro+login usuario 1" "OK" "OK" || check "registro+login usuario 1" "token" "$TU1"
UID1=$(curl -s -H "Authorization: Bearer $TOKEN_ADMIN" $API/usuarios | python3 -c "import sys,json;print([u['id'] for u in json.load(sys.stdin) if u['email']=='uno@e2e.com'][0])")
REG2=$(curl -s -X POST $API/auth/registro -H 'Content-Type: application/json' -d '{"nombre":"Usuario Dos","cedula":"222333444","email":"dos@e2e.com","password":"secret123","whatsapp":"3002223334"}')
TU2=$(echo "$REG2" | json "d['token']")
ID2=$(echo "$REG2" | json "d['usuario']['id']")
[ -n "$TU2" ] && check "registro usuario 2 con whatsapp" "OK" "OK" || check "registro usuario 2" "token" "$TU2"

echo "=== F2. Acompañantes: 1 para user1, 1 para user2 (máx 1) ==="
check "user1 agrega Ana" '"cantidad":1' "$(curl -s -X POST -H "Authorization: Bearer $TU1" -H 'Content-Type: application/json' -d '{"nombre":"Ana Flujo"}' $API/acompanantes)"
check "user1 2do → 400 (máximo 1)" "Máximo 1" "$(curl -s -X POST -H "Authorization: Bearer $TU1" -H 'Content-Type: application/json' -d '{"nombre":"Luis Flujo"}' $API/acompanantes)"
check "user2 agrega Marta" '"cantidad":1' "$(curl -s -X POST -H "Authorization: Bearer $TU2" -H 'Content-Type: application/json' -d '{"nombre":"Marta Flujo"}' $API/acompanantes)"
ME1=$(curl -s -H "Authorization: Bearer $TU1" $API/usuarios/me)
check "user1 saldo 50000+1×50000=100000" '"saldo_pendiente":100000' "$ME1"
check "user2 saldo 50000+50000=100000" '"saldo_pendiente":100000' "$(curl -s -H "Authorization: Bearer $TU2" $API/usuarios/me)"

echo "=== F2b. Inventario demo del seed (combo) ==="
INVF=$(curl -s -H "Authorization: Bearer $TOKEN_ADMIN" $API/inventario)
CERV=$(echo "$INVF" | python3 -c "import sys,json;print([p['id'] for p in json.load(sys.stdin)['productos'] if p['producto']=='Cerveza'][0])")
COM=$(echo "$INVF" | python3 -c "import sys,json;print([p['id'] for p in json.load(sys.stdin)['productos'] if p['producto']=='Comida'][0])")
[ -n "$CERV" ] && check "productos combo presentes" "OK" "OK" || check "productos combo presentes" "ids" "$CERV/$COM"

echo "=== F3. Soportes: abono + pago total ==="
python3 -c "
import struct,zlib
def chunk(t,d):
    import struct as s,zlib as z
    c=s.pack('>I',len(d))+t+d
    return c+s.pack('>I',z.crc32(t+d)&0xffffffff)
raw=b''.join(b'\x00'+bytes([(i*7)%256,(i*13)%256,(i*29)%256])*40 for i in range(40))
data=b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',40,40,8,2,0,0,0))+chunk(b'IDAT',zlib.compress(raw))+chunk(b'IEND',b'')
open('$TMP/s.png','wb').write(data)
"
S1=$(curl -s -X POST -H "Authorization: Bearer $TU1" -F "archivo=@$TMP/s.png;type=image/png" -F "monto=50000" -F "tipo=abono" $API/soportes-pago)
S1_ID=$(echo "$S1" | json "d['soporte']['id']")
APR1=$(curl -s -X PUT -H "Authorization: Bearer $TOKEN_MOD" -H 'Content-Type: application/json' -d '{"comentario":"verificado"}' $API/soportes-pago/$S1_ID/aprobar)
check "mod aprueba abono user1" '"estado_pago":"abonado"' "$APR1"
COMBOF1=$(curl -s -H "Authorization: Bearer $TOKEN_ADMIN" $API/entregas/usuario/$UID1)
check "abono cubre base, 0 pagos → 1 persona, 4 cervezas" '"requerido": 4' "$(echo "$COMBOF1" | python3 -c "import sys,json;d=json.load(sys.stdin);print(json.dumps([i for i in d['combo']['items'] if i['producto']=='Cerveza'][0]))")"
S2=$(curl -s -X POST -H "Authorization: Bearer $TU1" -F "archivo=@$TMP/s.png;type=image/png" -F "monto=1" -F "tipo=pago_total" $API/soportes-pago)
S2_ID=$(echo "$S2" | json "d['soporte']['id']")
APR2=$(curl -s -X PUT -H "Authorization: Bearer $TOKEN_ADMIN" -H 'Content-Type: application/json' -d '{"comentario":"pago completo ok"}' $API/soportes-pago/$S2_ID/aprobar)
check "admin aprueba total user1 → pagado" '"estado_pago":"pagado"' "$APR2"
COMBOF2=$(curl -s -H "Authorization: Bearer $TOKEN_ADMIN" $API/entregas/usuario/$UID1)
check "1 acompañante pagado → 2 personas, 8 cervezas" '"requerido": 8' "$(echo "$COMBOF2" | python3 -c "import sys,json;d=json.load(sys.stdin);print(json.dumps([i for i in d['combo']['items'] if i['producto']=='Cerveza'][0]))")"
INV_R=$(curl -s -H "Authorization: Bearer $TOKEN_ADMIN" $API/inventario)
check "al pagar total se reserva stock (292 disp, 8 res)" '"cantidad_disponible": 292' "$(echo "$INV_R" | python3 -c "import sys,json;print(json.dumps([p for p in json.load(sys.stdin)['productos'] if p['producto']=='Cerveza'][0]))")"
check "reserva registrada en movimientos" '"tipo":"reserva"' "$(curl -s -H "Authorization: Bearer $TOKEN_ADMIN" $API/inventario/movimientos | head -c 3000 | tr -d ' ')"
check "revisor registrado" 'revisado_por_nombre' "$(curl -s -H "Authorization: Bearer $TOKEN_ADMIN" "$API/soportes-pago?estado=todas&usuario_id=$UID1")"
S3=$(curl -s -X POST -H "Authorization: Bearer $TU2" -F "archivo=@$TMP/s.png;type=image/png" -F "monto=1" -F "tipo=pago_total" $API/soportes-pago)
S3_ID=$(echo "$S3" | json "d['soporte']['id']")
APR3=$(curl -s -X PUT -H "Authorization: Bearer $TOKEN_MOD" -H 'Content-Type: application/json' $API/soportes-pago/$S3_ID/aprobar)
COMBOF3=$(curl -s -H "Authorization: Bearer $TOKEN_ADMIN" $API/entregas/usuario/$ID2)
check "user2 pagado → 2 personas, 8 cervezas" '"requerido": 8' "$(echo "$COMBOF3" | python3 -c "import sys,json;d=json.load(sys.stdin);print(json.dumps([i for i in d['combo']['items'] if i['producto']=='Cerveza'][0]))")"

echo "=== F4. Persistencia cruzada: caja, KPIs, CSV, ficha ==="
CI=$(curl -s -H "Authorization: Bearer $TOKEN_ADMIN" $API/cajas/inscripcion/movimientos)
check "caja inscripción = 100000+100000" '"saldo":200000' "$CI"
RES=$(curl -s -H "Authorization: Bearer $TOKEN_ADMIN" $API/dashboard/resumen)
check "personal = 3 usuarios + 2 acompañantes" '"total":5' "$RES"
check "por cobrar = 50000 (usuario demo)" '"porCobrar":50000' "$RES"
check "recaudado = 200000" '"recaudado":200000' "$RES"
check "ganancias total = 200000" '"total": 200000' "$(echo "$RES" | python3 -c "import sys,json;print(json.dumps(json.load(sys.stdin)['ganancias']))")"
check "2 inscripciones confirmadas" '"inscripcionesConfirmadas": 2' "$(echo "$RES" | python3 -c "import sys,json;print(json.dumps(json.load(sys.stdin)['ganancias']))")"
check "2 acompañantes confirmados" '"acompanantesConfirmados": 2' "$(echo "$RES" | python3 -c "import sys,json;print(json.dumps(json.load(sys.stdin)['ganancias']))")"
check "KPI acompañantes 2×100000" '"acompanantes":{"cantidad":2,"total":100000}' "$RES"
CSV=$(curl -s -H "Authorization: Bearer $TOKEN_ADMIN" "$API/soportes-pago/exportar?estado=aprobado")
check "CSV trae a Ana y Marta" "Ana Flujo" "$CSV"
check "CSV trae motivo del revisor" "pago completo ok" "$CSV"
FICHA=$(curl -s -H "Authorization: Bearer $TOKEN_ADMIN" $API/usuarios/$UID1)
check "ficha user1 con 1 acompañante" '"cantidad":1' "$FICHA"

echo "=== F5. Entregas del combo ==="
for i in $(seq 1 8); do curl -s -X POST -H "Authorization: Bearer $TOKEN_MOD" -H 'Content-Type: application/json' -d "{\"usuario_id\":$UID1,\"inventario_id\":$CERV,\"cantidad\":1,\"tipo\":\"combo\"}" $API/entregas >/dev/null; done
for i in 1 2; do curl -s -X POST -H "Authorization: Bearer $TOKEN_MOD" -H 'Content-Type: application/json' -d "{\"usuario_id\":$UID1,\"inventario_id\":$COM,\"cantidad\":1,\"tipo\":\"combo\"}" $API/entregas >/dev/null; done
check "combo 8/2 completado" '"completado":true' "$(curl -s -H "Authorization: Bearer $TOKEN_MOD" $API/entregas/usuario/$UID1 | python3 -c "import sys,json;d=json.load(sys.stdin);print('{\"completado\":'+str(d['combo']['completado']).lower()+'}')")"
check "9na cerveza excede (máx 8)" "solo tiene" "$(curl -s -X POST -H "Authorization: Bearer $TOKEN_MOD" -H 'Content-Type: application/json' -d "{\"usuario_id\":$UID1,\"inventario_id\":$CERV,\"cantidad\":1,\"tipo\":\"combo\"}" $API/entregas)"

echo "=== F5b. Completado no queda stale al pagar acompañante (regla estricta) ==="
REG3=$(curl -s -X POST $API/auth/registro -H 'Content-Type: application/json' -d '{"nombre":"Usuario Tres","cedula":"333444555","email":"tres@e2e.com","password":"secret123","whatsapp":"3003334445"}')
TU3=$(echo "$REG3" | json "d['token']")
ID3=$(echo "$REG3" | json "d['usuario']['id']")
check "combo bloqueado sin pago (no_pago)" "no tiene el pago" "$(curl -s -X POST -H "Authorization: Bearer $TOKEN_MOD" -H 'Content-Type: application/json' -d "{\"usuario_id\":$ID3,\"inventario_id\":$CERV,\"cantidad\":1,\"tipo\":\"combo\"}" $API/entregas)"
check "completar bloqueado sin pago" "no tiene el pago" "$(curl -s -X POST -H "Authorization: Bearer $TOKEN_MOD" -H 'Content-Type: application/json' $API/entregas/$ID3/completar)"
curl -s -X POST -H "Authorization: Bearer $TOKEN_ADMIN" -H 'Content-Type: application/json' -d '{"monto":50000}' $API/usuarios/$ID3/abono >/dev/null
for i in 1 2 3 4; do curl -s -X POST -H "Authorization: Bearer $TOKEN_MOD" -H 'Content-Type: application/json' -d "{\"usuario_id\":$ID3,\"inventario_id\":$CERV,\"cantidad\":1,\"tipo\":\"combo\"}" $API/entregas >/dev/null; done
curl -s -X POST -H "Authorization: Bearer $TOKEN_MOD" -H 'Content-Type: application/json' -d "{\"usuario_id\":$ID3,\"inventario_id\":$COM,\"cantidad\":1,\"tipo\":\"combo\"}" $API/entregas >/dev/null
check "base completa → completado" '"estado_combo": "completado"' "$(curl -s -H "Authorization: Bearer $TOKEN_MOD" $API/entregas/pendientes | python3 -c "import sys,json;print(json.dumps([u for u in json.load(sys.stdin) if u['email']=='tres@e2e.com'][0]))")"
curl -s -X POST -H "Authorization: Bearer $TU3" -H 'Content-Type: application/json' -d '{"nombre":"Hijo Flujo"}' $API/acompanantes >/dev/null
check "con acompañante sin pagar sigue completado (base)" '"estado_combo": "completado"' "$(curl -s -H "Authorization: Bearer $TOKEN_MOD" $API/entregas/pendientes | python3 -c "import sys,json;print(json.dumps([u for u in json.load(sys.stdin) if u['email']=='tres@e2e.com'][0]))")"
curl -s -X POST -H "Authorization: Bearer $TOKEN_ADMIN" -H 'Content-Type: application/json' -d '{"monto":50000}' $API/usuarios/$ID3/abono >/dev/null
check "al pagar acompañante vuelve a parcial (no stale)" '"estado_combo": "parcial"' "$(curl -s -H "Authorization: Bearer $TOKEN_MOD" $API/entregas/pendientes | python3 -c "import sys,json;print(json.dumps([u for u in json.load(sys.stdin) if u['email']=='tres@e2e.com'][0]))")"
check "grupo cliente completado + acompañante pendiente" '"cliente": "completado"' "$(curl -s -H "Authorization: Bearer $TOKEN_MOD" $API/entregas/usuario/$ID3 | python3 -c "import sys,json;print(json.dumps(json.load(sys.stdin)['combo']))")"

echo "=== F6. Claves: recuperar → solicitud → reset → login ==="
curl -s -X POST $API/auth/recuperar -H 'Content-Type: application/json' -d '{"email":"dos@e2e.com"}' >/dev/null
check "solicitud visible para admin" 'dos@e2e.com' "$(curl -s -H "Authorization: Bearer $TOKEN_ADMIN" $API/recuperaciones)"
RST=$(curl -s -X PUT -H "Authorization: Bearer $TOKEN_MOD" $API/usuarios/$ID2/reset-password)
TEMP=$(echo "$RST" | json "d['password_temporal']")
check "reset devuelve temporal + whatsapp" '"whatsapp"' "$RST"
check "solicitud atendida sola" '"cantidad":0' "$(curl -s -H "Authorization: Bearer $TOKEN_ADMIN" $API/recuperaciones)"
check "login con temporal" '"token"' "$(curl -s -X POST $API/auth/login -H 'Content-Type: application/json' -d "{\"email\":\"dos@e2e.com\",\"password\":\"$TEMP\"}")"

echo "=== F7. RBAC del elenco ==="
check "usuario no lista usuarios" "403" "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TU2" $API/usuarios)"
check "mod no edita config" "403" "$(curl -s -o /dev/null -w '%{http_code}' -X PUT -H "Authorization: Bearer $TOKEN_MOD" -H 'Content-Type: application/json' -d '{"valor":"x"}' $API/configuracion/lugar_evento)"
check "mod no borra usuarios" "403" "$(curl -s -o /dev/null -w '%{http_code}' -X DELETE -H "Authorization: Bearer $TOKEN_MOD" $API/usuarios/$ID2)"

echo ""
echo "Resultado flujo completo: $PASS OK, $FAIL errores"
[ "$FAIL" -eq 0 ]
