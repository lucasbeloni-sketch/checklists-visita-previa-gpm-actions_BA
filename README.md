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

## Tela do GPM — calibrado em 2026-08-10

Rodado `npm run inspect` no DOM real. O que está no `config.json` hoje:

| Item | Valor real |
|---|---|
| Rota | `/ci/Seguranca/ChecklistPerguntaResposta` (código de tela `GR669`) |
| Onde vive | dentro do iframe `#frameTelasGPM` |
| Datas | **flatpickr com `altInput`**: o input visível não tem id; o form submete os hidden `#data_inicial`, `#data_final`, `#data_insp_in`, `#data_insp_out` em `Y-m-d H:i` |
| Finalidade | `<select id="finalidade">` escondido atrás de widget **Choices.js** |
| Tipo de Checklist | `<select id="tipos">`, também Choices.js, **populado por AJAX só depois** de escolher a Finalidade |
| Exportar | `button.btn-success` sem id → casado por classe + texto |

Duas consequências que mudaram o código:

**1. Horas são parte do filtro.** Os 4 campos têm `enableTime: true`. Os
`data-options` do próprio GPM usam `defaultHour` `00:00` nos campos de início
(classe `dta-zero`) e `23:59` nos de fim (`dta-fim`). O robô seta esses horários
explicitamente — um fim às `00:00` cortaria o último dia inteiro do intervalo.
Vale conferir se os CSVs que a Skill gerava por computer-use não estavam
perdendo o último dia por isso.

**2. Nada de `<select>` nativo.** Choices.js tira as opções do select e as
mantém em DOM próprio, com filtro fuzzy na busca. O robô abre o widget, digita
um **token curto** (`finalidadeSearch` / `tipoChecklistSearch` no config —
digitar a string inteira não casa), dá Enter e **confere pelo select nativo**,
que é o que o submit usa. Mesmo caminho já validado no repo irmão de CE.

Se o GPM renomear as opções, ajuste os tokens no `config.json` e rode o
`inspect` de novo.

### Recalibrar / validar

```bash
npm install
npx playwright install chromium

# Abre o browser visível, você faz o login, e ele redespeja os candidatos:
HEADED=1 npm run inspect

# Confere se a service account alcança a pasta do Drive:
GOOGLE_CREDENTIALS="$(cat credentials.json)" npm run check

# Ensaio completo sem escrever no Drive:
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

## Backfill dos dias perdidos

A Skill manual exportava com a Data Fim caindo às `00:00`, então **o último dia
de cada intervalo ficava fora**. Nos meses em andamento isso se corrigia no dia
seguinte; nos meses **fechados** a última escrita foi a do dia 1º do mês
seguinte, e aquele último dia ficou zerado para sempre.

Detectado na base: **31 dias faltando** (2023: 8, 2024: 9, 2025: 9, 2026: 5).

```bash
# Só lê o Drive, não toca no GPM — revise o escopo antes de exportar nada:
GOOGLE_CREDENTIALS="$(cat credentials.json)" npm run faltantes

DRY_RUN=1 npm run backfill              # exporta e mostra o que mudaria, sem gravar
npm run backfill                        # grava
DIAS="31/07/2026" npm run backfill      # só um dia (valide com um antes dos 31)
```

Duas estratégias, escolhidas pelo nome do arquivo de destino:

| Destino | Estratégia | Por quê |
|---|---|---|
| `mm.aaaa.csv` (2026) | reexporta o **mês inteiro** e substitui | mesmo nº de exports que pegar 1 dia, e sem risco de merge: o arquivo sai todo de um export só |
| `aaaa.csv` (2023–2025) | exporta **só o dia** e mescla | reexportar o ano custaria 12 exports/ano e reescreveria o arquivo com o questionário **atual** — o schema mudou (2023: 69 colunas, 2025: 81, 2026: 78) e isso quebraria quem lê esses arquivos |

Guardas do merge (`src/merge.js`):

- **Cabeçalho tem que ser idêntico.** Se o export de hoje vier com colunas
  diferentes do arquivo de destino, aborta aquele dia e registra no manifesto —
  nunca desalinha colunas.
- **Append textual**: as linhas do destino não são reserializadas, então campos
  com quebra de linha dentro de aspas saem byte a byte iguais.
- **Dedup por `cod_checklist`**: o export de um dia pode trazer linhas cuja
  `Data Execução` é de outro dia (o filtro é por Data Serviço / Data Inspeção),
  e essas podem já estar no destino.
- **Não mexe se o dia já existe** no destino.
- Na estratégia de mês inteiro, recusa substituir se o export vier com **menos**
  linhas que o arquivo atual.

Cada dia é um export no GPM; o script vai um a um e no fim imprime um manifesto
`dia;arquivo;status;linhas`. Dos 31 dias, 8 caem em sábado/domingo e podem estar
legitimamente vazios — nesse caso o GPM responde "nenhum registro encontrado" e
o dia sai como `vazio` no manifesto, sem erro.
