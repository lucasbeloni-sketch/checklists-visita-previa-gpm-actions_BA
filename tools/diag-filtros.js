// Diagnostico: qual combinacao de filtros de data realmente traz dados?
//
// Motivo: o dry run 31423258993 mostrou "Nenhum registro encontrado" para
// 01/08/2026 a 09/08/2026, embora o 08.2026.csv gerado pela Skill no mesmo dia
// tenha 70 linhas com datas de 01/08 a 08/08. Ou seja, a combinacao que o robo
// aplica (os DOIS pares de data preenchidos, fim as 23:59) e mais restritiva do
// que a que a Skill efetivamente usava.
//
// Hipotese principal: o "bug" que a Skill descrevia (o campo Data Inspeção Fim
// nao atualizava) significava que ela rodava com esse par vazio ou defasado —
// sem limite superior de inspecao. Um checklist com Data Serviço em 05/08 e
// Data Inspeção em 10/08 passa no filtro dela e nao no nosso.
//
// Este script testa combinacoes uma a uma, no MESMO periodo, e reporta quantas
// linhas cada uma devolve. Nao grava nada no Drive.
//
//   PERIODO="01/08/2026,09/08/2026" npm run diag
//
// Saida: uma tabela combinacao -> linhas (ou "vazio"), pra decidir qual filtro
// o robo deve usar.

const { chromium } = require("playwright");
const cfg = require("../config.json");
const {
  login, abrirChecklists, camposData, setDataFp, fmtISO, selecionarChoices,
  esperarTiposCarregar, exportar, extrairCsv, dump,
} = require("../src/gpm");
const { intervaloD1, contarLinhasDados, validarIntervalo } = require("../src/util");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const p2 = (n) => String(n).padStart(2, "0");

function partesDeBR(s) {
  const m = String(s).trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) throw new Error(`data invalida: "${s}" (use dd/mm/aaaa)`);
  return { dia: Number(m[1]), mes: Number(m[2]), ano: Number(m[3]) };
}

// Limpa um campo de data pela API do flatpickr (para testar "sem filtro").
async function limpar(root, campo) {
  const r = await root.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return { ok: false };
    if (el._flatpickr) el._flatpickr.clear();
    else el.value = "";
    return { ok: true, valor: el.value };
  }, campo.sel);
  console.log(`   [limpo] ${campo.label} = "${r.valor}"`);
}

// COMBINACOES testadas. `servico`/`inspecao`: "range" | "vazio" | "range00"
// (range00 = fim as 00:00, que e o que a Skill fazia sem querer).
// Rodada 1 (feita no run 31423616921) provou que NENHUMA combinacao de data
// devolve dados — inclusive a que a Skill usava. Entao o problema nao e o
// filtro de data. Estes controles isolam o que sobrou: periodo com volume
// conhecido, outros tipos de checklist, e sem filtro de tipo.
//   `tipo`: texto exato do Tipo de Checklist, ou null pra nao mexer no campo.
//   `periodo`: [inicioBR, fimBR] proprio, ou null pra usar o do PERIODO/env.
const COMBOS = [
  {
    nome: "E: julho/2026 inteiro + UTD (a Skill tirou 331 linhas desse periodo)",
    servico: "range", inspecao: "range", periodo: ["01/07/2026", "31/07/2026"],
  },
  {
    nome: "F: julho/2026 inteiro, SEM filtro de tipo (deixa o campo como veio)",
    servico: "range", inspecao: "range", periodo: ["01/07/2026", "31/07/2026"], tipo: null, semTipo: true,
  },
  {
    nome: "G: julho/2026 inteiro + LPT - Visita Prévia-BA (outro tipo)",
    servico: "range", inspecao: "range", periodo: ["01/07/2026", "31/07/2026"],
    tipo: "LPT - Visita Prévia-BA", tokenTipo: "LPT - Visita",
  },
  {
    nome: "H: julho/2026 inteiro + Visita Prévia (Concluídas)",
    servico: "range", inspecao: "range", periodo: ["01/07/2026", "31/07/2026"],
    tipo: "Visita Prévia (Concluídas)", tokenTipo: "Concluí",
  },
];

(async () => {
  const headless = !process.env.HEADED;
  const per = process.env.PERIODO;
  let inicio, fim;
  if (per) {
    const [a, b] = per.split(",");
    inicio = partesDeBR(a); fim = partesDeBR(b);
  } else {
    ({ inicio, fim } = intervaloD1(cfg.timezone));
  }
  let mesAno = `${p2(fim.mes)}.${fim.ano}`;
  console.log(`[diag] periodo: ${p2(inicio.dia)}/${p2(inicio.mes)}/${inicio.ano} a ${p2(fim.dia)}/${p2(fim.mes)}/${fim.ano}\n`);

  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);

  const resultados = [];
  try {
    await login(page, cfg);

    // QUEM esta logado? A Skill rodava na sessao do proprio usuario (o zip dela
    // se chamava "Checklists PerguntaResposta_SIR795027_..."). Se o secret for
    // outra conta, com visibilidade menor de contrato/unidade, o export volta
    // vazio com os mesmos filtros — por isso conferimos a identidade aqui.
    const quem = await page.evaluate(() => {
      const html = document.documentElement.innerHTML;
      const codigos = [...new Set((html.match(/SIR\d{5,}/g) || []))];
      const texto = (document.body.innerText || "").replace(/\s+/g, " ");
      return { codigos, header: texto.slice(0, 300) };
    }).catch(() => ({ codigos: [], header: "" }));
    console.log(`[diag] codigos de usuario vistos no shell: ${JSON.stringify(quem.codigos)}`);
    console.log(`[diag] header: ${quem.header}
`);

    for (const combo of COMBOS) {
      console.log(`\n########## ${combo.nome} ##########`);
      try {
        // Recarrega a tela a cada combinacao: garante estado limpo (o GPM reseta
        // campos depois de um export sem resultado).
        const root = await abrirChecklists(page, cfg);
        const campos = camposData(cfg);
        const ini = combo.periodo ? partesDeBR(combo.periodo[0]) : inicio;
        const fimC = combo.periodo ? partesDeBR(combo.periodo[1]) : fim;

        // campos[0..1] = Data Servico ini/fim | campos[2..3] = Data Inspecao ini/fim
        const pares = [
          { modo: combo.servico, ini: campos[0], fim: campos[1] },
          { modo: combo.inspecao, ini: campos[2], fim: campos[3] },
        ];
        const esperados = {};
        for (const par of pares) {
          if (par.modo === "vazio") {
            await limpar(root, par.ini);
            await limpar(root, par.fim);
            continue;
          }
          const horaFim = par.modo === "range00" ? "00:00" : (cfg.horaFim || "23:59");
          await setDataFp(root, par.ini, ini, cfg.horaInicio || "00:00");
          await setDataFp(root, par.fim, fimC, horaFim);
          esperados[par.ini.sel] = fmtISO(ini, cfg.horaInicio || "00:00");
          esperados[par.fim.sel] = fmtISO(fimC, horaFim);
        }

        await selecionarChoices(root, cfg, "finalidade", cfg.finalidade, cfg.finalidadeSearch);
        await esperarTiposCarregar(root, cfg);
        if (combo.semTipo) {
          console.log("   [tipo] nao mexido de proposito (controle sem filtro de tipo)");
        } else {
          const alvoTipo = combo.tipo || cfg.tipoChecklist;
          const tokenTipo = combo.tokenTipo || cfg.tipoChecklistSearch;
          await selecionarChoices(root, cfg, "tipoChecklist", alvoTipo, tokenTipo);
        }

        // Estado real dos 4 campos + do radio "conforme" na hora do export.
        const estado = await root.evaluate(() => {
          const v = (s) => { const el = document.querySelector(s); return el ? el.value : "<ausente>"; };
          const radio = [...document.querySelectorAll('input[name="conforme"]')]
            .map((r) => `${r.value}${r.checked ? "(X)" : ""}`).join(" ");
          return {
            data_inicial: v("#data_inicial"), data_final: v("#data_final"),
            data_insp_in: v("#data_insp_in"), data_insp_out: v("#data_insp_out"),
            finalidade: v("#finalidade"), tipos: v("#tipos"), conforme: radio,
          };
        });
        console.log(`   [estado] ${JSON.stringify(estado)}`);

        const r = await exportar(page, root, cfg);
        if (r.vazio) {
          console.log(`   >>> RESULTADO: vazio (toast "Nenhum registro encontrado")`);
          resultados.push({ combo: combo.nome, linhas: 0, obs: "toast vazio", estado });
          continue;
        }
        const { buffer, bytes } = extrairCsv(r.arquivo);
        const linhas = contarLinhasDados(buffer);
        const iv = validarIntervalo(buffer, `${p2(fimC.mes)}.${fimC.ano}`);
        console.log(`   >>> RESULTADO: ${linhas} linhas, ${bytes} bytes | Data Execucao ${iv.min} a ${iv.max}`);
        resultados.push({ combo: combo.nome, linhas, obs: `exec ${iv.min}..${iv.max}`, estado });
      } catch (e) {
        console.error(`   >>> ERRO: ${e.message}`);
        await dump(page, `diag-erro-${resultados.length}`);
        resultados.push({ combo: combo.nome, linhas: -1, obs: `erro: ${e.message}` });
      }
      await sleep(2000);
    }
  } finally {
    await browser.close();
  }

  console.log("\n=== Resumo ===");
  for (const r of resultados) {
    const n = r.linhas < 0 ? "ERRO" : (r.linhas === 0 ? "vazio" : `${r.linhas} linhas`);
    console.log(`  ${n.padEnd(12)} ${r.combo}\n               ${r.obs}`);
  }
})().catch((e) => {
  console.error(`[diag] FALHA FATAL: ${e.message}`);
  process.exit(1);
});
