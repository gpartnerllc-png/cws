# Droppfy — dados em TODOS os dispositivos

## Por que "continuava a mesma coisa"?

Se você abre só o HTML (duplo clique ou GitHub Pages só com o arquivo), os cadastros ficam no **localStorage daquela máquina**.

Para aparecer no celular, outro PC e no admin em qualquer lugar:

1. Rodar o **servidor**
2. Abrir **http://localhost:3000** (não o arquivo .html)

## Como rodar (sem npm)

```bash
cd droppfy-logistics/backend
node server.mjs
```

Navegador:

```
http://localhost:3000
```

Celular na mesma Wi-Fi: use o IP do PC, ex. `http://192.168.0.15:3000`

### Admin
- E-mail: partner@droppfy.com
- Senha: 878I@hweH878

### Teste
1. Celular: cadastrar
2. PC admin: ver pendentes e Liberar
3. Celular: login

## Internet (mundo todo)
Hospede o servidor (VPS/Railway) rodando `node server.mjs` com HTTPS.
