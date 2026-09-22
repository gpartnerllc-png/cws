# Droppfy X CWS-LOG+ — Sistema multi-dispositivo

## Por que em uma máquina aparecia e em outra não?

Os cadastros estavam no **localStorage do navegador** (só naquele PC/celular).  
Agora tudo fica no **servidor** (`backend/data/store.json`):

- Solicitações de cadastro  
- Lista do admin (liberar/recusar)  
- Produtos e vitrine  
- Pedidos  

Qualquer IP, smartphone ou computador com login vê os **mesmos dados**.

## Subir local

```bash
cd backend
cp ../.env.example .env   # opcional
npm install
npm run dev
```

Abra: **http://localhost:3000** (API + frontend)

### Admin padrão
- E-mail: `partner@droppfy.com`
- Senha: a que você definiu (hash só no servidor)

## Produção (acesso no mundo todo)

1. Hospede o backend (VPS, Railway, Render, Fly.io, etc.) com `PORT` e HTTPS  
2. Aponte o domínio / Cloudflare  
3. Configure `.env` (Telegram, Correios, Siscomex quando tiver certificado)  
4. **Não** commite a pasta `backend/data/` nem o `.env`

## Integrações (placeholders no .env)

| Item | Variável |
|------|----------|
| Telegram | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` |
| Correios | `CORREIOS_USER`, `CORREIOS_ACCESS_CODE`, … |
| Siscomex | `SISCOMEX_CERT_PATH`, `SISCOMEX_CERT_PASSWORD` |
| PIX / Hubs | ver `.env.example` |

Tokens **nunca** no HTML.

## API principal

- `POST /api/auth/register` — cadastro (pending)  
- `POST /api/auth/login`  
- `GET  /api/auth/users` — admin, todos os dispositivos  
- `PATCH /api/auth/users/:id/status` — liberar/recusar  
- `GET/POST /api/products`  
- `GET/POST /api/orders`  
- `POST /api/quote` — frete + impostos estimados  
