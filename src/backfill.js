// Backfill dos dias perdidos pelo bug do horario (ver src/faltantes.js).
//
// Duas estrategias, escolhidas pelo tipo do arquivo de destino:
//
//  A) destino mm.aaaa.csv (meses de 2026, arquivo = 1 mes)
//     -> reexporta o MES INTEIRO com o fim as 23:59 e SUBSTITUI o arquivo.
//        Mesmo numero de exports que pegar so o dia, e sem risco de merge: o
//        arquivo sai inteiro de um unico export, colunas coerentes por definicao.
//
//  B) destino aaaa.csv (2023/2024/2025, arquivo = ano inteiro concatenado)
//     -> exporta SO o dia perdido e MESCLA no arquivo (src/merge.js), com
//        guarda de cabecalho. Reexportar o ano custaria 12 exports por ano e
//        reescreveria o arquivo com o questionario ATUAL (o schema mudou: 2023
//        tem 69 colunas, 2025 tem 81) — o que poderia quebrar quem le esses
//        arquivos. Por isso aqui e append, nao replace.
//
// Uso:
//   DRY_RUN=1 npm run backfill            ensaio (exporta, mostra, nao grava)
//   npm run backfill                      grava no Drive
//   DIAS="31/07/2026,30/06/2026" npm run backfill    so esses dias
//   HEADED=1 ...                          browser visivel (debug local)
//
// Cada dia e um export no GPM. O script vai um a um, loga o resultado de cada e
// no fim imprime um manifesto (dia, arquivo, status, linhas) — o mesmo tipo de
// registro que a Skill pedia pra manter em backfill grande.

const { chromium } = require("playwright");
const cfg = require("./../config.json");
const { login, baixarChecklists, dump } = require("./gpm");
const { uploadCsv, listarCsv, baixarCsv } = require("./drive");
const { analisar } = require("./faltantes");
const { mesclar } = require("./merge");
const { mesAnoD1, contarLinhasDados } = require("./util");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function partesDeBR(s) {
  const m = String(s).trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) throw new Error(`data invalida em DIAS: "${s}" (use dd/mm/aaaa)`);
  return { dia: Number(m[1]), mes: Number(m[2]), ano: Number(m[3]) };
}

const p2 = (n) => String(n).padStart(2, "0");
const brDe = ({ ano, mes, dia }) => `${p2(dia)}/${p2(mes)}/${ano}`;

// Descobre os buracos lendo a pasta do Drive (mesma logica do npm run faltantes).
async function descobrirBuracos() {
  const arquivos = await listarCsv(cfg);
  const mesCorrente = mesAnoD1(cfg.timezone);
  const buracos = [];
  for (const f of arquivos) {
    const buf = await baixarCsv(f.name, cfg);
    const r = analisar(f.name, buf, { mesCorrente });
    buracos.push(...r.buracos);
  }
  buracos.sort((a, b) => a.dataBR.split("/").reverse().join("").localeCompare(b.dataBR.split("/").reverse().join("")));
  return buracos;
}

// Se DIAS=... foi passado, monta os alvos a partir dele: cada data cai no
// arquivo mm.aaaa.csv se ele existir na pasta, senao no aaaa.csv.
async function alvosDeDIAS(lista) {
  const arquivos = (await listarCsv(cfg)).map((f) => f.name);
  return lista.split(",").map((s) => {
    const d = partesDeBR(s);
    const mensal = `${p2(d.mes)}.${d.ano}.csv`;
    const anual = `${d.ano}.csv`;
    const arquivo = arquivos.includes(mensal) ? mensal : (arquivos.includes(anual) ? anual : mensal);
    return { arquivo, data: d, dataBR: brDe(d), diaSemana: "-", mediaDiaDoMes: null };
  });
}

(async () => {
  const headless = !process.env.HEADED;
  const dryRun = !!process.env.DRY_RUN;

  const alvos = process.env.DIAS ? await alvosDeDIAS(process.env.DIAS) : await descobrirBuracos();
  if (!alvos.length) {
    console.log("[backfill] nenhum dia faltando. Nada a fazer.");
    return;
  }

  console.log(`[backfill] ${alvos.length} dia(s) alvo | dryRun=${dryRun} | headless=${headless}`);
  for (const a of alvos) {
    const modo = /^\d{2}\.\d{4}\.csv$/i.test(a.arquivo) ? "mes-inteiro (replace)" : "dia (merge)";
    console.log(`   ${a.dataBR} -> ${a.arquivo} [${modo}]`);
  }

  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);

  const manifesto = [];
  try {
    await login(page, cfg);

    for (const alvo of alvos) {
      const { ano, mes, dia } = alvo.data;
      const ehMensal = /^\d{2}\.\d{4}\.csv$/i.test(alvo.arquivo);
      const rotulo = `${alvo.dataBR} -> ${alvo.arquivo}`;
      console.log(`\n########## ${rotulo} ##########`);

      // Intervalo exportado: mes inteiro (estrategia A) ou so o dia (B).
      const intervalo = ehMensal
        ? { inicio: { ano, mes, dia: 1 }, fim: { ano, mes, dia } }
        : { inicio: { ano, mes, dia }, fim: { ano, mes, dia } };
      const mesAno = `${p2(mes)}.${ano}`;

      try {
        const r = await baixarChecklists(page, cfg, mesAno, intervalo);

        if (r.vazio) {
          console.log(`[backfill] ${rotulo}: GPM diz "nenhum registro" no periodo — nada a recuperar.`);
          manifesto.push({ ...alvo, status: "vazio", linhas: 0 });
          continue;
        }

        if (ehMensal) {
          // Estrategia A: o export do mes inteiro SUBSTITUI o arquivo do mes.
          const linhas = contarLinhasDados(r.buffer);
          if (linhas < (cfg.minLinhasDados ?? 1)) {
            throw new Error(`export com ${linhas} linha(s) — nao substituo ${alvo.arquivo}`);
          }
          const antes = await baixarCsv(alvo.arquivo, cfg);
          const linhasAntes = antes ? contarLinhasDados(antes) : 0;
          if (linhas < linhasAntes) {
            throw new Error(`export tem MENOS linhas (${linhas}) que o arquivo atual (${linhasAntes}) — nao substituo ${alvo.arquivo}; investigue antes`);
          }
          if (dryRun) {
            console.log(`[backfill] DRY_RUN: ${alvo.arquivo} ficaria com ${linhas} linhas (tinha ${linhasAntes}, +${linhas - linhasAntes}).`);
            manifesto.push({ ...alvo, status: "dry-run-replace", linhas, delta: linhas - linhasAntes });
          } else {
            const up = await uploadCsv(r.buffer, alvo.arquivo, cfg);
            console.log(`[backfill] ${alvo.arquivo} ${up.acao}: ${linhas} linhas (tinha ${linhasAntes}, +${linhas - linhasAntes}).`);
            manifesto.push({ ...alvo, status: `ok-${up.acao}`, linhas, delta: linhas - linhasAntes });
          }
        } else {
          // Estrategia B: mescla so as linhas novas no arquivo anual.
          const antes = await baixarCsv(alvo.arquivo, cfg);
          if (!antes) throw new Error(`arquivo de destino ${alvo.arquivo} nao existe na pasta`);
          const m = mesclar(antes, r.buffer, { dataBR: alvo.dataBR });
          if (!m.ok) {
            console.warn(`[backfill] ${rotulo}: NAO mesclado — ${m.motivo}`);
            manifesto.push({ ...alvo, status: `skip: ${m.motivo}`, linhas: 0 });
            continue;
          }
          console.log(`[backfill] merge: +${m.add} linha(s), ${m.dup} duplicata(s) ignorada(s), total ${m.totalAntes} -> ${m.totalDepois}.`);
          if (dryRun) {
            manifesto.push({ ...alvo, status: "dry-run-merge", linhas: m.add });
          } else {
            const up = await uploadCsv(Buffer.from(m.texto, "utf8"), alvo.arquivo, cfg);
            console.log(`[backfill] ${alvo.arquivo} ${up.acao}.`);
            manifesto.push({ ...alvo, status: `ok-merge`, linhas: m.add });
          }
        }
      } catch (e) {
        console.error(`[backfill] ${rotulo}: ERRO — ${e.message}`);
        await dump(page, `backfill-erro-${alvo.dataBR.replace(/\//g, "-")}`);
        manifesto.push({ ...alvo, status: `erro: ${e.message}`, linhas: 0 });
      }

      await sleep(1500); // folga entre rodadas (o GPM e sensivel a rajada)
    }
  } finally {
    await browser.close();
  }

  console.log("\n=== Manifesto ===");
  console.log("dia;arquivo;status;linhas");
  for (const m of manifesto) {
    console.log(`${m.dataBR};${m.arquivo};${m.status};${m.linhas}`);
  }
  const erros = manifesto.filter((m) => String(m.status).startsWith("erro"));
  const skips = manifesto.filter((m) => String(m.status).startsWith("skip"));
  console.log(`\n${manifesto.length} alvo(s): ${manifesto.length - erros.length - skips.length} processado(s), ${skips.length} pulado(s), ${erros.length} com erro.`);
  if (erros.length) process.exit(1);
})().catch((e) => {
  console.error(`[backfill] FALHA FATAL: ${e.message}`);
  process.exit(1);
});
