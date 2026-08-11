// Orquestrador: login no GPM BA -> exporta Checklists Pergunta/Resposta
// (Visita Previa) do periodo ancorado em ontem (D-1) -> extrai o CSV do zip ->
// envia/sobrescreve mm.aaaa.csv na pasta Checklists_Visita_Previa do Drive.
//
// Roda igual local e no GitHub Actions. Headless por padrao; HEADED=1 abre o
// browser visivel (debug local). DRY_RUN=1 baixa mas nao envia ao Drive.

const { chromium } = require("playwright");
const cfg = require("../config.json");
const layout = require("../layout.json");
const { login, baixarChecklists, dump } = require("./gpm");
const { uploadCsv } = require("./drive");
const { carimbar } = require("./timestamp");
const { mesAnoD1, intervaloD1, fmtBR, validarIntervalo } = require("./util");
const { parseCsv, serializeCsv } = require("./uniao");
const { reprojetar, validar } = require("./padronizar");

// Retenta fn ate `tentativas` vezes (GPM e flaky). Loga cada tentativa.
async function comRetry(fn, label, tentativas = 2) {
  let err;
  for (let i = 1; i <= tentativas; i++) {
    try {
      return await fn();
    } catch (e) {
      err = e;
      if (i < tentativas) console.warn(`[run] ${label}: tentativa ${i}/${tentativas} falhou (${e.message}); tentando de novo...`);
    }
  }
  throw err;
}

(async () => {
  const headless = !process.env.HEADED;
  const dryRun = !!process.env.DRY_RUN;
  const mesAno = mesAnoD1(cfg.timezone);
  const { inicio, fim } = intervaloD1(cfg.timezone);
  console.log(`[run] periodo D-1: ${fmtBR(inicio)} a ${fmtBR(fim)} | arquivo=${mesAno}.csv | headless=${headless} | dryRun=${dryRun}`);

  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);

  let resultado = null;
  let falhou = false;
  try {
    await login(page, cfg);

    const r0 = await comRetry(
      () => baixarChecklists(page, cfg, mesAno),
      "export checklists"
    );

    // Periodo sem checklists (toast "Nenhum registro encontrado") e condicao
    // normal — nao falha e nao toca no Drive (o arquivo do mes fica como esta).
    if (r0.vazio) {
      console.log("[run] nada a exportar (periodo sem registros). Encerrando OK sem enviar ao Drive.");
      resultado = { nomeFinal: `${mesAno}.csv`, acao: "vazio-skip", bytes: 0, md5: "-" };
      // Mes vazio tambem e execucao bem-sucedida: carimba, senao a planilha
      // faria parecer que o robo parou de rodar.
      if (!dryRun) await carimbar(cfg, "(sem registros)");
      return; // finally fecha o browser; sai 0
    }
    const { buffer, md5, bytes, linhas, nomeFinal } = r0;

    // Guard anti-clobber: nao sobrescrever o arquivo do mes com um CSV vazio
    // (so cabecalho) — provavel glitch/filtro errado do GPM.
    const minLinhas = cfg.minLinhasDados ?? 1;
    if (linhas < minLinhas) {
      throw new Error(`CSV com ${linhas} linha(s) de dados (< minimo ${minLinhas}). NAO sobrescrevo o arquivo do mes (provavel glitch do GPM).`);
    }

    // Mesma validacao do preparar_csv.py da Skill (AVISO_INTERVALO): as datas
    // do CSV tem que cair dentro do mes/ano do arquivo. Se cairem fora, o
    // filtro de data provavelmente nao foi aplicado como pretendido — abortamos
    // antes de sobrescrever o mes com dados do periodo errado.
    const iv = validarIntervalo(buffer, mesAno);
    console.log(`[run] Data Execucao no CSV: min=${iv.min} max=${iv.max} (${iv.total} linhas)`);
    if (iv.fora) {
      throw new Error(`AVISO_INTERVALO: alguma "Data Execução" caiu fora de ${mesAno} (min=${iv.min}, max=${iv.max}). NAO envio ao Drive.`);
    }

    // Padroniza no layout da base (layout.json, 90 colunas) antes de subir. A
    // pasta e carregada por uma plataforma, entao todo arquivo tem que ter o
    // MESMO cabecalho: as 78 colunas que o GPM exporta hoje + as 12 perguntas
    // aposentadas (vazias nos meses novos, preenchidas no historico).
    // Se o GPM ganhar pergunta nova, ela e anexada no fim e o run avisa — nunca
    // descartada.
    const origem = parseCsv(buffer);
    const destino = reprojetar(layout.colunas, origem);
    const v = validar(origem, destino);
    if (!v.ok) {
      throw new Error(`padronizacao no layout perdeu dado: ${v.problemas.slice(0, 5).join(" | ")}`);
    }
    if (destino.anexadas.length) {
      console.warn(`[run] ATENCAO: ${destino.anexadas.length} coluna(s) nova(s) no export, anexada(s) no fim: ${destino.anexadas.join(" | ")}`);
      console.warn("[run] regenere o layout.json pra manter a pasta homogenea.");
    }
    const bufferFinal = Buffer.from(serializeCsv(destino.header, destino.rows), "utf8");
    console.log(`[run] padronizado: ${origem.header.length} -> ${destino.header.length} colunas, ${destino.rows.length} linhas (${bufferFinal.length} bytes)`);

    if (dryRun) {
      console.log(`[run] DRY_RUN: ${nomeFinal} (${bufferFinal.length} bytes, ${linhas} linhas) NAO enviado ao Drive.`);
      resultado = { nomeFinal, md5, bytes: bufferFinal.length, acao: "dry-run" };
    } else {
      const r = await uploadCsv(bufferFinal, nomeFinal, cfg);
      resultado = { nomeFinal, md5, bytes: bufferFinal.length, acao: r.acao };
    }
  } catch (e) {
    falhou = true;
    console.error(`[run] ERRO: ${e.message}`);
    await dump(page, "erro-fatal");
  } finally {
    await browser.close();
  }

  // Carimbo de fim de execucao na planilha de controle (BD_Config!C8). So em
  // run de verdade que deu certo: DRY_RUN e falha nao mexem na planilha.
  if (!falhou && resultado && !dryRun) await carimbar(cfg);

  console.log("\n=== Resumo ===");
  if (resultado) console.log(`  ${resultado.nomeFinal}: ${resultado.acao} (${resultado.bytes} bytes, md5=${resultado.md5})`);
  if (falhou || !resultado) {
    console.error("[run] terminou COM falhas.");
    process.exit(1);
  }
  console.log("[run] terminou OK.");
})();
