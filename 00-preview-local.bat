@echo off
title X CWS-LOG+ Droppfy - PREVIA LOCAL
echo.
echo ============================================================
echo  X CWS-LOG+ ^| Droppfy Logistics AI  -  PREVIA LOCAL
echo  Projeto: pasta Documents\Qoder\2026-11-20\6c18d36e\cws
echo  URL: http://127.0.0.1:8787  (esta porta e so deste projeto)
echo ============================================================
echo.
cd /d "%~dp0"
echo [1/3] Aplicando migracoes no banco local...
call npx wrangler d1 migrations apply xcws-droppfy-db --local
echo [2/3] Configurando hubs ocultos locais (EUA e China)...
call npx wrangler d1 execute xcws-droppfy-db --local --file=dev-hubs-local.sql
echo [3/3] Subindo o servidor local...
echo.
echo  Abra no navegador: http://127.0.0.1:8787
echo  O primeiro cadastro vira ADMIN automaticamente.
echo  Para encerrar, feche esta janela.
echo.
call npx wrangler dev --local --port 8787
pause
