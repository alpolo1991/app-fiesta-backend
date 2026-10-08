#!/usr/bin/env bash
# Pruebas de VENTA / SALIDA de inventario (corre contra el servidor que
# indique FIESTA_TEST_URL; lo levanta npm test → test/run.js).
set -u
API="${FIESTA_TEST_URL:-http://localhost:4000/api}"
PASS=0; FAIL=0

check() { # descripcion esperado obtenido
  # Normaliza el JSON (Express lo emite compacto) conservando acentos
  local obt
  obt=$(printf '%s' "$3" | python3 -c 'import sys,json;print(json.dumps(json.load(sys.stdin), ensure_ascii=False))' 2>/dev/null) || obt="$3"
  if printf '%s' "$obt" | grep -qF "$2"; then PASS=$((PASS+1)); echo "  ✅ $1";
  else FAIL=$((FAIL+1)); echo "  ❌ $1"; echo "     esperado: $2"; echo "     obtenido(fin): ${obt: -300}"; fi
}
json() { python3 -c "import sys,json;d=json.load(sys.stdin);print(eval(sys.argv[1],{'d':d}))" "$1" 2>/dev/null; }

echo "=== 1. Login (usuario se registra) ==="
TA=$(curl -s -X POST $API/auth/login -H 'Content-Type: application/json' -d '{"email":"admin@fiesta.com","password":"admin123"}' | json "d['token']")
TM=$(curl -s -X POST $API/auth/login -H 'Content-Type: application/json' -d '{"email":"moderador@fiesta.com","password":"mod123"}' | json "d['token']")
REGU=$(curl -s -X POST $API/auth/registro -H 'Content-Type: application/json' -d '{"nombre":"Usuario Inv","cedula":"333444555","email":"inv@e2e.com","password":"user123","whatsapp":"3003334445"}')
TU=$(echo "$REGU" | json "d['token']")
[ -n "$TA" ] && check "login admin" OK OK || check "login admin" token "$TA"
[ -n "$TM" ] && check "login mod" OK OK || check "login mod" token "$TM"
[ -n "$TU" ] && check "registro+login usuario" OK OK || check "registro+login usuario" token "$TU"

echo "=== 2. Estado inicial del inventario (demo del seed) ==="
INV=$(curl -s -H "Authorization: Bearer $TA" $API/inventario)
CERV=$(echo "$INV" | python3 -c "import sys,json;print([p['id'] for p in json.load(sys.stdin)['productos'] if p['producto']=='Cerveza'][0])")
COMIDA=$(echo "$INV" | python3 -c "import sys,json;print([p['id'] for p in json.load(sys.stdin)['productos'] if p['producto']=='Comida'][0])")
[ -n "$CERV" ] && check "productos demo presentes" "OK" "OK" || check "productos demo presentes" "ids" "$CERV/$COMIDA"
check "campo vendido existe" '"vendido": 0' "$INV"
check "campo vendido_hoy existe" '"vendido_hoy": 0' "$INV"
DISP0=$(echo "$INV" | python3 -c "import sys,json;print([p['cantidad_disponible'] for p in json.load(sys.stdin)['productos'] if p['producto']=='Cerveza'][0])")
echo "  (stock inicial Cerveza: $DISP0)"

echo "=== 3. El MOD vende 5 cervezas ==="
V=$(curl -s -X POST -H "Authorization: Bearer $TM" -H 'Content-Type: application/json' -d '{"cantidad":5}' $API/inventario/$CERV/salida)
check "venta 201" "Venta registrada" "$V"
check "monto = 5 × 5000 = 25000" '"monto": 25000' "$V"
check "stock descontado automáticamente" "\"cantidad_disponible\": $((DISP0-5))" "$V"
check "cantidad_entregada suma 5" '"cantidad_entregada": 5' "$V"
check "ingreso en Caja de Bebidas" '"caja_bebidas"' "$V"
check "saldo caja bebidas = 25000" '"saldo": 25000' "$V"

echo "=== 4. Inventario refleja el monto vendido ==="
INV2=$(curl -s -H "Authorization: Bearer $TA" $API/inventario)
check "vendido = 25000" '"vendido": 25000' "$INV2"
check "vendido_hoy = 25000" '"vendido_hoy": 25000' "$INV2"

echo "=== 5. El ADMIN vende con monto manual ==="
VA=$(curl -s -X POST -H "Authorization: Bearer $TA" -H 'Content-Type: application/json' -d '{"cantidad":2,"monto":10000,"motivo":"promo barra"}' $API/inventario/$COMIDA/salida)
check "venta admin" "Venta registrada" "$VA"
check "monto manual 10000" '"monto": 10000' "$VA"
check "caja bebidas acumula 35000" '"saldo": 35000' "$VA"
check "motivo guardado en el movimiento" '"motivo": "promo barra"' "$(curl -s -H "Authorization: Bearer $TA" $API/inventario/movimientos)"

echo "=== 6. Venta asignada a un usuario ==="
E2E=$(curl -s -X POST $API/auth/registro -H 'Content-Type: application/json' -d '{"nombre":"Comprador","cedula":"555444333","email":"comprador@e2e.com","password":"secret123","whatsapp":"3005554443"}' | json "d['usuario']['id']")
if [ -n "$E2E" ]; then PASS=$((PASS+1)); echo "  ✅ registro de comprador (id=$E2E)"; else FAIL=$((FAIL+1)); echo "  ❌ registro de comprador: sin id"; fi
VU=$(curl -s -X POST -H "Authorization: Bearer $TM" -H 'Content-Type: application/json' -d "{\"cantidad\":3,\"usuario_id\":$E2E}" $API/inventario/$COMIDA/salida)
check "venta con comprador" "Venta registrada" "$VU"
check "concepto incluye al comprador" "Comprador" "$VU"
check "caja bebidas = 35000 + 45000" '"saldo": 80000' "$VU"
check "historial venta_extra del usuario" 'venta_extra' "$(curl -s -H "Authorization: Bearer $TA" $API/entregas/usuario/$E2E)"

echo "=== 7. Validaciones ==="
check "stock insuficiente → 400" "disponibles" "$(curl -s -X POST -H "Authorization: Bearer $TA" -H 'Content-Type: application/json' -d '{"cantidad":99999}' $API/inventario/$CERV/salida)"
check "cantidad 0 → 400" "entero entre 1" "$(curl -s -X POST -H "Authorization: Bearer $TA" -H 'Content-Type: application/json' -d '{"cantidad":0}' $API/inventario/$CERV/salida)"
check "cantidad no entera → 400" "entero" "$(curl -s -X POST -H "Authorization: Bearer $TA" -H 'Content-Type: application/json' -d '{"cantidad":2.5}' $API/inventario/$CERV/salida)"
check "monto negativo → 400" "inválido" "$(curl -s -X POST -H "Authorization: Bearer $TA" -H 'Content-Type: application/json' -d '{"cantidad":1,"monto":-5}' $API/inventario/$CERV/salida)"
check "producto inexistente → 404" "no encontrado" "$(curl -s -X POST -H "Authorization: Bearer $TA" -H 'Content-Type: application/json' -d '{"cantidad":1}' $API/inventario/99999/salida)"

echo "=== 8. Permisos (las salidas solo admin y moderador) ==="
check "rol usuario → 403" "permisos" "$(curl -s -X POST -H "Authorization: Bearer $TU" -H 'Content-Type: application/json' -d '{"cantidad":1}' $API/inventario/$CERV/salida)"
check "sin token → 401" "Sesión no iniciada" "$(curl -s -X POST -H 'Content-Type: application/json' -d '{"cantidad":1}' $API/inventario/$CERV/salida)"
check "mod NO puede hacer ingresos (admin only)" "permisos" "$(curl -s -X POST -H "Authorization: Bearer $TM" -H 'Content-Type: application/json' -d '{"cantidad":10}' $API/inventario/$CERV/ingreso)"

echo "=== 9. Movimientos y cajas ==="
MOV=$(curl -s -H "Authorization: Bearer $TM" $API/inventario/movimientos)
check "movimientos de salida registrados" '"tipo": "salida"' "$(echo "$MOV" | head -c 2000)"
check "3 salidas de inventario" '"tipo": "salida", "cantidad": 3' "$(echo "$MOV" | head -c 2000)"
CB=$(curl -s -H "Authorization: Bearer $TM" $API/cajas/bebidas/movimientos)
check "caja bebidas con movimientos Venta" "Venta" "$CB"
CI=$(curl -s -H "Authorization: Bearer $TM" $API/cajas/inscripcion/movimientos)
check "caja inscripción NO tocada por ventas" '"movimientos": []' "$CI"
check "vendido total = 80000" '"vendido": 80000' "$(curl -s -H "Authorization: Bearer $TA" $API/inventario)"

echo "=== 10. Nuevas validaciones caja-stock ==="
check "entrega cantidad 0 → 400" "mayor a 0" "$(curl -s -X POST -H "Authorization: Bearer $TA" -H 'Content-Type: application/json' -d "{\"usuario_id\":$E2E,\"inventario_id\":$COMIDA,\"cantidad\":0,\"tipo\":\"venta_extra\"}" $API/entregas)"
check "entrega cantidad texto → 400" "mayor a 0" "$(curl -s -X POST -H "Authorization: Bearer $TA" -H 'Content-Type: application/json' -d "{\"usuario_id\":$E2E,\"inventario_id\":$COMIDA,\"cantidad\":\"abc\",\"tipo\":\"venta_extra\"}" $API/entregas)"
check "pendientes incluye staff con su combo (trazabilidad)" 'admin@fiesta.com' "$(curl -s -H "Authorization: Bearer $TA" $API/entregas/pendientes)"
check "pendientes: 3 usuarios + staff" "5 False" "$(curl -s -H "Authorization: Bearer $TA" $API/entregas/pendientes | python3 -c "import sys,json;ds=json.load(sys.stdin);print(len(ds), any(u['email']=='nadie@e2e.com' for u in ds))")"
check "combos staff en dashboard" '"combosStaff"' "$(curl -s -H "Authorization: Bearer $TA" $API/dashboard/resumen)"
check "cortesía sin motivo → 400" "cortesía" "$(curl -s -X POST -H "Authorization: Bearer $TA" -H 'Content-Type: application/json' -d '{"cantidad":1,"monto":0}' $API/inventario/$COMIDA/salida)"
check "cortesía con motivo → 201" "Venta registrada" "$(curl -s -X POST -H "Authorization: Bearer $TA" -H 'Content-Type: application/json' -d '{"cantidad":1,"monto":0,"motivo":"premio barra"}' $API/inventario/$COMIDA/salida)"
check "ingreso float → 400" "entero" "$(curl -s -X POST -H "Authorization: Bearer $TA" -H 'Content-Type: application/json' -d '{"cantidad":2.5}' $API/inventario/$COMIDA/ingreso)"
check "editar cantidades → 400" "usa" "$(curl -s -X PUT -H "Authorization: Bearer $TA" -H 'Content-Type: application/json' -d '{"cantidad_total":999}' $API/inventario/$COMIDA)"
check "producto nombre largo → 400" "80 caracteres" "$(curl -s -X POST -H "Authorization: Bearer $TA" -H 'Content-Type: application/json' -d '{"producto":"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx","categoria":"otro"}' $API/inventario)"
check "caja concepto largo → 400" "200 caracteres" "$(curl -s -X POST -H "Authorization: Bearer $TA" -H 'Content-Type: application/json' -d "{\"tipo\":\"ingreso\",\"concepto\":\"$(python3 -c "print('y'*201)")\",\"monto\":1000}" $API/cajas/bebidas/movimiento)"

echo "=== 11. Ajuste de stock (solo admin) ==="
check "sin motivo → 400" "motivo" "$(curl -s -X POST -H "Authorization: Bearer $TA" -H 'Content-Type: application/json' -d '{"cantidad_disponible":50}' $API/inventario/$COMIDA/ajuste)"
check "negativo → 400" "entre 0 y 1000000" "$(curl -s -X POST -H "Authorization: Bearer $TA" -H 'Content-Type: application/json' -d '{"cantidad_disponible":-5,"motivo":"x"}' $API/inventario/$COMIDA/ajuste)"
check "total menor → 400" "no puede ser menor" "$(curl -s -X POST -H "Authorization: Bearer $TA" -H 'Content-Type: application/json' -d '{"cantidad_disponible":50,"cantidad_total":10,"motivo":"x"}' $API/inventario/$COMIDA/ajuste)"
check "mod → 403" "permisos" "$(curl -s -X POST -H "Authorization: Bearer $TM" -H 'Content-Type: application/json' -d '{"cantidad_disponible":50,"motivo":"x"}' $API/inventario/$COMIDA/ajuste)"
check "usuario → 403" "permisos" "$(curl -s -X POST -H "Authorization: Bearer $TU" -H 'Content-Type: application/json' -d '{"cantidad_disponible":50,"motivo":"x"}' $API/inventario/$COMIDA/ajuste)"
AJ=$(curl -s -X POST -H "Authorization: Bearer $TA" -H 'Content-Type: application/json' -d '{"cantidad_disponible":120,"motivo":"conteo inicial reservas"}' $API/inventario/$COMIDA/ajuste)
check "ajuste válido fija disponible" '"cantidad_disponible": 120' "$AJ"
check "queda en historial como ajuste" '"tipo": "ajuste"' "$(curl -s -H "Authorization: Bearer $TA" $API/inventario/movimientos | head -c 3000)"
check "sin cambios → 400" "Sin cambios" "$(curl -s -X POST -H "Authorization: Bearer $TA" -H 'Content-Type: application/json' -d '{"cantidad_disponible":120,"motivo":"otra vez"}' $API/inventario/$COMIDA/ajuste | head -c 300)"

echo ""
echo "RESULTADO: ✅ $PASS correctas  ❌ $FAIL incorrectas"
[ "$FAIL" -eq 0 ]
