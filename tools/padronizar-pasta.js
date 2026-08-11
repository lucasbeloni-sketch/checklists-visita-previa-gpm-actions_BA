// Padroniza TODOS os CSVs da pasta no layout de layout.json (90 colunas).
//
// Estrutura que o usuario mantem (decisao dele):
//   - ano fechado  -> um arquivo por ano  (2023.csv, 2024.csv, 2025.csv)
//   - ano corrente -> um arquivo por mes  (01.2026.csv ... 08.2026.csv)
//   (a consolidacao dos meses no arquivo do ano ele faz manualmente)
//
// O que este script faz:
//   1. le cada arquivo da pasta e reprojeta no layout, por NOME de coluna;
//   2. dissolve dias_recuperados_2023-2025.csv dentro do arquivo do ANO de cada
//      linha (2023/2024/2025), deduplicando por cod_checklist;
//   3. valida que nenhuma celula preenchida se perdeu (src/padronizar.js);
//   4. sobrescreve cada arquivo e manda o dias_recuperados pra lixeira.
//
// Sobrescrever e seguro por construcao: o layout e SUPERCONJUNTO das colunas de
// todos os arquivos (as 12 aposentadas vieram justamente deles), entao a
// reprojecao nunca descarta resposta — e o passo 3 prova isso arquivo por
// arquivo antes de subir. O upload mantem o mesmo id do arquivo, entao o
// historico de versoes do Drive continua servindo de volta.
//
//   GOOGLE_CREDENTIALS=... DRY_RUN=1 npm run padronizar   (nao grava)
//   GOOGLE_CREDENTIALS=... npm run padronizar             (grava)

const cfg = require("../config.json");
const layout = require("../layout.json");
const { listarCsv, baixarCsv, uploadCsv, enviarParaLixeira } = require("../src/drive");
const { parseCsv, serializeCsv } = require("../src/uniao");
const { reprojetar, validar, juntarNoLayout, anoDaLinha } = require("../src/padronizar");

const RECUPERADOS = "dias_recuperados_2023-2025.csv";
const COLUNAS = layout.colunas;

(async () => {
  const dryRun = !!process.env.DRY_RUN;
  const arquivos = (await listarCsv(cfg)).sort((a, b) => a.name.localeCompare(b.name));
  console.log(`[padronizar] ${arquivos.length} csv(s) | layout: ${COLUNAS.length} colunas | dryRun=${dryRun}\n`);

  // 1) Le tudo e reprojeta.
  const alvos = [];
  let recuperados = null;
  for (const f of arquivos) {
    const origem = parseCsv(await baixarCsv(f.name, cfg));
    const destino = reprojetar(COLUNAS, origem);
    const v = validar(origem, destino);
    if (!v.ok) {
      console.error(`[padronizar] ${f.name}: REPROJECAO INVALIDA`);
      for (const p of v.problemas.slice(0, 10)) console.error(`   ${p}`);
      throw new Error(`reprojecao de ${f.name} nao preservou os dados; nada foi gravado`);
    }
    if (destino.anexadas.length) {
      console.warn(`[padronizar] ${f.name}: ${destino.anexadas.length} coluna(s) FORA do layout foram anexadas no fim: ${destino.anexadas.join(" | ")}`);
      console.warn("   >>> isso significa que o layout.json esta desatualizado; regenere depois.");
    }
    const info = { nome: f.name, origem, destino };
    if (f.name === RECUPERADOS) recuperados = info;
    else alvos.push(info);
    console.log(`[padronizar] ${f.name}: ${origem.rows.length} linhas, ${origem.header.length} -> ${destino.header.length} colunas`);
  }

  // 2) Dissolve os dias recuperados no arquivo do ANO de cada linha.
  if (recuperados) {
    const porAno = {};
    for (const r of recuperados.destino.rows) {
      const ano = anoDaLinha(recuperados.destino.header, r);
      if (!ano) throw new Error("linha do arquivo de dias recuperados sem Data Execução valida");
      (porAno[ano] = porAno[ano] || []).push(r);
    }
    console.log(`\n[padronizar] dissolvendo ${RECUPERADOS}: ${Object.entries(porAno).map(([a, v]) => `${a}=${v.length}`).join(", ")}`);

    for (const [ano, linhas] of Object.entries(porAno)) {
      const alvo = alvos.find((a) => a.nome === `${ano}.csv`);
      if (!alvo) throw new Error(`nao achei ${ano}.csv na pasta pra receber ${linhas.length} linha(s) recuperada(s)`);
      const antes = alvo.destino.rows.length;
      const j = juntarNoLayout(alvo.destino.header, [
        { header: alvo.destino.header, rows: alvo.destino.rows },
        { header: alvo.destino.header, rows: linhas },
      ]);
      alvo.destino = { header: j.header, rows: j.rows, anexadas: alvo.destino.anexadas };
      alvo.recebeu = j.rows.length - antes;
      console.log(`   ${ano}.csv: ${antes} -> ${j.rows.length} linhas (+${alvo.recebeu}, ${j.dup} duplicata(s) ignorada(s))`);
      if (alvo.recebeu !== linhas.length) {
        console.warn(`   ATENCAO: ${linhas.length - alvo.recebeu} linha(s) recuperada(s) de ${ano} ja existiam no arquivo do ano`);
      }
    }
  }

  // 3) Grava.
  console.log("");
  let totalLinhas = 0;
  for (const a of alvos) {
    const texto = serializeCsv(a.destino.header, a.destino.rows);
    const conferido = parseCsv(texto);
    if (conferido.rows.length !== a.destino.rows.length || conferido.header.length !== a.destino.header.length) {
      throw new Error(`${a.nome}: CSV gerado nao releu igual (${conferido.rows.length} linhas, ${conferido.header.length} colunas)`);
    }
    totalLinhas += a.destino.rows.length;

    if (dryRun) {
      console.log(`[padronizar] DRY_RUN ${a.nome}: ficaria com ${a.destino.rows.length} linhas x ${a.destino.header.length} colunas (${texto.length} bytes)`);
    } else {
      const up = await uploadCsv(Buffer.from(texto, "utf8"), a.nome, cfg);
      console.log(`[padronizar] ${a.nome} ${up.acao}: ${a.destino.rows.length} linhas x ${a.destino.header.length} colunas`);
    }
  }

  // 4) O arquivo de dias recuperados deixa de existir: virou parte dos anuais.
  if (recuperados) {
    if (dryRun) {
      console.log(`[padronizar] DRY_RUN: ${RECUPERADOS} iria pra lixeira (as ${recuperados.destino.rows.length} linhas dele ja estao nos arquivos do ano)`);
    } else {
      await enviarParaLixeira(RECUPERADOS, cfg);
    }
  }

  console.log(`\n=== Resumo ===`);
  console.log("arquivo;linhas;colunas");
  for (const a of alvos) console.log(`${a.nome};${a.destino.rows.length};${a.destino.header.length}`);
  console.log(`TOTAL;${totalLinhas};${COLUNAS.length}`);
})().catch((e) => {
  console.error(`[padronizar] FALHOU: ${e.message}`);
  process.exit(1);
});
