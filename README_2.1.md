# QuizFreeOnline 2.1

Mejoras sobre 2.0:
- participant_id único por navegador/dispositivo.
- Una sola respuesta por participante y pregunta (UPSERT).
- Cambiar una respuesta actualiza la anterior, no la duplica.
- Columna correct_answer en CSV/XLSX.
- correct_answer acepta texto o letra A-J.
- Selección múltiple acepta respuestas correctas separadas por |.
- Estadística de porcentaje de aciertos.
- Exportación CSV/XLSX incluye respuesta correcta y correcto/incorrecto.

## Formato de importación
question,type,options,correct_answer
"¿Capital de Chile?",single,"Santiago|Valparaíso|Concepción",Santiago
"2+2",single,"3|4|5|6",B

## Despliegue seguro
Crear un servicio Render separado para 2.1 durante las pruebas. No reemplazar 2.0 hasta validar. La migración de columnas es automática al iniciar.
