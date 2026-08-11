// Confere se os valores de um arquivo da pasta estao sob a coluna CERTA,
// comparando contra um export novo do GPM do mesmo periodo.
//
// Por que: a auditoria estrutural (npm run auditar) mostra que toda linha tem a
// largura do cabecalho do seu arquivo. Isso NAO garante significado: se dois
// exports mensais tinham o mesmo numero de colunas com perguntas diferentes, as
// respostas podem ter ficado sob o cabecalho errado e a largura nao denuncia.
//
// Como funciona: exporta o mes do GPM, casa as linhas por cod_checklist e
// compara celula a celula APENAS nas colunas cujo NOME existe nos dois lados.
// Se o arquivo estiver alinhado, a taxa de divergencia e ~0. Se as respostas
// estiverem deslocadas, ela explode.
//
//   MESES="06/2023,06/2024,06/2025" npm run conferir
//
// Nao grava nada em lugar nenhum.

const { chromium } = require("playwright");
const cfg = require("../config.json");
const { login, baixarChecklists, dump } = require("../src/gpm");
const { baixarCsv, listarCsv } = require("../src/drive");
const { parseCsv, idxCodChecklist } = require("../src/uniao");

const p2 = (n) => String(n).padStart(2, "0");
const norm = (v) => String(v ?? "").replace(/\s+/g, " ").trim();

function ultimoDiaDoMes(ano, mes) {
  return new Date(Date.UTC(ano, mes, 0)).getUTCDate();
}

// Onde esse mes vive na pasta: mm.aaaa.csv se existir, senao aaaa.csv.
function arquivoDoMes(nomes, mes, ano) {
  const mensal = `${p2(mes)}.${ano}.csv`;
  return nomes.includes(mensal) ? mensal : `${ano}.csv`;
}

(async () => {
  const lista = (process.env.MESES || "06/2023,06/2024,06/2025").split(",").map((s) => s.trim());
  const nomes = (await listarCsv(cfg)).map((f) => f.name);

  const browser = await chromium.launch({ headless: !process.env.HEADED });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);

  const resultados = [];
  try {
    await login(page, cfg);

    for (const item of lista) {
      const [mm, aaaa] = item.split("/").map(Number);
      const arquivo = arquivoDoMes(nomes, mm, aaaa);
      console.log(`\n########## ${p2(mm)}/${aaaa} -> ${arquivo} ##########`);

      const intervalo = {
        inicio: { ano: aaaa, mes: mm, dia: 1 },
        fim: { ano: aaaa, mes: mm, dia: ultimoDiaDoMes(aaaa, mm) },
      };

      try {
        const r = await baixarChecklists(page, cfg, `${p2(mm)}.${aaaa}`, intervalo);
        if (r.vazio) {
          console.log("   GPM: nenhum registro no periodo — nada a comparar.");
          resultados.push({ item, arquivo, status: "gpm-vazio" });
          continue;
        }

        const novo = parseCsv(r.buffer);
        const atual = parseCsv(await baixarCsv(arquivo, cfg));
        const icNovo = idxCodChecklist(novo.header);
        const icAtual = idxCodChecklist(atual.header);

        // Colunas comparaveis: nome presente nos dois cabecalhos.
        const posAtual = new Map();
        atual.header.forEach((h, i) => { if (!posAtual.has(norm(h))) posAtual.set(norm(h), i); });
        const comuns = [];
        novo.header.forEach((h, i) => {
          const j = posAtual.get(norm(h));
          if (j !== undefined) comuns.push({ nome: h, iNovo: i, iAtual: j });
        });

        // Indexa o arquivo atual por cod_checklist.
        const porCod = new Map();
        for (const row of atual.rows) porCod.set(norm(row[icAtual]), row);

        let comparadas = 0, celulas = 0, divergentes = 0, ausentes = 0;
        const exemplos = [];
        const porColuna = {};
        for (const row of novo.rows) {
          const cod = norm(row[icNovo]);
          const alvo = porCod.get(cod);
          if (!alvo) { ausentes++; continue; }
          comparadas++;
          for (const c of comuns) {
            const a = norm(row[c.iNovo]);
            const b = norm(alvo[c.iAtual]);
            celulas++;
            if (a !== b) {
              divergentes++;
              porColuna[c.nome] = (porColuna[c.nome] || 0) + 1;
              if (exemplos.length < 6) {
                exemplos.push(`cod ${cod} | "${c.nome.slice(0, 40)}": GPM="${a.slice(0, 40)}" arquivo="${b.slice(0, 40)}"`);
              }
            }
          }
        }

        const taxa = celulas ? (divergentes / celulas) * 100 : 0;
        console.log(`   GPM: ${novo.rows.length} linhas, ${novo.header.length} colunas | arquivo: ${atual.rows.length} linhas, ${atual.header.length} colunas`);
        console.log(`   colunas comparaveis (mesmo nome): ${comuns.length}`);
        console.log(`   linhas casadas por cod_checklist: ${comparadas} | do GPM sem par no arquivo: ${ausentes}`);
        console.log(`   celulas comparadas: ${celulas} | divergentes: ${divergentes} (${taxa.toFixed(2)}%)`);
        const piores = Object.entries(porColuna).sort((a, b) => b[1] - a[1]).slice(0, 5);
        if (piores.length) {
          console.log(`   colunas que mais divergem: ${piores.map(([n, q]) => `"${n.slice(0, 35)}"=${q}`).join(" | ")}`);
        }
        for (const e of exemplos) console.log(`   ex.: ${e}`);
        resultados.push({ item, arquivo, comparadas, ausentes, celulas, divergentes, taxa, colunasComuns: comuns.length });
      } catch (e) {
        console.error(`   ERRO: ${e.message}`);
        await dump(page, `conferir-erro-${p2(mm)}-${aaaa}`);
        resultados.push({ item, arquivo, status: `erro: ${e.message}` });
      }
    }
  } finally {
    await browser.close();
  }

  console.log("\n=== Resumo ===");
  console.log("mes;arquivo;linhas_casadas;sem_par;celulas;divergentes;taxa%;colunas_comuns");
  for (const r of resultados) {
    if (r.status) { console.log(`${r.item};${r.arquivo};${r.status}`); continue; }
    console.log(`${r.item};${r.arquivo};${r.comparadas};${r.ausentes};${r.celulas};${r.divergentes};${r.taxa.toFixed(2)};${r.colunasComuns}`);
  }
  console.log("\nLeitura: taxa ~0% = arquivo alinhado. Taxa alta = respostas sob a coluna errada.");
})().catch((e) => {
  console.error(`[conferir] FALHA FATAL: ${e.message}`);
  process.exit(1);
});
