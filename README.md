# Bot Trader

Robô que recebe um sinal de **compra** (par, valor de entrada e stop) pelo painel web e, para cada cliente ativo, executa:

1. A compra na corretora do cliente (Binance, Bybit ou BingX) via API, na hora ou quando o preço atingir a entrada (limite, rompimento ou fundo);
2. Logo em seguida, a ordem de **stop loss** (ou stop limit) e os **take profits**.

Depois disso, cada cliente gerencia o próprio trade. Suporta **spot** e **futuros** (perpétuos USDT), por cliente.

## Como funciona

Para cada cliente ativo, o robô executa a compra e logo em seguida coloca o stop loss (e os take profits, se houver).

**Tipos de entrada**

| Tipo | Comportamento |
|---|---|
| A mercado | Compra na hora (recusa se o preço estiver mais de `MAX_SLIPPAGE_PCT` longe da entrada). |
| Ordem limite | Coloca uma ordem limite de compra na corretora; stop e TP são colocados quando ela executa. |
| Rompimento | Entrada **acima** do preço atual. O robô monitora e só envia a compra quando o preço **subir** até a entrada. |
| Fundo | Entrada **abaixo** do preço atual. O robô monitora e só envia a compra quando o preço **cair** até a entrada. |

No rompimento e no fundo, se o preço tocar o stop antes da entrada, o sinal é cancelado; a validade padrão é 24h (configurável por sinal). O monitor roda a cada 5s (`POLL_SECONDS`) e retoma sozinho se o servidor reiniciar.

**Stop**: stop loss (a mercado) ou **stop limit** (ordem limite a X% abaixo do gatilho, padrão 0,3%). Se o stop falhar, a posição é fechada a mercado (`CLOSE_ON_STOP_FAILURE`).

**Take profit**: até 5 alvos no formato `preço:%`, por exemplo `105:50, 110:50` (sem % divide igualmente).
- Futuros: ordens limite *reduce-only* na corretora.
- Spot: stop e TP reservariam o mesmo saldo, então o robô monitora o preço, vende a parte do alvo a mercado e reposiciona o stop para o restante.

**Tamanho da posição**: % do saldo livre definido por cliente (em futuros, vezes a alavancagem). As API keys ficam criptografadas (AES-256-GCM) e são testadas na corretora antes de salvar o cliente.

**Limitações conhecidas**
- Enquanto uma ordem limite está parcialmente executada e aberta, a parte comprada ainda não tem stop (a proteção entra quando a ordem fecha ou é cancelada).
- No spot, o take profit é feito pelo robô: se o servidor ficar fora do ar, o stop continua na corretora, mas o TP não dispara.
- Muitos clientes consultando preço a cada 5s dividem o limite de requisições do mesmo IP; ajuste `POLL_SECONDS` se necessário.

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

A lógica foi validada com uma corretora simulada (fundo, rompimento, limite, stop-limit, TP e falha de stop), mas **ainda não foi testada contra as corretoras reais**. Teste nesta ordem:

1. `SANDBOX=true` (testnet Binance futuros e Bybit; BingX tem conta demo, que pode exigir ajuste).
2. Conta real própria, com valor mínimo, para cada combinação corretora + mercado.
3. Confirme em cada corretora que o stop aparece como ordem condicional/reduce-only.

Pontos que costumam variar por corretora: stop em **spot** na BingX, **modo hedge** na Binance/Bybit (exige `positionSide`) e valores mínimos por par.

## Aviso legal

Enviar sinais que executam ordens automaticamente em contas de terceiros pode ter exigências regulatórias (no Brasil, CVM/consultoria ou gestão de recursos). Deixe claro em contrato que o cliente autoriza a execução, assume o risco e mantém a custódia dos fundos, e consulte um advogado.

## Próximos passos possíveis

Entrada por Telegram, venda/short, break-even automático, histórico por cliente em banco de dados.
