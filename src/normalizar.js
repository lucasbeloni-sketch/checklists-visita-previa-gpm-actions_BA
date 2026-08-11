// Padronizacao da base para o layout CANONICO (o mais recente do GPM).
//
// Objetivo: a pasta vai ser carregada por uma plataforma, que espera um layout
// unico. Hoje conviverm varias versoes do questionario:
//   2023.csv 69 colunas | 2024.csv 87 | 2025.csv 81 | 2026 mensais 78
//   dias_recuperados_2023-2025.csv 87
// O canonico e o layout dos arquivos de 2026 (o que o GPM exporta hoje).
//
// A reprojecao e SEMPRE por NOME de coluna, nunca por posicao: e o que garante
// que a resposta de cada pergunta caia na coluna daquela pergunta. Foi conferido
// contra o GPM (npm run conferir): os arquivos existentes estao alinhados, entao
// casar por nome preserva o significado.
//
// Duas politicas para as perguntas que existiam antes e sairam do formulario:
//   "descartar" -> so as colunas canonicas (a plataforma le exatamente o layout
//                  novo; as respostas das perguntas extintas ficam fora)
//   "anexar"    -> colunas canonicas na ordem + as extintas no fim (nada se
//                  perde; exige que a plataforma case coluna por NOME)

const { parseCsv, serializeCsv } = require("./uniao");

const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

// Mapa nome-normalizado -> indice, resolvendo nomes repetidos com sufixo.
function indicePorNome(header) {
  const m = new Map();
  header.forEach((h, i) => {
    let k = norm(h);
    let n = 2;
    while (m.has(k)) k = `${norm(h)}#${n++}`;
    m.set(k, i);
  });
  return m;
}

// Analisa o que aconteceria ao reprojetar `partes` no `canonico`, sem gerar
// arquivo. Devolve, por parte: colunas que casam, colunas extintas (fora do
// canonico) e quantos VALORES NAO VAZIOS seriam descartados em cada uma.
function analisar(canonico, partes) {
  const idxCanon = indicePorNome(canonico);
  const relatorio = [];

  for (const { nome, header, rows } of partes) {
    const casam = [];
    const extintas = [];
    header.forEach((h, i) => {
      const k = norm(h);
      if (idxCanon.has(k)) casam.push({ nome: h, iOrigem: i, iCanon: idxCanon.get(k) });
      else extintas.push({ nome: h, iOrigem: i, naoVazios: 0 });
    });

    for (const row of rows) {
      for (const e of extintas) {
        if (norm(row[e.iOrigem]) !== "") e.naoVazios++;
      }
    }

    // Colunas canonicas que esta parte nao tem (vao ficar vazias).
    const ausentes = canonico.filter((h) => !header.some((x) => norm(x) === norm(h)));

    relatorio.push({
      nome,
      linhas: rows.length,
      colunasOrigem: header.length,
      casam: casam.length,
      extintas: extintas.filter((e) => e.naoVazios > 0).sort((a, b) => b.naoVazios - a.naoVazios),
      extintasVazias: extintas.filter((e) => e.naoVazios === 0).length,
      valoresDescartados: extintas.reduce((a, e) => a + e.naoVazios, 0),
      ausentes: ausentes.length,
    });
  }
  return relatorio;
}

// Reprojeta as partes no layout canonico.
// politica: "descartar" | "anexar".
// Devolve { header, rows, extintasUsadas }.
function normalizar(canonico, partes, { politica = "anexar" } = {}) {
  const idxCanon = indicePorNome(canonico);

  // Colunas extintas (com valor) na ordem em que aparecem, se a politica pedir.
  const extras = [];
  if (politica === "anexar") {
    for (const { header, rows } of partes) {
      header.forEach((h, i) => {
        if (idxCanon.has(norm(h))) return;
        if (extras.some((e) => norm(e.nome) === norm(h))) return;
        // So anexa se houver algum valor de verdade nessa coluna.
        if (rows.some((r) => norm(r[i]) !== "")) extras.push({ nome: h });
      });
    }
  }

  const header = [...canonico, ...extras.map((e) => e.nome)];
  const idxFinal = indicePorNome(header);

  const rows = [];
  for (const parte of partes) {
    for (const r of parte.rows) {
      const nova = new Array(header.length).fill("");
      parte.header.forEach((h, i) => {
        const j = idxFinal.get(norm(h));
        if (j !== undefined) nova[j] = r[i] ?? "";
      });
      rows.push(nova);
    }
  }

  return { header, rows, extintasUsadas: extras.map((e) => e.nome) };
}

// Le um CSV (Buffer) e devolve a parte pronta pro normalizador.
function parte(nome, buf) {
  const { header, rows } = parseCsv(buf);
  return { nome, header, rows };
}

module.exports = { analisar, normalizar, parte, indicePorNome, serializeCsv, norm };
