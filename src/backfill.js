// Backfill dos dias perdidos pelo bug do horario (ver src/faltantes.js).
//
// Duas estrategias, escolhidas pelo tipo do arquivo de destino:
//
//  A) destino mm.aaaa.csv (meses de 2026, arquivo = 1 mes)
//     -> reexporta o MES INTEIRO com o fim as 23:59 e SUBSTITUI o arquivo.
//        Mesmo numero de exports que pegar so o dia, e sem risco de merge: o
//        arquivo sai inteiro de um unico export, colunas coerentes por definicao.
//
//  C) SAIDA=<nome.csv> (modo "dias recuperados", usado pra 2023-2025)
//     -> exporta so o dia perdido de cada mes e junta TUDO num arquivo NOVO,
//        sem tocar em nenhum arquivo existente. Necessario porque o
//        questionario mudou: os anuais tem 81/69 colunas e o export de hoje tem
//        77, entao nao existe encaixe correto dentro deles (ver estrategia B).
//        Cada linha so entra se o cod_checklist ainda nao existir no arquivo
//        anual correspondente — o arquivo de saida e exatamente o que falta.
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

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const cfg = require("./../config.json");
const { login, baixarChecklists, dump } = require("./gpm");
const { uploadCsv, listarCsv, baixarCsv } = require("./drive");
const { analisar } = require("./faltantes");
const { mesclar, separaHeader, normalizaTexto, chavesDe } = require("./merge");
const { parseCsv, serializeCsv, unir, idxCodChecklist } = require("./uniao");
const layout = require("./../layout.json");
const { reprojetar, validar } = require("./padronizar");

// Onde ficam os exports brutos de cada dia (subem como artefato do run).
const DEBUG_DIR = path.join(process.cwd(), "debug");
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
  const saida = process.env.SAIDA || null;   // modo "dias recuperados"

  const alvos = process.env.DIAS ? await alvosDeDIAS(process.env.DIAS) : await descobrirBuracos();
  if (!alvos.length) {
    console.log("[backfill] nenhum dia faltando. Nada a fazer.");
    return;
  }

  console.log(`[backfill] ${alvos.length} dia(s) alvo | dryRun=${dryRun} | headless=${headless}${saida ? ` | SAIDA=${saida}` : ""}`);
  for (const a of alvos) {
    const modo = saida ? `dia -> ${saida}` : (/^\d{2}\.\d{4}\.csv$/i.test(a.arquivo) ? "mes-inteiro (replace)" : "dia (merge)");
    console.log(`   ${a.dataBR} -> ${modo}`);
  }

  // Modo SAIDA: pre-carrega as chaves (cod_checklist) de cada arquivo de destino
  // e do proprio arquivo de saida, se ja existir. Assim uma linha que ja esta na
  // base nao e duplicada aqui.
  //
  // As partes NAO sao concatenadas como texto: cada dia vem do GPM com um
  // conjunto de perguntas diferente (67 a 78 colunas, medido no run
  // 31483369768), entao juntamos no fim com uniao POR NOME de coluna.
  const chavesPorArquivo = {};
  const partes = [];              // [{ header: string[], rows: string[][] }]
  const chavesSaida = new Set();
  if (saida) {
    for (const nome of [...new Set(alvos.map((a) => a.arquivo))]) {
      const buf = await baixarCsv(nome, cfg);
      chavesPorArquivo[nome] = buf ? chavesDe(buf) : new Set();
      console.log(`[backfill] ${nome}: ${chavesPorArquivo[nome].size} cod_checklist ja na base`);
    }
    const jaExiste = await baixarCsv(saida, cfg);
    if (jaExiste) {
      const p = parseCsv(jaExiste);
      partes.push(p);
      const ic = idxCodChecklist(p.header);
      for (const r of p.rows) chavesSaida.add(`cod:${(r[ic] || "").trim()}`);
      console.log(`[backfill] ${saida} ja existe: ${p.rows.length} linha(s), ${p.header.length} colunas; vamos acrescentar em cima.`);
    }
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

      // Intervalo exportado: mes inteiro (estrategia A) ou so o dia (B e C).
      const intervalo = (ehMensal && !saida)
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

        if (saida) {
          // Estrategia C: guarda as linhas novas deste dia como uma PARTE. Nada
          // existente e tocado. A juncao acontece no fim, por uniao de colunas
          // por NOME — cada dia tem um conjunto de perguntas diferente, entao
          // concatenar texto desalinharia tudo.
          const p = parseCsv(r.buffer);
          const ic = idxCodChecklist(p.header);

          // Guarda o export bruto: se algo der errado na juncao, nao precisa
          // reexportar os 26 dias (cada um e um export no GPM).
          try {
            fs.mkdirSync(DEBUG_DIR, { recursive: true });
            fs.writeFileSync(path.join(DEBUG_DIR, `dia-${alvo.dataBR.replace(/\//g, "-")}.csv`), r.buffer);
          } catch (_) {}

          // Nao repete linha que ja esta no arquivo anual nem no que ja
          // acumulamos aqui.
          const jaNaBase = chavesPorArquivo[alvo.arquivo] || new Set();
          const novas = [];
          let dup = 0;
          for (const linhaArr of p.rows) {
            const cod = (linhaArr[ic] || "").trim();
            const chave = /^\d{3,}$/.test(cod) ? `cod:${cod}` : `linha:${linhaArr.join(";")}`;
            if (jaNaBase.has(chave) || chavesSaida.has(chave)) { dup++; continue; }
            chavesSaida.add(chave);
            novas.push(linhaArr);
          }

          if (!novas.length) {
            console.log(`[backfill] ${rotulo}: nada novo (as ${dup} linha(s) do dia ja estao na base).`);
            manifesto.push({ ...alvo, status: "nada-novo", linhas: 0 });
            continue;
          }
          partes.push({ header: p.header, rows: novas });
          console.log(`[backfill] ${rotulo}: +${novas.length} linha(s) (${dup} ja na base) | ${p.header.length} colunas neste export`);
          manifesto.push({ ...alvo, status: dryRun ? "dry-run-saida" : "ok-saida", linhas: novas.length });
        } else if (ehMensal) {
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

          // Padroniza no layout da base (90 colunas) antes de comparar e subir —
          // igual ao robo diario. Isso resolve de vez o risco antigo de
          // substituir um arquivo por um export mais pobre: as perguntas
          // aposentadas continuam existindo como coluna, e as respostas que o
          // arquivo ja tinha nelas nao sao perdidas porque o export novo do mes
          // nao as sobrescreve — ele SO cobre o mes, e o mes inteiro vem no
          // export. Se algum dia o export vier com pergunta nova, ela e anexada
          // no fim e o run avisa.
          const origem = parseCsv(r.buffer);
          const destino = reprojetar(layout.colunas, origem);
          const v = validar(origem, destino);
          if (!v.ok) {
            throw new Error(`padronizacao perdeu dado em ${alvo.arquivo}: ${v.problemas.slice(0, 5).join(" | ")}`);
          }
          if (destino.anexadas.length) {
            console.warn(`[backfill] ATENCAO: coluna(s) nova(s) anexada(s) no fim: ${destino.anexadas.join(" | ")} — regenere o layout.json.`);
          }
          const bufferFinal = Buffer.from(serializeCsv(destino.header, destino.rows), "utf8");

          if (dryRun) {
            console.log(`[backfill] DRY_RUN: ${alvo.arquivo} ficaria com ${linhas} linhas x ${destino.header.length} colunas (tinha ${linhasAntes}, +${linhas - linhasAntes}).`);
            manifesto.push({ ...alvo, status: "dry-run-replace", linhas, delta: linhas - linhasAntes });
          } else {
            const up = await uploadCsv(bufferFinal, alvo.arquivo, cfg);
            console.log(`[backfill] ${alvo.arquivo} ${up.acao}: ${linhas} linhas x ${destino.header.length} colunas (tinha ${linhasAntes}, +${linhas - linhasAntes}).`);
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

  // Modo SAIDA: junta as partes por uniao de colunas e grava UMA vez, no fim.
  if (saida) {
    const totalLinhas = partes.reduce((a, p) => a + p.rows.length, 0);
    if (!totalLinhas) {
      console.log(`[backfill] nada novo para ${saida}; nao gravo.`);
    } else {
      const u = unir(partes);
      console.log(`[backfill] uniao de ${partes.length} parte(s): ${u.rows.length} linhas, ${u.totalColunas} colunas (colunas por parte: ${u.colunasPorParte.join(", ")})`);
      const texto = serializeCsv(u.header, u.rows);

      // Sanidade: nenhuma linha pode ter mais campos que o cabecalho, e o
      // numero de linhas tem que bater com o que acumulamos.
      const conferido = parseCsv(texto);
      if (conferido.rows.length !== u.rows.length) {
        throw new Error(`uniao inconsistente: gerei ${u.rows.length} linhas mas reler devolveu ${conferido.rows.length}`);
      }
      if (conferido.header.length !== u.totalColunas) {
        throw new Error(`uniao inconsistente: cabecalho com ${conferido.header.length} colunas, esperava ${u.totalColunas}`);
      }

      if (dryRun) {
        console.log(`[backfill] DRY_RUN: ${saida} ficaria com ${u.rows.length} linha(s) e ${u.totalColunas} colunas (${texto.length} bytes). NAO gravado.`);
      } else {
        const up = await uploadCsv(Buffer.from(texto, "utf8"), saida, cfg);
        console.log(`[backfill] ${saida} ${up.acao}: ${u.rows.length} linha(s), ${u.totalColunas} colunas.`);
      }
    }
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
