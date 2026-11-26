# Bot Trader

Plataforma em que cada usuário se cadastra, conecta a **própria** conta de corretora (Binance, Bybit ou BingX) por API e passa a receber as **calls** que você envia (entrada + stop inicial). O robô compra e coloca o stop na conta de cada usuário, e os alvos de venda seguem o que o usuário configurou.

## Telas

| Endereço | Quem usa | O que faz |
|---|---|---|
| `/` | Usuário | Cadastro/login, cadastro das chaves de API, barra de **% da banca (0 a 100%)**, **alvos de +1% a +40%** (venda total ou parcial), acompanhamento das operações |
| `/admin` | Você | Enviar calls (par, tipo de entrada, entrada e stop), ver usuários (bloquear/desbloquear) e todas as operações |
| `/termos` | Todos | Termos de uso e aviso de risco |

O **aviso de que o gerenciamento é por conta de cada usuário e de que não nos responsabilizamos por perdas** aparece no cadastro (com aceite obrigatório, registrado com data e versão), no topo da área do usuário e nos termos.

## Como funciona

**Calls (admin):** só a **entrada** e o **stop inicial** vêm da call.

| Tipo de entrada | Comportamento |
|---|---|
| Automático (padrão das calls do Telegram) | Se o preço já está na entrada (até `MAX_SLIPPAGE_PCT`), compra na hora; senão monitora: preço abaixo da entrada = espera **subir** (rompimento); acima = espera **cair** (fundo). |
| A mercado | Compra na hora (recusa se o preço estiver mais de `MAX_SLIPPAGE_PCT` longe da entrada). |
| Ordem limite | Ordem limite de compra na corretora; stop e alvos entram quando ela executa. |
| Rompimento | Entrada acima do preço atual: o robô monitora e só compra quando o preço **subir** até a entrada. |
| Fundo | Entrada abaixo do preço atual: o robô monitora e só compra quando o preço **cair** até a entrada. |

No rompimento e no fundo, se o preço tocar o stop antes da entrada o sinal é cancelado; a validade padrão é 24h. O stop pode ser a mercado ou **stop limit**. Se o stop falhar, a posição é fechada a mercado (`CLOSE_ON_STOP_FAILURE`).

**Cada usuário configura, por conta de corretora:**
- **% da banca** por trade (barra de 0 a 100%; 0% = não opera). Em futuros, é a margem, multiplicada pela alavancagem. Reserva-se 0,5% para taxas.
- **Alvos** (até 5): ganho de 1% a 40% sobre o preço em que a compra foi executada e quanto da posição vender (de 1% a 100%; a soma não passa de 100%). Vender 100% em um alvo encerra a posição; somas menores deixam o restante aberto, protegido pelo stop.
- Alavancagem (futuros), pausar/ativar a conta, trocar as chaves.
- Mudanças valem para as **próximas** operações; as já abertas mantêm os alvos de quando entraram.

**Alvos na corretora:** em futuros viram ordens limite *reduce-only*. No spot, stop e alvo disputariam o mesmo saldo, então o robô monitora o preço, vende a parte do alvo a mercado e reposiciona o stop para o restante.

## Leitura das calls do Telegram

O robô lê as calls postadas no seu **canal do Telegram** por um bot (sem programas extras).

1. No Telegram, fale com **@BotFather**, envie `/newbot` e guarde o **token**.
2. Adicione o bot como **administrador** do seu canal.
3. Defina `TELEGRAM_BOT_TOKEN` no servidor, poste uma mensagem no canal e abra `/admin`: o **id do canal** aparece em "Calls do Telegram" (como "ignorada: TELEGRAM_CHAT_ID ainda não definido"). Defina `TELEGRAM_CHAT_ID` com esse valor.
4. Cada call postada vira uma linha no painel **aguardando aprovação**; você confere e clica em **Executar** (ou **Descartar**). Quando confiar na leitura, defina `TELEGRAM_AUTO_EXECUTE=true` para executar sozinho.

**Formato que o robô entende** (maiúsculas, emojis e vírgula ou ponto decimal não importam):

```
Compra BTC/USDT
Entrada: 100
Stop: 95
```

Também entende `#BTCUSDT`, `ETH-USDT`, `SL`, `Stop Loss`, `Entry`, e palavras de tipo: *rompimento*, *fundo*, *limite*, *a mercado* (sem palavra de tipo = automático). Os alvos escritos na call são ignorados: quem define os alvos é cada usuário. **Prefira valores sem separador de milhar** (`95000`, não `95.000`).

**Segurança da leitura**
- Só lê o chat de `TELEGRAM_CHAT_ID`; mensagens de outros chats só têm o id/nome registrados (nunca o conteúdo).
- Em grupos, só aceita quem estiver em `TELEGRAM_ALLOWED_USER_IDS`.
- Na dúvida, **não executa** e mostra no painel o motivo: faixa de entrada (`100-102`), mais de um par, mensagem de resultado ("alvo batido", "stop atingido"), venda/short, stop maior que a entrada, stop a mais de 50% da entrada.
- Ignora respostas, mensagens encaminhadas, mensagens com mais de `TELEGRAM_MAX_AGE_MIN` minutos e mensagens repetidas (o offset do Telegram é salvo em disco, então reiniciar o servidor não reexecuta nada).
- Entradas a mais de `MAX_ENTRY_DISTANCE_PCT` do preço atual são recusadas (erro de digitação ou de formato de número).
- Use um bot **só para isso**: dois programas lendo o mesmo bot ao mesmo tempo se atrapalham.

## Segurança

- Senhas guardadas só como hash (scrypt); sessão em cookie `httpOnly` + `SameSite=Strict`; limite de tentativas de login/cadastro.
- API keys e secrets ficam criptografadas (AES-256-GCM) e nunca voltam para o navegador; a chave é testada na corretora antes de salvar.
- Cada usuário só enxerga e altera as próprias contas e operações.
- **Oriente o usuário a criar a chave só com leitura e trade, nunca com saque**, e a restringir por IP quando a corretora permitir.
- Faça backup da `ENCRYPTION_KEY`; sem ela as chaves salvas não podem ser lidas.
- Use `INVITE_CODE` para que só quem tem o convite consiga se cadastrar.

## Instalação (Node 20.6+)

```bash
git clone https://github.com/ArtDriessen/Bot-Trader.git
cd Bot-Trader
npm install
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # cole em ENCRYPTION_KEY
nano .env      # defina ADMIN_TOKEN, ENCRYPTION_KEY e INVITE_CODE
npm start
```

Em hospedagem, defina as mesmas variáveis no painel e use `DATA_DIR` apontando para uma pasta **fora** do deploy (senão um novo deploy pode apagar usuários e contas). Coloque sempre atrás de HTTPS.

## Testes

`npm test` roda os testes do interpretador de calls, da leitura do Telegram (API simulada) e do restante com uma corretora simulada (fundo, rompimento, limite, stop-limit, alvos parciais/totais, falha de stop, % da banca) e a API (cadastro, sessão, isolamento entre usuários, validações de 0–100% e 1–40%, chaves criptografadas, fluxo da call até as ordens).

## Antes de usar com dinheiro real

A lógica foi validada com corretora simulada, mas **ainda não foi testada contra as corretoras reais**. Teste nesta ordem:

1. `SANDBOX=true` (testnet Binance futuros e Bybit; BingX não tem testnet equivalente).
2. Conta real própria, com valor mínimo, em cada combinação corretora + mercado.
3. Confirme em cada corretora que o stop e os alvos aparecem como ordens condicionais/reduce-only.

Costumam variar por corretora: stop em **spot** na BingX, **modo hedge** na Binance/Bybit (exige `positionSide`) e valores mínimos por par.

## Aviso legal

Os termos em `/termos` são um **modelo** e devem ser revisados por um advogado antes do uso com clientes. Executar ordens automaticamente em contas de terceiros pode ter exigências regulatórias (no Brasil, CVM: consultoria, análise ou gestão de recursos).
