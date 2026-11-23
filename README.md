# Bot Trader

Robô que recebe um sinal de **compra** (par, valor de entrada e stop) pelo painel web e, para cada cliente ativo, executa:

1. Compra a mercado na corretora do cliente (Binance, Bybit ou BingX) via API;
2. Logo em seguida, coloca a ordem de **stop loss**.

Depois disso, cada cliente gerencia o próprio trade. Suporta **spot** e **futuros** (perpétuos USDT), por cliente.

## Como funciona

- Tamanho da posição: `% do saldo livre` definido por cliente (em futuros, multiplicado pela alavancagem).
- Proteção de preço: se o preço atual estiver mais longe que `MAX_SLIPPAGE_PCT` do valor de entrada, a ordem do cliente é rejeitada.
- Se o stop falhar, o robô fecha a posição a mercado (`CLOSE_ON_STOP_FAILURE=true`), para o cliente nunca ficar exposto sem stop.
- As API keys ficam criptografadas (AES-256-GCM) em `data/clients.json`.
- Credenciais são testadas na corretora antes de salvar o cliente.

## Instalação (VPS com Node 20.6+)

```bash
git clone https://github.com/ArtDriessen/Bot-Trader.git
cd Bot-Trader
npm install
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # cole em ENCRYPTION_KEY
nano .env      # defina ADMIN_TOKEN e ENCRYPTION_KEY
npm start
```

Painel em `http://IP_DO_SERVIDOR:3000`. Em produção, coloque atrás de HTTPS (Nginx/Caddy) e rode com `pm2` ou `systemd`.

## Segurança (importante)

- O cliente deve criar a API key **somente com permissão de trade/leitura, SEM saque**, e liberar apenas o **IP da sua VPS**.
- Faça backup da `ENCRYPTION_KEY`; sem ela as chaves salvas não podem ser lidas.
- Nunca exponha o painel sem HTTPS e sem token forte.

## Antes de usar com dinheiro real

Este código **ainda não foi testado contra as corretoras**. Teste nesta ordem:

1. `SANDBOX=true` (testnet Binance futuros e Bybit; BingX tem conta demo, que pode exigir ajuste).
2. Conta real própria, com valor mínimo, para cada combinação corretora + mercado.
3. Confirme em cada corretora que o stop aparece como ordem condicional/reduce-only.

Pontos que costumam variar por corretora: stop em **spot** na BingX, **modo hedge** na Binance/Bybit (exige `positionSide`) e valores mínimos por par.

## Aviso legal

Enviar sinais que executam ordens automaticamente em contas de terceiros pode ter exigências regulatórias (no Brasil, CVM/consultoria ou gestão de recursos). Deixe claro em contrato que o cliente autoriza a execução, assume o risco e mantém a custódia dos fundos, e consulte um advogado.

## Próximos passos possíveis

Ordem limite na entrada, alvos de take profit, entrada por Telegram, venda/short, histórico por cliente em banco de dados.
