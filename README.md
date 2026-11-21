# X CWS-LOG+ | Droppfy Logistics AI

Sistema de compras internacionais, cotação de frete e logística com backend real, site institucional com globo 3D e páginas legais.

## Arquitetura

- **Backend:** Cloudflare Workers (`worker.js`) — API completa
- **Banco:** Cloudflare D1 (SQLite) — migrações em `migrations/`
- **KV:** cache do câmbio USD→BRL (10 min)
- **R2:** armazenamento de imagens de produto (`/api/upload` → `/api/img/...`)
- **Workers AI:** assistente de descrição de produto (`/api/ai/describe`, Llama 3.3 70B)
- **Frontend:** SPA em `public/index.html` + site institucional (landing com globo 3D neural) + páginas legais (`termos`, `privacidade`, `lgpd`, `quem-somos`)
- **Câmbio:** USD→BRL ao vivo (economia.awesomeapi.com.br, cache KV + memória, fallback configurável)

## Integrações

- **Correios:** API oficial (token de contrato → preço e prazo reais). Sem contrato configurado, cai automaticamente na estimativa interna. Segredos: `CORREIOS_CLIENT_ID`, `CORREIOS_CLIENT_SECRET`, `CORREIOS_CONTRACT`.
- **Receita Federal / Remessa Conforme (regras de 12/05/2026):** até US$ 50 → II zero; acima de US$ 50 → II 60% com dedução de US$ 30; ICMS por UF (17–20%); IPI/PIS/COFINS não incidem para pessoa física.
- **PIX:** payload EMV/BRCode gerado no backend (chave só no secret store), QR renderizado no cliente.
- **Busca internacional:** conector Alibaba (API de afiliados) com origem oculta e cache de ofertas.

## Segurança

- Senhas: PBKDF2-SHA256 (100.000 iterações + salt) — **nunca** senha em texto puro no banco.
- **Nenhuma credencial fica no código.** Secrets (PIX_KEY, ALIBABA_APP_KEY/APP_SECRET, CORREIOS_*, TELEGRAM_*) são gravados só no secret store do Cloudflare via `wrangler secret put`.
- Hubs de envio (endereços fixos EUA/China) vivem só na tabela `hubs` do D1; o cliente e o lojista nunca os recebem — a API retorna apenas a nota genérica de centro de distribuição.
- Origem oculta: links de fornecedor (Alibaba/lojas) nunca saem do backend em rotas públicas; só o admin vê.
- Pagamento: o cliente nunca declara pagamento — só o admin confirma (status `paid`).
- **Não existe senha de admin fixa:** o primeiro cadastro no site vira administrador, com e-mail e senha escolhidos por ele.

## Como rodar local (prévia)

Duplo clique em `00-preview-local.bat` (ou `npx wrangler dev --port 8787`).

- http://127.0.0.1:8787 — **prévia local do projeto X CWS-LOG+ (pasta `6c18d36e/cws`)**
- O primeiro cadastro vira admin automaticamente.
- Hubs de teste locais: `dev-hubs-local.sql` (não vai para produção).

## Deploy (produção)

Duplo clique em `10-deploy-producao.bat` quando autorizado. O script:

1. cria o banco D1 remoto (se ainda não existir) e grava o `database_id` no `wrangler.toml`;
2. aplica as migrações no banco remoto;
3. configura os hubs ocultos no banco remoto;
4. pede as secrets uma a uma (digitadas direto no terminal, nunca no chat);
5. publica o Worker (KV, R2 e Workers AI já criados na conta);
6. verifica `/api/health` em produção.

## Papéis

| Papel | O que faz |
|-------|-----------|
| Cliente | Vê a vitrine, busca produtos (origem oculta), compra com PIX, acompanha pedidos |
| Lojista | Cadastra/edita/exclui seus produtos (com upload de imagem no R2 e descrição por IA) — tudo passa pela aprovação do admin |
| Admin | Libera usuários e produtos, gere pedidos (status, pagamento do agente, rastreio), edita hubs ocultos, vê saúde das integrações |

## Catálogo

- **EUA (Via EUA):** produtos Apple e Google com preço oficial em USD × dólar ao vivo + impostos Remessa Conforme.
- **China (Importado):** pronta-entrega 1 unidade, preços de referência; origem não aparece para o cliente.
- **Brasil (Nacional):** fornecedor Espaço Miami (22 produtos), preços em reais.
