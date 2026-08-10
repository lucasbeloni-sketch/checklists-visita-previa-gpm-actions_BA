# checklists-visita-previa-gpm-actions_BA

Versão headless (GitHub Actions) da Skill `baixar-checklists-visita-previa-gpm`.

Baixa o relatório **Checklists Pergunta/Resposta** do GPM **BA**
(`https://sirtecba.gpm.srv.br/`) filtrado para Visita Prévia, extrai o CSV do
`.zip` e sobrescreve `mm.aaaa.csv` na pasta do Drive
`PCP > Time CCM - BA > Controle > Arquivos > Checklists_Visita_Previa`
(ID `1Mw44sdaQTsyuGeuttNPJVOIK_68asTvL`).

Sem Claude no meio, sem ponte com o desktop, sem Google Drive Desktop montado:
o upload vai direto pela Drive API com service account.

## O que o robô faz por execução

1. Login no GPM BA (`#idLogin`/`#idSenha`).
2. Abre Segurança > Checklists > Exportações > Checklists Pergunta/Resposta
   (por URL calibrada, ou clicando no menu por texto).
3. Calcula o período **ancorado em ontem (D-1)**:
   - Início = 1º dia do **mês de ontem**
   - Fim = ontem
   - Os **4** campos recebem esse mesmo par (Data Serviço Início/Fim + Data
     Inspeção Início/Fim).
4. Seleciona `Finalidade = 10 - Vistoria de Obras Elétricas` e
   `Tipo de Checklist = UTD - Visita Prévia-BA`.
5. **Relê os 4 campos de data** antes de exportar (mata o bug histórico do
   "Data Inspeção Fim" que não atualizava).
6. Clica **Exportar** e captura o download.
7. Extrai o CSV do zip, valida linhas + coluna `Data Execução`, e sobrescreve
   `mm.aaaa.csv` no Drive (com auto-dedup de duplicatas de mesmo nome).

Virada de mês é automática: no dia 1, ontem pertence ao mês anterior, então a
rodada fecha o mês anterior completo. Nenhuma lógica extra.

Mês/período **sem registros** (toast laranja "Nenhum registro encontrado") é
condição normal: o run termina **OK** sem tocar no Drive.

## Secrets necessários

| Secret | Pra quê |
|---|---|
| `GOOGLE_CREDENTIALS` | JSON da service account (precisa ser **Editor** na pasta destino) |
| `GPM_BA_USER` / `GPM_BA_PASS` | Login do GPM BA |
| `GPM_USER` / `GPM_PASS` | Fallback, usado só se os `GPM_BA_*` não existirem |

Ainda não está confirmado se o login do BA é o mesmo do CE — por isso o
fallback. Se for o mesmo, basta não criar os `GPM_BA_*`.

## Agenda

`.github/workflows/baixar.yml`: cron a cada 6h (UTC) + botão manual
(`workflow_dispatch`, com checkbox `dry_run`). `concurrency` impede dois runs
escrevendo o mesmo arquivo do mês.

## Calibração (fazer ANTES do primeiro run real)

O `config.json` está com `checklistsUrl: null` e os seletores da tela em `null`
— o código funciona por heurística (navega o menu por texto, acha os 4 inputs
de data por ordem visual, acha os selects por label/id), mas fixar os valores
reais deixa o robô determinístico:

```bash
npm install
npx playwright install chromium

# 1) Abre o browser visível, você faz o login, e ele lista os candidatos:
HEADED=1 npm run inspect
#    -> cole "checklistsUrl" e os ids em config.json > selectors

# 2) Confere se a service account alcança a pasta do Drive:
GOOGLE_CREDENTIALS="$(cat credentials.json)" npm run check

# 3) Ensaio completo sem escrever no Drive:
GPM_BA_USER=... GPM_BA_PASS=... DRY_RUN=1 npm start
```

## Comandos

| Comando | O que faz |
|---|---|
| `npm start` | rotina completa (D-1 → Drive) |
| `DRY_RUN=1 npm start` | baixa e valida, não envia ao Drive |
| `HEADED=1 npm start` | browser visível (debug local; permite login manual) |
| `npm test` | testes unitários das datas/parse (sem browser) |
| `npm run inspect` | calibra seletores da tela |
| `npm run check` | valida acesso ao Drive e lista a pasta |

## Guardas contra sobrescrever o mês com lixo

- CSV com menos de `minLinhasDados` (1) linha de dados → aborta, não envia.
- Alguma `Data Execução` fora do mês do arquivo → aborta (`AVISO_INTERVALO`),
  sinal de filtro de data errado.
- Divergência entre os 4 campos de data e o esperado → aborta antes de exportar.
- Download que veio HTML (sessão expirada) ou XLSX (botão errado) → erro claro.

Em qualquer falha, screenshot + HTML da tela sobem como artefato `debug` do run
e uma issue rolante é aberta/comentada.

## Fora de escopo nesta versão

Backfill de meses antigos (a Skill original tem esse modo manual). A função
`baixarChecklists(page, cfg, mesAno, intervalo)` já aceita um intervalo
explícito, então dá pra plugar depois um loop mês a mês respeitando o limite de
31 dias do GPM.
