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
| `npm run tipos` | lista Finalidades e Tipos de Checklist reais (value + texto exato) |
| `npm run check` | valida acesso ao Drive e lista a pasta |
| `npm run carimbar` | grava só o timestamp na planilha de controle (valida acesso ao Sheets) |

## Conferir os filtros contra a tela (`npm run tipos`)

O robô só aceita o **texto exato** de Finalidade e Tipo de Checklist. Quando o
GPM renomeia uma opção, a rodada quebra — e o log antigo só dizia "não
selecionou", sem mostrar o que a tela oferecia de fato.

O workflow manual **Mapear filtros da tela** resolve isso: loga no GPM, abre a
tela e imprime **todas** as Finalidades e **todos** os Tipos com value + texto
exato, mais os "vizinhos" que o token de busca do config também filtra — que são
exatamente os candidatos a serem pegos por engano.

```bash
GPM_BA_USER=... GPM_BA_PASS=... npm run tipos   # só a Finalidade do config
TODAS=1 npm run tipos                           # varre todas as finalidades
```

O job fica **vermelho de propósito** se o config não bater com a tela, e o log
diz o que trocar. O mapa também vira artefato (`debug/mapa-filtros.json`), e a
lista serve para atualizar a fixture `OPCOES_TIPOS` do `test/dom.test.js`.

Ferramenta portada do repo irmão de CE
(`checklists-formulario-vistoria-gpm-actions_CE`), onde nasceu porque a lista de
tipos de lá é outra e precisava ser descoberta.

### Corrigido junto: a espera do AJAX contava o placeholder

`esperarTiposCarregar` tratava o item **"Selecione..."** como se fosse uma opção
carregada. A espera terminava em milissegundos, antes de a resposta do AJAX
chegar. Aqui isso passava despercebido porque o GPM responde antes do primeiro
clique no widget — mas é uma corrida, e no repo de CE ela perdeu: a tela parecia
ter zero tipos. Agora placeholder não conta, nem no widget nem no `<select>`
nativo, e a função devolve se carregou de verdade.

## Timestamp de última execução

No **fim** de todo run bem-sucedido (inclusive mês sem registros, marcado
`(sem registros)`), o robô carimba data/hora BRT em `BD_Config!C8` da planilha
`1-_lTKT4wSDlJtTXkF1tLHstV9h-S3Yq_2cE8jOIC3kI` — quem olha a planilha vê quando
a rotina rodou por último sem abrir o GitHub Actions.

- Configurável em `config.json` → `timestamp` (`spreadsheetId`, `aba`, `celula`).
- `DRY_RUN=1` e runs que falharam **não** carimbam.
- Escopo `spreadsheets` (não é o do Drive): a service account precisa de acesso
  **Editor** na planilha. Sem acesso, o run diário só emite warning
  `[timestamp] NAO consegui gravar` — não falha, porque o CSV já foi enviado.
- Workflow manual **Carimbar timestamp** roda só esse passo, pra testar acesso.

## Guardas contra sobrescrever o mês com lixo

- CSV com menos de `minLinhasDados` (1) linha de dados → aborta, não envia.
- Alguma `Data Execução` fora do mês do arquivo → aborta (`AVISO_INTERVALO`),
  sinal de filtro de data errado.
- Divergência entre os 4 campos de data e o esperado → aborta antes de exportar.
- Download que veio HTML (sessão expirada) ou XLSX (botão errado) → erro claro.

Em qualquer falha, screenshot + HTML da tela sobem como artefato `debug` do run
e uma issue rolante é aberta/comentada.

## Layout da base (layout.json)

A pasta é carregada por uma plataforma, então **todo arquivo tem o mesmo
cabeçalho**: 90 colunas, definidas em `layout.json` e versionadas no repo.

| | |
|---|---|
| 78 primeiras | o que o GPM exporta hoje, na ordem dele |
| 12 últimas | perguntas **aposentadas** do formulário, mantidas no fim |

As 12 aposentadas existem porque o export traz uma coluna por pergunta e só as
perguntas presentes nos registros do período — os arquivos antigos tinham
questionários diferentes (2023: 69 colunas, 2024: 87, 2025: 81, 2026: 78).
Conformar tudo às 78 atuais descartaria **22.671 respostas** de 9 perguntas
reais (sinal telefônico, vegetação/APP, cavas). Com as 12 no fim, nada se perde
e a plataforma lê as 78 primeiras.

O layout é superconjunto de todos os arquivos, então padronizar nunca descarta
resposta — e `src/padronizar.js` **prova** isso a cada arquivo: compara as
células preenchidas coluna a coluna, antes e depois, e aborta em qualquer
diferença.

**Se o GPM ganhar pergunta nova**, ela é anexada no fim e o run avisa
(`ATENCAO: coluna(s) nova(s)`). Nada é descartado em silêncio; aí regenere o
layout pra pasta voltar a ser homogênea.

### Estado da base (11/08/2026)

| Arquivo | Linhas |
|---|---|
| `2023.csv` | 1.990 |
| `2024.csv` | 3.820 |
| `2025.csv` | 4.686 |
| `01`–`08.2026.csv` | 2.340 |
| **total** | **12.836** — 12.836 `cod_checklist` únicos, zero repetido |

Estrutura: ano fechado num arquivo por ano, ano corrente um arquivo por mês (a
consolidação dos meses no arquivo do ano é manual). O robô diário mantém o mês
corrente e já grava no layout de 90 colunas.

### Ferramentas de base

| Comando | O que faz |
|---|---|
| `npm run auditar` | confere alinhamento estrutural de todos os CSVs (só lê o Drive) |
| `npm run analisar` | mostra o custo de conformar ao layout: perguntas fora e respostas em jogo |
| `npm run padronizar` | reprojeta a pasta no layout (aceita `DRY_RUN=1`) |
| `npm run conferir` | reexporta um mês do GPM e compara célula a célula com o arquivo da pasta |

A conferência contra o GPM (junho de 2023, 2024 e 2025) deu **0 divergência em
77.676 células** — é o que autoriza reprojetar por nome de coluna: os arquivos
existentes estão com cada resposta sob a coluna certa.

## Backfill dos dias perdidos

A Skill manual exportava com a Data Fim caindo às `00:00`, então **o último dia
de cada intervalo ficava fora**. Nos meses em andamento isso se corrigia no dia
seguinte; nos meses **fechados** a última escrita foi a do dia 1º do mês
seguinte, e aquele último dia ficou zerado para sempre.

**Status: concluído em 11/08/2026.**

| | Situação |
|---|---|
| 2026 (5 dias) | **recuperados dentro dos próprios arquivos** (run 31428404849): +31 registros em `02`, `03`, `05`, `06`, `07` |
| 2023–2025 (26 dias) | **recuperados em arquivo separado** (run 31486052453): `dias_recuperados_2023-2025.csv`, **237 registros**, 87 colunas — 2023: 60, 2024: 71, 2025: 106 |
| 5 desses 26 dias | vazios de verdade — não houve visita (30/04/2023, 31/12/2023, 30/11/2024, 31/08/2025, 30/11/2025) |

Por que 2023–2025 foi para arquivo separado: **o export traz uma coluna por
pergunta, e só as perguntas presentes nos registros filtrados**. Exportando um
dia de cada mês, o número de colunas variou entre 67 e 78 — e dois dias com 67
colunas tinham conjuntos de perguntas *diferentes*. Não existe schema estável nem
dentro do mesmo ano, então:

- colar as linhas nos anuais (81 e 69 colunas) desalinharia respostas;
- reexportar o ano inteiro **apagaria** as respostas das perguntas que saíram do
  formulário — os arquivos históricos são mais ricos que qualquer export atual.

O arquivo separado tem a **união** das perguntas (87 colunas), casadas por nome;
cada linha preenche o que tem e deixa vazio o que não se aplica. Validado após o
upload: 237 linhas com exatamente 87 campos cada, 237 `cod_checklist` únicos e
**zero** colisão com os anuais.

O detector separa evidência **forte** (dia da semana comparável costuma ter
registro) de **fraca** (esse dia da semana normalmente tem ~0). Ele lê só a
coluna `Data Execução`, e o filtro do GPM é por Data Serviço/Inspeção — então um
dia pode continuar listado mesmo depois de recuperado, se as linhas trazidas
tiverem execução em outra data. Foi o que houve com `28/02/2026`, `31/05/2026` e
`31/05/2026`: o registro entrou, mas naquele dia ninguém executou nada. Rodar o
backfill neles de novo é inofensivo (substitui pelo mesmo conteúdo).

```bash
# Só lê o Drive, não toca no GPM — revise o escopo antes de exportar nada:
GOOGLE_CREDENTIALS="$(cat credentials.json)" npm run faltantes

DRY_RUN=1 npm run backfill              # exporta e mostra o que mudaria, sem gravar
npm run backfill                        # grava
DIAS="31/07/2026" npm run backfill      # só um dia (valide com um antes dos 31)
```

Duas estratégias, escolhidas pelo nome do arquivo de destino:

| Modo | Estratégia | Quando |
|---|---|---|
| padrão, destino `mm.aaaa.csv` | reexporta o **mês inteiro** e substitui | arquivo = 1 mês, então o export cobre o arquivo todo e não há merge |
| padrão, destino `aaaa.csv` | exporta **só o dia** e mescla, com guarda de cabeçalho | na prática sempre barra, porque o schema mudou — use o modo SAIDA |
| `SAIDA=<nome.csv>` | exporta cada dia e junta num arquivo **novo**, por união de colunas | quando os cabeçalhos divergem (o caso de 2023–2025) |

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
