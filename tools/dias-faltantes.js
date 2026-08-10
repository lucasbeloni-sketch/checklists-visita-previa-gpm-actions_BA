// Lista os dias que faltam na base do Drive, sem tocar no GPM.
// Serve pra revisar o escopo do backfill ANTES de rodar qualquer export.
//
//   GOOGLE_CREDENTIALS="$(cat credentials.json)" npm run faltantes
//
// Saida: uma linha por buraco + um resumo agrupado por arquivo, e o comando de
// backfill correspondente.

const cfg = require("../config.json");
const { listarCsv, baixarCsv } = require("../src/drive");
const { analisar } = require("../src/faltantes");
const { mesAnoD1 } = require("../src/util");

(async () => {
  const arquivos = await listarCsv(cfg);
  console.log(`[faltantes] ${arquivos.length} csv(s) na pasta destino.`);

  // O mes de ontem e o que o robo diario ainda esta preenchendo — nao acusamos
  // buraco nele (seria falso positivo).
  const mesCorrente = mesAnoD1(cfg.timezone);
  console.log(`[faltantes] mes em andamento (ignorado): ${mesCorrente}\n`);

  const todos = [];
  for (const f of arquivos) {
    const buf = await baixarCsv(f.name, cfg);
    const r = analisar(f.name, buf, { mesCorrente });
    if (r.escopo === "desconhecido") {
      console.log(`  ${f.name}: nome fora dos padroes mm.aaaa.csv / aaaa.csv — ignorado`);
      continue;
    }
    for (const b of r.buracos) {
      console.log(`  ${b.arquivo}: falta ${b.dataBR} (${b.diaSemana}) — media do mes ${b.mediaDiaDoMes}/dia em ${b.diasComDado} dias`);
      todos.push(b);
    }
    if (!r.buracos.length) console.log(`  ${f.name}: sem buraco de fim de mes`);
  }

  console.log(`\n=== ${todos.length} dia(s) faltando ===`);
  const porArquivo = {};
  for (const b of todos) (porArquivo[b.arquivo] ||= []).push(b.dataBR);
  for (const [arq, datas] of Object.entries(porArquivo)) {
    console.log(`  ${arq}: ${datas.join(", ")}`);
  }

  if (todos.length) {
    console.log(`\nPra recuperar (precisa das credenciais do GPM BA):`);
    console.log(`  DRY_RUN=1 npm run backfill        # ensaio: exporta e mostra o que mudaria, sem gravar`);
    console.log(`  npm run backfill                  # grava no Drive`);
    console.log(`  DIAS="31/07/2026" npm run backfill  # so um dia especifico`);
  }
})().catch((e) => {
  console.error(`[faltantes] FALHOU: ${e.message}`);
  process.exit(1);
});
