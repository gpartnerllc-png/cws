@echo off
title X CWS-LOG+ Droppfy - DEPLOY PRODUCAO
echo.
echo ============================================================
echo  DEPLOY PRODUCAO - X CWS-LOG+ (xcws.droppfy.com)
echo  ATENCAO: grava no banco D1 REMOTO "xcws-droppfy-db".
echo  So rodar quando o deploy estiver autorizado.
echo ============================================================
echo.
cd /d "%~dp0"
echo [1/8] Criando o banco D1 remoto (se ainda nao existir)...
call npx wrangler d1 create xcws-droppfy-db
if errorlevel 1 echo    (banco ja existia ou deu erro - confira acima)
echo [2/8] Aplicando migracoes no banco remoto...
call npx wrangler d1 migrations apply xcws-droppfy-db --remote
echo [3/8] Configurando os hubs ocultos (EUA e China) no banco remoto...
call npx wrangler d1 execute xcws-droppfy-db --remote --file=dev-hubs-local.sql
echo [4/8] Secrets - digite cada valor DIRETO NO TERMINAL (nunca no chat):
echo        Enter vazio pula (ex.: Telegram opcional).
call npx wrangler secret put PIX_KEY
call npx wrangler secret put PIX_BENEFICIARY_NAME
call npx wrangler secret put PIX_CITY
call npx wrangler secret put ALIBABA_APP_KEY
call npx wrangler secret put ALIBABA_APP_SECRET
echo        CORREIOS (contrato da API oficial: token + preco/prazo reais).
echo        Sem contrato o sistema usa estimativa interna automaticamente.
call npx wrangler secret put CORREIOS_CLIENT_ID
call npx wrangler secret put CORREIOS_CLIENT_SECRET
call npx wrangler secret put CORREIOS_CONTRACT
call npx wrangler secret put TELEGRAM_BOT_TOKEN
call npx wrangler secret put TELEGRAM_CHAT_ID
echo [5/8] Publicando o Worker (KV, R2 e Workers AI ja estao criados)...
call npx wrangler deploy
echo [6/8] Verificando a saude da producao...
curl -s https://xcws.droppfy.com/api/health
echo.
echo [7/8] Lembrete: para ligar o dominio xcws.droppfy.com ao Worker,
echo        no painel Cloudflare: Workers and Pages ^> xcws-droppfy ^>
echo        Settings ^> Domains and Routes ^> Add ^> Custom Domain.
echo [8/8] PRIMEIRO ACESSO - quem se cadastrar primeiro no site
echo        vira o ADMIN (crie sua conta com seu e-mail e senha).
echo.
echo  Concluido.
pause
