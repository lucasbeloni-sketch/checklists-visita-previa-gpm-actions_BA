// Mostra o CUSTO de padronizar a pasta no layout canonico, sem gerar arquivo.
// Le so o Drive; nao toca no GPM.
//
//   GOOGLE_CREDENTIALS="$(cat credentials.json)" npm run analisar
//
// Responde: quantas perguntas de cada arquivo antigo nao existem mais no layout
// atual, e quantas RESPOSTAS de verdade (valores nao vazios) seriam descartadas
// se a base fosse conformada exatamente ao layout novo.

const cfg = require("../config.json");
const { listarCsv, baixarCsv } = require("../src/drive");
const { parseCsv } = require("../src/uniao");
const { analisar, parte } = require("../src/normalizar");

// O canonico e o layout do arquivo mensal mais recente (mm.aaaa.csv de maior
// ano/mes) — e o que o GPM exporta hoje e o que a plataforma vai esperar.
function escolherCanonico(nomes) {
  const mensais = nomes
    .map((n) => n.match(/^(\d{2})\.(\d{4})\.csv$/i))
    .filter(Boolean)
    .map((m) => ({ nome: m[0], mes: Number(m[1]), ano: Number(m[2]) }))
    .sort((a, b) => (b.ano - a.ano) || (b.mes - a.mes));
  return mensais.length ? mensais[0].nome : null;
}

(async () => {
  const arquivos = (await listarCsv(cfg)).sort((a, b) => a.name.localeCompare(b.name));
  const nomes = arquivos.map((f) => f.name);
  const nomeCanonico = escolherCanonico(nomes);
  if (!nomeCanonico) throw new Error("nao achei nenhum mm.aaaa.csv pra usar como layout canonico");

  const bufCanon = await baixarCsv(nomeCanonico, cfg);
  const canonico = parseCsv(bufCanon).header;
  console.log(`[analisar] layout canonico = ${nomeCanonico} (${canonico.length} colunas)\n`);

  const partes = [];
  for (const f of arquivos) {
    if (f.name === nomeCanonico) continue;
    partes.push(parte(f.name, await baixarCsv(f.name, cfg)));
  }

  const rel = analisar(canonico, partes);

  let totalLinhas = parseCsv(bufCanon).rows.length;
  let totalDescartes = 0;
  const extintasGlobais = new Map();

  for (const r of rel) {
    totalLinhas += r.linhas;
    totalDescartes += r.valoresDescartados;
    console.log(`${r.nome}: ${r.linhas} linhas, ${r.colunasOrigem} colunas`);
    console.log(`   casam com o canonico: ${r.casam} | canonicas ausentes (ficariam vazias): ${r.ausentes}`);
    console.log(`   colunas fora do canonico: ${r.extintas.length} com dado, ${r.extintasVazias} vazias`);
    if (r.valoresDescartados) {
      console.log(`   RESPOSTAS que a politica "descartar" jogaria fora: ${r.valoresDescartados}`);
      for (const e of r.extintas.slice(0, 8)) {
        console.log(`      ${e.naoVazios} valor(es) em "${e.nome.slice(0, 70)}"`);
        extintasGlobais.set(e.nome, (extintasGlobais.get(e.nome) || 0) + e.naoVazios);
      }
      for (const e of r.extintas.slice(8)) {
        extintasGlobais.set(e.nome, (extintasGlobais.get(e.nome) || 0) + e.naoVazios);
      }
    }
    console.log("");
  }

  console.log("=== Resumo ===");
  console.log(`linhas na base toda: ${totalLinhas}`);
  console.log(`perguntas extintas (fora do layout atual) com resposta: ${extintasGlobais.size}`);
  console.log(`respostas que a politica "descartar" perderia: ${totalDescartes}`);
  console.log("");
  console.log("Perguntas extintas, por volume de resposta:");
  for (const [nome, n] of [...extintasGlobais.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(6)}  ${nome}`);
  }
})().catch((e) => {
  console.error(`[analisar] FALHOU: ${e.message}`);
  process.exit(1);
});
