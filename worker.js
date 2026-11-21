/**
 * X CWS-LOG+ | Droppfy Logistics AI — API (Cloudflare Workers + D1)
 * Hubs de envio (EUA/China) vivem só no banco e nunca são retornados
 * para cliente ou lojista — apenas admin vê.
 */

/* Remessa Conforme (regras vigentes desde 12/05/2026 — MP 1.357/2026):
   até US$ 50 → II 0%; acima → II 60% com desconto de US$ 30.
   IPI/PIS/COFINS não incidem em remessa de pessoa física.
   ICMS: 17–20% conforme a UF (Receita Federal). */
const TAX_RATES = {
  RC_LIMIT_USD: 50, RC_II_RATE: 0.60, RC_II_DEDUCTION_USD: 30,
  ICMS: { SP: 0.18, RJ: 0.20, MG: 0.18, RS: 0.18, PR: 0.18, SC: 0.17, BA: 0.205, DF: 0.18, default: 0.18 }
};

const ORDER_STATUSES = ['awaiting_payment', 'paid', 'supplier_ordered', 'at_hub', 'forwarded_br', 'delivered', 'cancelled'];
const AGENT_PAY_METHODS = ['PayPal', 'Inter', 'Nomad', 'Bitbank'];
const HUB_COUNTRIES = ['US', 'CN'];

const ALLOWED_ORIGINS = [
  'https://xcws.droppfy.com',
  'https://www.xcws.droppfy.com',
  'http://127.0.0.1:8787',
  'http://localhost:8787',
  'http://127.0.0.1:3000',
  'http://localhost:3000'
];

const json = (data, status = 200, origin) => {
  const headers = { 'Content-Type': 'application/json; charset=utf-8' };
  if (origin) headers['Access-Control-Allow-Origin'] = origin;
  return new Response(JSON.stringify(data), { status, headers });
};

const bad = (msg, status = 400, origin) => json({ error: msg }, status, origin);

/* ---------- Senha: PBKDF2 (só hash no banco) ---------- */
const toHex = (buf) => Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');

async function hashPassword(pass) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 }, key, 256
  );
  return `pbkdf2$${toHex(salt)}$${toHex(bits)}`;
}

async function verifyPassword(pass, stored) {
  try {
    const [, saltHex, hashHex] = stored.split('$');
    const salt = Uint8Array.from(saltHex.match(/.{2}/g).map((h) => parseInt(h, 16)));
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 }, key, 256
    );
    return toHex(bits) === hashHex;
  } catch {
    return false;
  }
}

/* ---------- Sessões ---------- */
function newToken() {
  return crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
}

async function createSession(env, userId) {
  const token = newToken();
  const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  await env.DB.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)')
    .bind(token, userId, expires).run();
  return token;
}

async function sessionUser(env, token) {
  if (!token) return null;
  const s = await env.DB.prepare(
    'SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > ?'
  ).bind(token, new Date().toISOString()).first();
  return s || null;
}

const publicUser = (u) => ({ id: u.id, nome: u.nome, email: u.email, whats: u.whats, role: u.role, status: u.status, created_at: u.created_at });

/* ---------- Câmbio USD→BRL ao vivo (cache 10 min) ---------- */
let fxCache = { value: 0, at: 0, source: 'none' };

async function getFx(env) {
  if (fxCache.value > 0 && Date.now() - fxCache.at < 10 * 60 * 1000) return fxCache;
  const fallback = parseFloat(env.USD_BRL_FALLBACK || '5.50') || 5.50;
  if (env.FX_CACHE) {
    try {
      const raw = await env.FX_CACHE.get('fx_usd_brl', 'json');
      if (raw && raw.value > 0 && Date.now() - raw.at < 10 * 60 * 1000) {
        fxCache = raw;
        return raw;
      }
    } catch (_) { /* KV indisponível: usa memória/fallback */ }
  }
  try {
    const resp = await fetch('https://economia.awesomeapi.com.br/json/last/USD-BRL', {
      headers: { 'User-Agent': 'droppfy-fx/1.0' }
    });
    if (resp.ok) {
      const data = await resp.json();
      const v = parseFloat(data && data.USDBRL && data.USDBRL.bid);
      if (v > 0) {
        fxCache = { value: v, at: Date.now(), source: 'awesomeapi.com.br (USD-BRL bid)' };
        if (env.FX_CACHE) {
          try { await env.FX_CACHE.put('fx_usd_brl', JSON.stringify(fxCache), { expirationTtl: 600 }); } catch (_) {}
        }
        return fxCache;
      }
    }
  } catch (_) { /* fallback abaixo */ }
  return { value: fallback, at: 0, source: 'fallback configurado' };
}

/* ---------- Precificação (mesma régua do sistema atual) ---------- */
function priceAllIn(p, fx) {
  const cost = Number(p.cost_usd) || 0;
  const margin = 1 + (Number(p.margin_pct) || 0) / 100;
  if (p.hub === 'BR') {
    const base = cost * fx;
    const frete = 25;
    const total = (base + frete) * margin;
    return { frete, impostos: 0, total: Number(total.toFixed(2)), breakdown: {} };
  }
  const freightUsd = Number(p.freight_usd) || 0;
  const aduaneiroUSD = cost + freightUsd;
  const aduaneiro = aduaneiroUSD * fx;
  const ii = aduaneiroUSD <= TAX_RATES.RC_LIMIT_USD
    ? 0
    : Math.max(0, aduaneiroUSD * TAX_RATES.RC_II_RATE - TAX_RATES.RC_II_DEDUCTION_USD) * fx;
  const icms = aduaneiro * TAX_RATES.ICMS.default;
  const impostos = ii + icms;
  const freteBR = 45;
  const total = (aduaneiro + impostos + freteBR) * margin;
  return {
    frete: freteBR,
    impostos: Number(impostos.toFixed(2)),
    total: Number(total.toFixed(2)),
    regime: aduaneiroUSD <= TAX_RATES.RC_LIMIT_USD ? 'remessa_conforme_ate_50' : 'remessa_conforme_acima_50',
    breakdown: {
      II: Number(ii.toFixed(2)), IPI: 0, PIS: 0, COFINS: 0, ICMS: Number(icms.toFixed(2))
    }
  };
}

const withPricing = (p, fx) => ({ ...p, pricing: priceAllIn(p, fx), fx });

/* ---------- PIX (chave só no secret store; payload montado aqui) ---------- */
function pixCrc16(payload) {
  let crc = 0xffff;
  for (let i = 0; i < payload.length; i++) {
    crc ^= payload.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) : (crc << 1);
  }
  return (crc & 0xffff).toString(16).toUpperCase().padStart(4, '0');
}

function pixPayload(env, valor) {
  const key = (env.PIX_KEY || '').trim();
  if (!key) return null;
  const f = (id, val) => `${id}${String(val.length).padStart(2, '0')}${val}`;
  const conta = f('00', 'br.gov.bcb.pix') + f('01', key);
  const name = (env.PIX_BENEFICIARY_NAME || 'Partner Holding').slice(0, 25);
  const city = (env.PIX_CITY || 'Brasilia').slice(0, 15);
  let payload = '000201' + f('26', conta) + '52040000' + '5303986' +
    f('54', Number(valor).toFixed(2)) + '5802BR' + f('59', name) + f('60', city) + '62070503***' + '6304';
  return payload + pixCrc16(payload);
}

/* ---------- Telegram (opcional: só se os secrets existirem) ---------- */
async function notifyTelegram(env, text) {
  const token = (env.TELEGRAM_BOT_TOKEN || '').trim();
  const chat = (env.TELEGRAM_CHAT_ID || '').trim();
  if (!token || !chat) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text })
    });
  } catch (_) { /* notificação é best-effort */ }
}

/* ---------- Correios: API oficial (ativada por secrets do contrato) ----------
   O serviço SOAP público (ws.correios.com.br) foi descontinuado.
   Com CORREIOS_CLIENT_ID / CORREIOS_CLIENT_SECRET / CORREIOS_CONTRACT no secret
   store, a cotação usa a API oficial (apigw.correios.com.br); sem elas,
   mantém a heurística local. */
const CORREIOS_SERVICES = { '04014': true, '04510': true, '04790': true, '04804': true };

async function correiosPrecoPrazo(env, cepO, cepD, peso, alt, larg, comp, servico) {
  const cid = (env.CORREIOS_CLIENT_ID || '').trim();
  const csec = (env.CORREIOS_CLIENT_SECRET || '').trim();
  const contrato = (env.CORREIOS_CONTRACT || '').trim();
  if (!cid || !csec || !contrato) return null;
  if (!CORREIOS_SERVICES[servico]) return null;
  try {
    const tokenRes = await fetch('https://apigw.correios.com.br/token/v1/autentica/contrato', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Basic ' + btoa(cid + ':' + csec)
      },
      body: JSON.stringify({ numero: contrato })
    });
    if (!tokenRes.ok) return null;
    const tk = await tokenRes.json();
    const access = tk.token || tk.access_token || (tk.data && (tk.data.token || tk.data.access_token));
    if (!access) return null;
    const precoRes = await fetch(
      `https://apigw.correios.com.br/preco/v1/nacional/${cepD}?cepOrigem=${cepO}&psObjeto=${servico}&tpObjeto=2&comprimento=${comp}&largura=${larg}&altura=${alt}&peso=${peso}&servicosAdicionais=&vlDeclarado=0`,
      { headers: { 'Authorization': 'Bearer ' + access } }
    );
    if (!precoRes.ok) return null;
    const pd = await precoRes.json();
    const itens = pd.itens || pd.data || pd;
    const arr = Array.isArray(itens) ? itens : [itens];
    const item = arr.find((x) => x && (x.pcFinal || x.preco || x.valor));
    const v = parseFloat(String((item && (item.pcFinal || item.preco || item.valor)) || ''));
    if (v > 0) return { valor: v, prazo: item && item.prazoEntrega ? Number(item.prazoEntrega) : null, fonte: 'correios' };
  } catch (_) { /* cai no fallback heurístico */ }
  return null;
}

/* ---------- Frete nacional (mesma heurística do sistema atual) ---------- */
function calcFrete(cepO, cepD, pesoR, alt, larg, comp, serv) {
  const pO = String(cepO || '').replace(/\D/g, '');
  const pD = String(cepD || '').replace(/\D/g, '');
  if (pD.length < 5 || pO.length < 5) return 0;
  const cubagem = (alt * larg * comp) / 6000;
  const pesoCobra = Math.max(pesoR, cubagem);
  const numO = parseInt(pO.padEnd(8, '0'), 10);
  const numD = parseInt(pD.padEnd(8, '0'), 10);
  const diff = Math.abs(numO - numD);
  let taxaDistancia = 2.0;
  if (pO[0] !== pD[0]) taxaDistancia = 11.47 + diff / 500000;
  else if (pO.slice(0, 5) !== pD.slice(0, 5)) taxaDistancia = 3.99 + diff / 20000;
  else taxaDistancia = 2.0 + diff / 60;
  let taxaServico = 5.99, custoPeso = pesoCobra * 2.9;
  switch (serv) {
    case 'moto': taxaServico = 6.00; custoPeso = pesoR > 7 ? (pesoR - 7) * 1.05 : 0; taxaDistancia *= 0.9; break;
    case '04014': taxaServico = 14.60; custoPeso = pesoCobra * 3.50; break;
    case '04790': taxaServico = 28.90; custoPeso = pesoCobra * 4.80; taxaDistancia *= 1.2; break;
    case '04804': taxaServico = 35.00; custoPeso = pesoCobra * 5.20; taxaDistancia *= 1.3; break;
    case '04227': taxaServico = 4.50; custoPeso = pesoR * 1.10; taxaDistancia *= 0.7; break;
    case '03298': taxaServico = 95.00; custoPeso = pesoCobra * 15.00; taxaDistancia = 50.00; break;
  }
  return Number(((taxaDistancia + taxaServico + custoPeso) * 1.05).toFixed(2));
}

function calcTaxes(valorUSD, freteUSD, uf, fx) {
  const empty = { total: 0, II: 0, IPI: 0, PIS: 0, COFINS: 0, ICMS: 0, regime: 'isento' };
  if (valorUSD <= 0) return empty;
  const aduaneiroUSD = valorUSD + freteUSD;
  const aduaneiro = aduaneiroUSD * fx;
  const ii = aduaneiroUSD <= TAX_RATES.RC_LIMIT_USD
    ? 0
    : Math.max(0, aduaneiroUSD * TAX_RATES.RC_II_RATE - TAX_RATES.RC_II_DEDUCTION_USD) * fx;
  const icmsRate = TAX_RATES.ICMS[(uf || '').toUpperCase()] || TAX_RATES.ICMS.default;
  const icms = aduaneiro * icmsRate;
  return {
    total: Number((ii + icms).toFixed(2)),
    II: Number(ii.toFixed(2)), IPI: 0, PIS: 0, COFINS: 0, ICMS: Number(icms.toFixed(2)),
    regime: aduaneiroUSD <= TAX_RATES.RC_LIMIT_USD ? 'remessa_conforme_ate_50' : 'remessa_conforme_acima_50'
  };
}

/* ---------- Busca de produtos: catálogo interno + conector internacional ---------- */
const searchRefCache = new Map(); // ref -> oferta externa (15 min)

const cleanExtTitle = (t) => String(t || '').replace(/\s+/g, ' ').slice(0, 120);

function stripOrigin(p) {
  const hidden = p.brand === 'Alibaba';
  return { ...p, brand: hidden ? '' : p.brand, origin_hidden: hidden };
}

/* MD5 puro (assinatura do conector internacional; WebCrypto não tem MD5) */
function md5(input) {
  const bytes = new TextEncoder().encode(input);
  const K = new Uint32Array(64);
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);
  const len = bytes.length;
  const buf = new Uint8Array((((len + 8) >> 6) + 1) << 6);
  buf.set(bytes);
  buf[len] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(buf.length - 8, len * 8, true);
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const s = [7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,5,9,14,20,5,9,14,20,5,9,14,20,5,9,14,20,4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21];
  for (let off = 0; off < buf.length; off += 64) {
    const M = new Uint32Array(16);
    for (let i = 0; i < 16; i++) M[i] = dv.getUint32(off + i * 4, true);
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = (F + A + K[i] + M[g]) | 0;
      A = D; D = C; C = B;
      B = (B + ((F << s[i]) | (F >>> (32 - s[i])))) | 0;
    }
    a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
  }
  const out = new Uint8Array(16);
  const odv = new DataView(out.buffer);
  odv.setUint32(0, a0, true); odv.setUint32(4, b0, true); odv.setUint32(8, c0, true); odv.setUint32(12, d0, true);
  return Array.from(out).map((x) => x.toString(16).padStart(2, '0')).join('').toUpperCase();
}

async function alibabaSearch(env, q) {
  const key = (env.ALIBABA_APP_KEY || '').trim();
  const secret = (env.ALIBABA_APP_SECRET || '').trim();
  if (!key || !secret) return { ok: false, reason: 'no_key', items: [] };
  const base = (env.ALIBABA_API_URL || '').trim() ||
    `https://gw.api.alibaba.com/openapi/param2/1/portals.open/api.listPromotionProduct/${key}`;
  const params = {
    fields: 'productId,productTitle,productUrl,imageUrl,salePrice',
    keywords: q.slice(0, 60),
    pageSize: '20',
    language: 'en'
  };
  const sorted = Object.keys(params).sort().map((k) => k + params[k]).join('');
  const query = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  try {
    const resp = await fetch(`${base}?${query}&_aop_signature=${md5(secret + sorted + secret)}`, {
      headers: { 'User-Agent': 'droppfy-search/1.0' }
    });
    if (!resp.ok) return { ok: false, reason: 'http_' + resp.status, items: [] };
    const data = await resp.json();
    const raw = (data && data.result && data.result.products) || (data && data.products) || [];
    const items = raw.slice(0, 20).map((p) => {
      const ref = crypto.randomUUID();
      searchRefCache.set(ref, {
        title: cleanExtTitle(p.productTitle || p.subject),
        image: String(p.imageUrl || p.image || ''),
        price_usd: parseFloat(p.salePrice) || 0,
        link: String(p.productUrl || p.detailUrl || ''),
        hub: 'CN',
        at: Date.now()
      });
      return {
        ref, title: cleanExtTitle(p.productTitle || p.subject),
        image: String(p.imageUrl || p.image || ''),
        price_usd: parseFloat(p.salePrice) || 0, hub: 'CN', source: 'international'
      };
    }).filter((x) => x.title && x.price_usd > 0);
    return { ok: true, items };
  } catch (_) {
    return { ok: false, reason: 'error', items: [] };
  }
}

const SHIPPING_NOTE = 'Enviado ao nosso centro de distribuição para logística e envio';

/* ---------- Roteador ---------- */
export default {
  async fetch(request, env) {
    const origin = ALLOWED_ORIGINS.includes(request.headers.get('Origin') || '') ? request.headers.get('Origin') : null;
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': origin || '*',
          'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          'Access-Control-Max-Age': '86400'
        }
      });
    }

    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    const auth = request.headers.get('Authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;

    try {
      /* ---------- Público ---------- */
      if (path === '/api/health' && method === 'GET') {
        const [us, cn] = await Promise.all(
          HUB_COUNTRIES.map((c) => env.DB.prepare('SELECT country FROM hubs WHERE country = ?').bind(c).first())
        );
        return json({
          ok: true,
          app: 'X CWS-LOG+ | Droppfy Logistics AI',
          pix_configured: Boolean((env.PIX_KEY || '').trim()),
          alibaba_configured: Boolean((env.ALIBABA_APP_KEY || '').trim() && (env.ALIBABA_APP_SECRET || '').trim()),
          correios_configured: Boolean((env.CORREIOS_CLIENT_ID || '').trim() && (env.CORREIOS_CLIENT_SECRET || '').trim() && (env.CORREIOS_CONTRACT || '').trim()),
          ai_configured: Boolean(env.AI),
          media_configured: Boolean(env.xcws_media),
          fx_kv_configured: Boolean(env.FX_CACHE),
          hub_us: Boolean(us),
          hub_cn: Boolean(cn)
        }, 200, origin);
      }

      if (path === '/api/rate' && method === 'GET') {
        const fx = await getFx(env);
        return json({ usd_brl: fx.value, source: fx.source, updated_at: fx.at ? new Date(fx.at).toISOString() : null }, 200, origin);
      }

      if (path === '/api/quote' && method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const fx = await getFx(env);
        const peso = parseFloat(body.peso) || 0.3;
        const altura = parseFloat(body.altura) || 1;
        const largura = parseFloat(body.largura) || 1;
        const comprimento = parseFloat(body.comprimento) || 1;
        const servico = body.servico || '04014';
        const cepO = String(body.cepOrigem || '').replace(/\D/g, '');
        const cepD = String(body.cepDestino || '').replace(/\D/g, '');
        const oficial = await correiosPrecoPrazo(env, cepO, cepD, peso, altura, largura, comprimento, servico);
        const frete = oficial
          ? { valor: oficial.valor, prazo: oficial.prazo, fonte: oficial.fonte }
          : { valor: calcFrete(cepO, cepD, peso, altura, largura, comprimento, servico), prazo: null, fonte: 'estimativa' };
        const impostos = body.isImport
          ? calcTaxes(parseFloat(body.valorProdutoUSD) || 0, parseFloat(body.freteInternacionalUSD) || 0, body.uf || 'SP', fx.value)
          : { total: 0 };
        const total = Number((frete.valor + impostos.total).toFixed(2));
        return json({ frete, impostos, total, fx: fx.value, pix: pixPayload(env, total) ? { payload: pixPayload(env, total) } : null }, 200, origin);
      }

      /* ---------- Auth ---------- */
      if (path === '/api/auth/register' && method === 'POST') {
        const b = await request.json().catch(() => ({}));
        const nome = String(b.nome || '').trim();
        const email = String(b.email || '').trim().toLowerCase();
        const whats = String(b.whats || '').trim();
        const pass = String(b.pass || '');
        if (nome.length < 3) return bad('Informe o nome completo.', 400, origin);
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return bad('E-mail inválido.', 400, origin);
        if (whats.replace(/\D/g, '').length < 8) return bad('Informe um WhatsApp válido.', 400, origin);
        if (pass.length < 6) return bad('A senha precisa de no mínimo 6 caracteres.', 400, origin);

        const exists = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
        if (exists) return bad('E-mail já cadastrado. Aguarde liberação ou faça login.', 409, origin);

        const count = await env.DB.prepare('SELECT COUNT(*) AS c FROM users').first();
        const isFirst = Number(count.c) === 0;
        const id = crypto.randomUUID();
        const passHash = await hashPassword(pass);
        await env.DB.prepare(
          'INSERT INTO users (id, nome, email, whats, pass_hash, role, status) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).bind(id, nome, email, whats, passHash, isFirst ? 'admin' : 'cliente', isFirst ? 'active' : 'pending').run();

        if (isFirst) {
          const t = await createSession(env, id);
          return json({ ok: true, first_admin: true, token: t, user: { id, nome, email, whats, role: 'admin', status: 'active' } }, 200, origin);
        }
        await notifyTelegram(env, `📝 Novo cadastro pendente: ${nome} (${email}) — libere no painel Admin.`);
        return json({ ok: true, pending: true, message: 'Solicitação enviada! O administrador irá liberar seu acesso.' }, 200, origin);
      }

      if (path === '/api/auth/login' && method === 'POST') {
        const b = await request.json().catch(() => ({}));
        const email = String(b.email || '').trim().toLowerCase();
        const pass = String(b.pass || '');
        const u = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
        if (!u || !(await verifyPassword(pass, u.pass_hash))) return bad('E-mail ou senha incorretos.', 401, origin);
        if (u.status === 'pending') return bad('Seu acesso ainda não foi liberado pelo administrador.', 403, origin);
        if (u.status !== 'active') return bad('Acesso bloqueado. Fale com o administrador.', 403, origin);
        const t = await createSession(env, u.id);
        return json({ ok: true, token: t, user: publicUser(u) }, 200, origin);
      }

      if (path === '/api/auth/logout' && method === 'POST') {
        if (token) await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
        return json({ ok: true }, 200, origin);
      }

      if (path === '/api/me' && method === 'GET') {
        const u = await sessionUser(env, token);
        if (!u) return bad('Sessão inválida.', 401, origin);
        return json({ user: publicUser(u) }, 200, origin);
      }

      /* ---------- Catálogo (vitrine) ---------- */
      if (path === '/api/products' && method === 'GET') {
        const fx = await getFx(env);
        const list = await env.DB.prepare(
          "SELECT * FROM products WHERE status = 'active' ORDER BY created_at DESC LIMIT 200"
        ).all();
        return json({
          fx: fx.value, source: fx.source,
          products: list.results.map((p) => {
            const q = stripOrigin(p);
            delete q.link; // origem do fornecedor nunca sai do backend
            return withPricing(q, fx.value);
          })
        }, 200, origin);
      }

      /* ---------- Busca (catálogo interno + conector internacional, origem oculta) ---------- */
      if (path === '/api/search' && method === 'GET') {
        const q = String(url.searchParams.get('q') || '').trim();
        if (q.length < 2) return bad('Digite pelo menos 2 letras.', 400, origin);
        const fx = await getFx(env);
        const like = `%${q.replace(/[%_]/g, '')}%`;
        const local = await env.DB.prepare(
          "SELECT * FROM products WHERE status='active' AND (title LIKE ? COLLATE NOCASE OR desc LIKE ? COLLATE NOCASE) LIMIT 20"
        ).bind(like, like).all();
        const items = local.results.map((p) => {
          const q = stripOrigin(p);
          delete q.link; // origem do fornecedor nunca sai do backend
          return withPricing(q, fx.value);
        });
        const ext = await alibabaSearch(env, q);
        const external = (ext.items || []).map((x) => {
          const fake = { cost_usd: x.price_usd, freight_usd: 0, margin_pct: 25, hub: 'CN' };
          return { ...x, pricing: priceAllIn(fake, fx.value) };
        });
        return json({
          q, fx: fx.value, source: fx.source, items, external,
          external_note: ext.ok ? null : (ext.reason === 'no_key' ? 'conector_internacional_sem_chave' : 'conector_internacional_indisponivel')
        }, 200, origin);
      }

      /* ---------- Mídia (R2): upload de imagens de produto ---------- */
      if (path === '/api/upload' && method === 'POST') {
        const u = await sessionUser(env, token);
        if (!u) return bad('Sessão inválida.', 401, origin);
        if (u.role !== 'lojista' && u.role !== 'admin') return bad('Área exclusiva de lojistas.', 403, origin);
        if (!env.xcws_media) return bad('Armazenamento de mídia indisponível.', 503, origin);
        const type = (request.headers.get('Content-Type') || '').split(';')[0].trim();
        if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'].includes(type)) {
          return bad('Envie uma imagem (JPG, PNG, WEBP, GIF ou AVIF).', 400, origin);
        }
        const buf = await request.arrayBuffer().catch(() => null);
        if (!buf || buf.byteLength === 0) return bad('Imagem vazia.', 400, origin);
        if (buf.byteLength > 5 * 1024 * 1024) return bad('Imagem acima de 5 MB.', 413, origin);
        const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif' }[type];
        const key = `products/${crypto.randomUUID()}.${ext}`;
        await env.xcws_media.put(key, buf, { httpMetadata: { contentType: type, cacheControl: 'public, max-age=31536000, immutable' } });
        return json({ ok: true, url: `/api/img/${key}` }, 200, origin);
      }

      const imgMatch = path.match(/^\/api\/img\/([A-Za-z0-9._/-]+)$/);
      if (imgMatch && method === 'GET') {
        if (!env.xcws_media) return bad('Armazenamento de mídia indisponível.', 503, origin);
        const key = imgMatch[1];
        if (!key.startsWith('products/')) return bad('Imagem não encontrada.', 404, origin);
        const obj = await env.xcws_media.get(key);
        if (!obj) return bad('Imagem não encontrada.', 404, origin);
        const headers = {
          'Content-Type': obj.httpMetadata?.contentType || 'application/octet-stream',
          'Cache-Control': 'public, max-age=31536000, immutable',
          'Access-Control-Allow-Origin': '*'
        };
        return new Response(obj.body, { headers });
      }

      /* ---------- IA (Workers AI): descrição de produto ---------- */
      if (path === '/api/ai/describe' && method === 'POST') {
        const u = await sessionUser(env, token);
        if (!u) return bad('Sessão inválida.', 401, origin);
        if (u.role !== 'lojista' && u.role !== 'admin') return bad('Área exclusiva de lojistas.', 403, origin);
        if (!env.AI) return bad('Assistente de IA indisponível neste ambiente.', 503, origin);
        const b = await request.json().catch(() => ({}));
        const title = String(b.title || '').trim().slice(0, 120);
        const brand = String(b.brand || '').trim().slice(0, 60);
        const hub = HUB_COUNTRIES.includes(b.hub) ? b.hub : 'US';
        if (!title) return bad('Informe o título do produto.', 400, origin);
        try {
          const res = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
            messages: [
              { role: 'system', content: 'Você é um redator de e-commerce brasileiro. Escreva APENAS uma descrição de produto em português do Brasil, com 2 a 3 frases, destacando o uso e a qualidade. Sem links, sem preços, sem revelar fornecedor, sem emojis.' },
              { role: 'user', content: `Produto: ${title}${brand ? ` (marca ${brand})` : ''}, enviado de hub ${hub === 'CN' ? 'internacional' : 'nos EUA'}.` }
            ]
          });
          const desc = String((res && (res.response || res.result)) || '').trim().slice(0, 500);
          return json({ ok: true, desc: desc || null }, 200, origin);
        } catch (e) {
          console.error('[ai/describe]', e && e.message ? e.message : String(e));
          return bad('A IA não respondeu agora. Tente novamente em instantes.', 503, origin);
        }
      }

      /* ---------- Lojista: meus produtos ---------- */
      if (path === '/api/my/products') {
        const u = await sessionUser(env, token);
        if (!u) return bad('Sessão inválida.', 401, origin);
        if (u.role !== 'lojista' && u.role !== 'admin') return bad('Área exclusiva de lojistas.', 403, origin);
        const fx = await getFx(env);
        if (method === 'GET') {
          const list = await env.DB.prepare('SELECT * FROM products WHERE seller_id = ? ORDER BY created_at DESC').bind(u.id).all();
          return json({ fx: fx.value, products: list.results.map((p) => withPricing(p, fx.value)) }, 200, origin);
        }
        if (method === 'POST') {
          const b = await request.json().catch(() => ({}));
          const title = String(b.title || '').trim();
          const cost = parseFloat(b.cost_usd) || 0;
          if (!title || cost <= 0) return bad('Informe título e custo em USD.', 400, origin);
          const hub = HUB_COUNTRIES.includes(b.hub) ? b.hub : 'US';
          const id = crypto.randomUUID();
          await env.DB.prepare(
            `INSERT INTO products (id, seller_id, brand, title, desc, image, link, cost_usd, freight_usd, weight_kg, margin_pct, ncm, hub, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).bind(
            id, u.id, String(b.brand || '').slice(0, 40), title, String(b.desc || '').slice(0, 500),
            String(b.image || '').slice(0, 600), String(b.link || '').slice(0, 600), cost,
            parseFloat(b.freight_usd) || 0, parseFloat(b.weight_kg) || 0.3,
            parseFloat(b.margin_pct) || 25, String(b.ncm || '').slice(0, 20), hub,
            u.role === 'admin' ? 'active' : 'pending'
          ).run();
          return json({ ok: true, status: u.role === 'admin' ? 'active' : 'pending', message: u.role === 'admin' ? 'Produto publicado.' : 'Produto enviado para análise do administrador.' }, 200, origin);
        }
      }

      const myProductMatch = path.match(/^\/api\/my\/products\/([^/]+)$/);
      if (myProductMatch && (method === 'PUT' || method === 'DELETE')) {
        const u = await sessionUser(env, token);
        if (!u) return bad('Sessão inválida.', 401, origin);
        if (u.role !== 'lojista' && u.role !== 'admin') return bad('Área exclusiva de lojistas.', 403, origin);
        const p = await env.DB.prepare('SELECT * FROM products WHERE id = ?').bind(myProductMatch[1]).first();
        if (!p) return bad('Produto não encontrado.', 404, origin);
        if (p.seller_id !== u.id && u.role !== 'admin') return bad('Produto de outro vendedor.', 403, origin);
        if (method === 'DELETE') {
          await env.DB.prepare('DELETE FROM products WHERE id = ?').bind(p.id).run();
          return json({ ok: true }, 200, origin);
        }
        const b = await request.json().catch(() => ({}));
        const title = String(b.title ?? p.title).trim();
        const cost = parseFloat(b.cost_usd ?? p.cost_usd) || 0;
        if (!title || cost <= 0) return bad('Informe título e custo em USD.', 400, origin);
        const newStatus = u.role === 'admin' ? p.status : 'pending';
        await env.DB.prepare(
          `UPDATE products SET title=?, desc=?, image=?, link=?, cost_usd=?, freight_usd=?, weight_kg=?, margin_pct=?, ncm=?, hub=?, status=?
           WHERE id=?`
        ).bind(
          title, String(b.desc ?? p.desc).slice(0, 500), String(b.image ?? p.image).slice(0, 600),
          String(b.link ?? p.link).slice(0, 600), cost,
          parseFloat(b.freight_usd ?? p.freight_usd) || 0, parseFloat(b.weight_kg ?? p.weight_kg) || 0.3,
          parseFloat(b.margin_pct ?? p.margin_pct) || 25, String(b.ncm ?? p.ncm).slice(0, 20),
          HUB_COUNTRIES.includes(b.hub ?? p.hub) ? (b.hub ?? p.hub) : p.hub, newStatus, p.id
        ).run();
        return json({ ok: true, status: newStatus, message: newStatus === 'pending' ? 'Alteração enviada para nova análise do admin.' : 'Produto atualizado.' }, 200, origin);
      }

      /* ---------- Admin: usuários ---------- */
      if (path === '/api/admin/users' && method === 'GET') {
        const u = await sessionUser(env, token);
        if (!u || u.role !== 'admin') return bad('Acesso negado.', 403, origin);
        const list = await env.DB.prepare('SELECT * FROM users ORDER BY created_at DESC').all();
        return json({ users: list.results.map(publicUser) }, 200, origin);
      }

      const adminUserMatch = path.match(/^\/api\/admin\/users\/([^/]+)$/);
      if (adminUserMatch && method === 'POST') {
        const u = await sessionUser(env, token);
        if (!u || u.role !== 'admin') return bad('Acesso negado.', 403, origin);
        const b = await request.json().catch(() => ({}));
        const target = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(adminUserMatch[1]).first();
        if (!target) return bad('Usuário não encontrado.', 404, origin);
        const action = b.action;
        if (action === 'approve') {
          await env.DB.prepare("UPDATE users SET status='active' WHERE id=?").bind(target.id).run();
          return json({ ok: true }, 200, origin);
        }
        if (action === 'reject' || action === 'block') {
          await env.DB.prepare("UPDATE users SET status=? WHERE id=?").bind(action === 'reject' ? 'rejected' : 'blocked', target.id).run();
          return json({ ok: true }, 200, origin);
        }
        if (action === 'role') {
          const role = ['cliente', 'lojista', 'admin'].includes(b.role) ? b.role : null;
          if (!role) return bad('Papel inválido.', 400, origin);
          await env.DB.prepare('UPDATE users SET role=? WHERE id=?').bind(role, target.id).run();
          return json({ ok: true }, 200, origin);
        }
        return bad('Ação inválida.', 400, origin);
      }

      /* ---------- Admin: produtos ---------- */
      if (path === '/api/admin/products' && method === 'GET') {
        const u = await sessionUser(env, token);
        if (!u || u.role !== 'admin') return bad('Acesso negado.', 403, origin);
        const fx = await getFx(env);
        const list = await env.DB.prepare('SELECT * FROM products ORDER BY created_at DESC').all();
        return json({ fx: fx.value, products: list.results.map((p) => withPricing(p, fx.value)) }, 200, origin);
      }

      const adminProductMatch = path.match(/^\/api\/admin\/products\/([^/]+)$/);
      if (adminProductMatch && method === 'POST') {
        const u = await sessionUser(env, token);
        if (!u || u.role !== 'admin') return bad('Acesso negado.', 403, origin);
        const b = await request.json().catch(() => ({}));
        const p = await env.DB.prepare('SELECT id FROM products WHERE id = ?').bind(adminProductMatch[1]).first();
        if (!p) return bad('Produto não encontrado.', 404, origin);
        const status = b.action === 'approve' ? 'active' : b.action === 'reject' ? 'rejected' : null;
        if (!status) return bad('Ação inválida.', 400, origin);
        await env.DB.prepare('UPDATE products SET status=? WHERE id=?').bind(status, p.id).run();
        return json({ ok: true, status }, 200, origin);
      }

      /* ---------- Pedidos (cliente) ---------- */
      if (path === '/api/orders' && method === 'POST') {
        const u = await sessionUser(env, token);
        if (!u) return bad('Faça login para comprar.', 401, origin);
        const b = await request.json().catch(() => ({}));
        const qty = Math.min(Math.max(parseInt(b.qty) || 1, 1), 5);
        const p = await env.DB.prepare("SELECT * FROM products WHERE id = ? AND status = 'active'").bind(String(b.product_id || '')).first();
        if (!p) return bad('Produto indisponível.', 404, origin);
        const hub = ['US', 'CN'].includes(p.hub)
          ? await env.DB.prepare('SELECT * FROM hubs WHERE country = ?').bind(p.hub).first()
          : null;
        if (!hub && ['US', 'CN'].includes(p.hub)) {
          return bad(`Hub de envio ${p.hub === 'US' ? 'EUA' : 'China'} ainda não configurado. Tente outro produto.`, 409, origin);
        }
        const fx = await getFx(env);
        const pr = priceAllIn(p, fx.value);
        const id = 'PED' + Date.now().toString(36).toUpperCase() + Math.floor(Math.random() * 999).toString().padStart(3, '0');
        await env.DB.prepare(
          `INSERT INTO orders (id, client_id, product_id, product_title, qty, hub, hub_snapshot, total_brl, frete_brl, impostos_brl, fx_usd_brl, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'awaiting_payment')`
        ).bind(
          id, u.id, p.id, p.title, qty, p.hub, hub ? JSON.stringify(hub) : '',
          Number((pr.total * qty).toFixed(2)), pr.frete, Number((pr.impostos * qty).toFixed(2)), fx.value
        ).run();
        await notifyTelegram(env, `🛒 Novo pedido ${id}: ${p.title} x${qty} — R$ ${(pr.total * qty).toFixed(2)} (aguardando PIX).`);
        return json({
          ok: true,
          order: {
            id, product_title: p.title, qty, hub: p.hub, total_brl: Number((pr.total * qty).toFixed(2)),
            frete_brl: pr.frete, impostos_brl: Number((pr.impostos * qty).toFixed(2)),
            status: 'awaiting_payment', created_at: new Date().toISOString(),
            shipping_note: SHIPPING_NOTE
          },
          pix: pixPayload(env, pr.total * qty) ? { payload: pixPayload(env, pr.total * qty) } : null
        }, 200, origin);
      }

      /* ---------- Pedido de oferta externa (origem oculta; link só no admin) ---------- */
      if (path === '/api/orders/external' && method === 'POST') {
        const u = await sessionUser(env, token);
        if (!u) return bad('Faça login para comprar.', 401, origin);
        const b = await request.json().catch(() => ({}));
        const cached = searchRefCache.get(String(b.ref || ''));
        if (!cached || Date.now() - cached.at > 15 * 60 * 1000) return bad('Oferta expirada. Busque novamente.', 410, origin);
        const hub = await env.DB.prepare('SELECT * FROM hubs WHERE country = ?').bind('CN').first();
        if (!hub) return bad('Centro de distribuição ainda não configurado.', 409, origin);
        const qty = Math.min(Math.max(parseInt(b.qty) || 1, 1), 5);
        const fx = await getFx(env);
        const fake = { cost_usd: cached.price_usd, freight_usd: 0, margin_pct: 25, hub: 'CN' };
        const pr = priceAllIn(fake, fx.value);
        const id = 'PED' + Date.now().toString(36).toUpperCase() + Math.floor(Math.random() * 999).toString().padStart(3, '0');
        await env.DB.prepare(
          `INSERT INTO orders (id, client_id, product_id, product_title, qty, hub, hub_snapshot, supplier_link, total_brl, frete_brl, impostos_brl, fx_usd_brl, status)
           VALUES (?, ?, ?, ?, ?, 'CN', ?, ?, ?, ?, ?, ?, 'awaiting_payment')`
        ).bind(
          id, u.id, 'ext:' + String(b.ref || ''), cached.title, qty, JSON.stringify(hub), cached.link,
          Number((pr.total * qty).toFixed(2)), pr.frete, Number((pr.impostos * qty).toFixed(2)), fx.value
        ).run();
        await notifyTelegram(env, `🛒 Novo pedido ${id}: ${cached.title} x${qty} — R$ ${(pr.total * qty).toFixed(2)} (aguardando PIX).`);
        return json({
          ok: true,
          order: {
            id, product_title: cached.title, qty, hub: 'CN', total_brl: Number((pr.total * qty).toFixed(2)),
            frete_brl: pr.frete, impostos_brl: Number((pr.impostos * qty).toFixed(2)),
            status: 'awaiting_payment', created_at: new Date().toISOString(),
            shipping_note: SHIPPING_NOTE
          },
          pix: pixPayload(env, pr.total * qty) ? { payload: pixPayload(env, pr.total * qty) } : null
        }, 200, origin);
      }

      if (path === '/api/my/orders' && method === 'GET') {
        const u = await sessionUser(env, token);
        if (!u) return bad('Sessão inválida.', 401, origin);
        const list = await env.DB.prepare(
          'SELECT id, product_id, product_title, qty, hub, total_brl, frete_brl, impostos_brl, fx_usd_brl, status, agent_pay, tracking, created_at, paid_at FROM orders WHERE client_id = ? ORDER BY created_at DESC'
        ).bind(u.id).all();
        const fx = await getFx(env);
        return json({
          orders: list.results.map((o) => ({
            ...o,
            shipping_note: SHIPPING_NOTE,
            pix: o.status === 'awaiting_payment' ? (pixPayload(env, o.total_brl) ? { payload: pixPayload(env, o.total_brl) } : null) : null,
            fx_now: fx.value
          }))
        }, 200, origin);
      }

      const cancelMatch = path.match(/^\/api\/my\/orders\/([^/]+)\/cancel$/);
      if (cancelMatch && method === 'POST') {
        const u = await sessionUser(env, token);
        if (!u) return bad('Sessão inválida.', 401, origin);
        const o = await env.DB.prepare('SELECT * FROM orders WHERE id = ? AND client_id = ?').bind(cancelMatch[1], u.id).first();
        if (!o) return bad('Pedido não encontrado.', 404, origin);
        if (o.status !== 'awaiting_payment') return bad('Só pedidos aguardando pagamento podem ser cancelados.', 400, origin);
        await env.DB.prepare("UPDATE orders SET status='cancelled' WHERE id=?").bind(o.id).run();
        return json({ ok: true }, 200, origin);
      }

      /* ---------- Admin: pedidos (com hub oculto visível) ---------- */
      if (path === '/api/admin/orders' && method === 'GET') {
        const u = await sessionUser(env, token);
        if (!u || u.role !== 'admin') return bad('Acesso negado.', 403, origin);
        const list = await env.DB.prepare(
          `SELECT o.*, us.email AS client_email, us.nome AS client_nome, p.link AS product_link
           FROM orders o LEFT JOIN users us ON us.id = o.client_id
           LEFT JOIN products p ON p.id = o.product_id ORDER BY o.created_at DESC`
        ).all();
        return json({
          orders: list.results.map((o) => ({
            ...o,
            supplier_link: o.supplier_link || o.product_link || '',
            hub_address: o.hub_snapshot ? JSON.parse(o.hub_snapshot) : null
          }))
        }, 200, origin);
      }

      const adminOrderStatusMatch = path.match(/^\/api\/admin\/orders\/([^/]+)\/status$/);
      if (adminOrderStatusMatch && method === 'POST') {
        const u = await sessionUser(env, token);
        if (!u || u.role !== 'admin') return bad('Acesso negado.', 403, origin);
        const b = await request.json().catch(() => ({}));
        if (!ORDER_STATUSES.includes(b.status)) return bad('Status inválido.', 400, origin);
        const o = await env.DB.prepare('SELECT id FROM orders WHERE id = ?').bind(adminOrderStatusMatch[1]).first();
        if (!o) return bad('Pedido não encontrado.', 404, origin);
        const paidAt = b.status === 'paid' ? new Date().toISOString() : null;
        await env.DB.prepare('UPDATE orders SET status=?, paid_at=? WHERE id=?').bind(b.status, paidAt, o.id).run();
        return json({ ok: true }, 200, origin);
      }

      const adminOrderMetaMatch = path.match(/^\/api\/admin\/orders\/([^/]+)\/meta$/);
      if (adminOrderMetaMatch && method === 'POST') {
        const u = await sessionUser(env, token);
        if (!u || u.role !== 'admin') return bad('Acesso negado.', 403, origin);
        const b = await request.json().catch(() => ({}));
        const o = await env.DB.prepare('SELECT id FROM orders WHERE id = ?').bind(adminOrderMetaMatch[1]).first();
        if (!o) return bad('Pedido não encontrado.', 404, origin);
        const agentPay = b.agent_pay === '' || b.agent_pay === null ? null : (AGENT_PAY_METHODS.includes(b.agent_pay) ? b.agent_pay : null);
        const tracking = typeof b.tracking === 'string' ? b.tracking.slice(0, 100) : null;
        await env.DB.prepare('UPDATE orders SET agent_pay=COALESCE(?, agent_pay), tracking=COALESCE(?, tracking) WHERE id=?')
          .bind(agentPay, tracking, o.id).run();
        return json({ ok: true }, 200, origin);
      }

      /* ---------- Admin: hubs ocultos ---------- */
      if (path === '/api/admin/hubs') {
        const u = await sessionUser(env, token);
        if (!u || u.role !== 'admin') return bad('Acesso negado.', 403, origin);
        if (method === 'GET') {
          const list = await env.DB.prepare('SELECT * FROM hubs').all();
          return json({ hubs: list.results }, 200, origin);
        }
        if (method === 'PUT') {
          const b = await request.json().catch(() => ({}));
          const hubs = b.hubs || {};
          for (const country of HUB_COUNTRIES) {
            const h = hubs[country];
            if (!h) continue;
            const name = String(h.name || '').trim();
            const street = String(h.street || '').trim();
            const city = String(h.city || '').trim();
            const state = String(h.state || '').trim();
            const zip = String(h.zip || '').trim();
            const phone = String(h.phone || '').trim();
            if (!name || !street || !city || !state || !zip) return bad(`Endereço do hub ${country} incompleto.`, 400, origin);
            await env.DB.prepare(
              `INSERT INTO hubs (country, name, street, suite, city, state, zip, phone, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
               ON CONFLICT(country) DO UPDATE SET name=excluded.name, street=excluded.street, suite=excluded.suite,
                 city=excluded.city, state=excluded.state, zip=excluded.zip, phone=excluded.phone, updated_at=excluded.updated_at`
            ).bind(country, name, street, String(h.suite || '').trim(), city, state, zip, phone).run();
          }
          const list = await env.DB.prepare('SELECT * FROM hubs').all();
          return json({ ok: true, hubs: list.results }, 200, origin);
        }
      }

      /* ---------- Estático (index.html) ---------- */
      if (env.ASSETS) {
        try {
          const res = await env.ASSETS.fetch(request);
          if (res && res.status !== 405) return res;
        } catch (_) { /* cai no 404 abaixo */ }
      }
      return bad('Rota não encontrada.', 404, origin);
    } catch (err) {
      return bad('Erro interno: ' + (err && err.message ? err.message : 'inesperado'), 500, origin);
    }
  }
};
