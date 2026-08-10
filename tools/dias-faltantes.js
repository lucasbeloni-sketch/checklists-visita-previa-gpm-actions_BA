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
      const marca = b.forca === "alta" ? "" : "  [evidencia fraca]";
      console.log(`  ${b.arquivo}: falta ${b.dataBR} (${b.diaSemana}) — media do mes ${b.mediaDiaDoMes}/dia, media de ${b.diaSemana} ${b.mediaMesmoDiaSemana}/dia${marca}`);
      todos.push(b);
    }
    if (!r.buracos.length) console.log(`  ${f.name}: sem buraco de fim de mes`);
  }

  const fortes = todos.filter((b) => b.forca === "alta");
  const fracos = todos.filter((b) => b.forca !== "alta");

  console.log(`\n=== ${fortes.length} dia(s) provavelmente perdidos ===`);
  const porArquivo = {};
  for (const b of fortes) (porArquivo[b.arquivo] ||= []).push(b.dataBR);
  for (const [arq, datas] of Object.entries(porArquivo)) {
    console.log(`  ${arq}: ${datas.join(", ")}`);
  }

  // Evidencia fraca = esse dia da semana normalmente nao tem execucao, entao o
  // zero provavelmente e real. Caso concreto: 28/02/2026 (sab) e 31/05/2026
  // (dom) continuaram listados depois do backfill porque de fato nao houve
  // execucao neles — as linhas recuperadas tinham Data Execução em outra data.
  if (fracos.length) {
    console.log(`\n=== ${fracos.length} dia(s) de evidencia FRACA (provavelmente vazio legitimo) ===`);
    const pf = {};
    for (const b of fracos) (pf[b.arquivo] ||= []).push(`${b.dataBR} (${b.diaSemana}, media ${b.mediaMesmoDiaSemana}/dia)`);
    for (const [arq, datas] of Object.entries(pf)) {
      console.log(`  ${arq}: ${datas.join(", ")}`);
    }
    console.log(`  (backfill nesses dias tende a nao mudar nada — rode so se quiser confirmar)`);
  }

  if (fortes.length) {
    console.log(`\nPra recuperar (precisa das credenciais do GPM BA):`);
    console.log(`  DRY_RUN=1 npm run backfill        # ensaio: exporta e mostra o que mudaria, sem gravar`);
    console.log(`  npm run backfill                  # grava no Drive`);
    console.log(`  DIAS="31/07/2026" npm run backfill  # so um dia especifico`);
  }
})().catch((e) => {
  console.error(`[faltantes] FALHOU: ${e.message}`);
  process.exit(1);
});
