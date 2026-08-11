// Reprojeta um CSV no layout canonico (layout.json) e PROVA que nada foi perdido.
//
// A reprojecao e por NOME de coluna. Isso e seguro porque a conferencia contra o
// GPM (npm run conferir, run 31486945862) mostrou 0 divergencia em 77.676
// celulas: os arquivos existentes estao com cada resposta sob a coluna certa.
//
// O layout tem 90 colunas: as 78 que o GPM exporta hoje + 12 perguntas que
// sairam do formulario, mantidas no fim. Por construcao ele e SUPERCONJUNTO de
// todos os arquivos da pasta, entao a reprojecao nunca descarta resposta.
//
// A funcao `validar` e o portao: compara, coluna por coluna e por NOME, quantas
// celulas preenchidas existiam antes e depois. Qualquer diferenca aborta.

const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

// nome-normalizado -> indice (nomes repetidos ganham sufixo #2, #3...)
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

// Celulas preenchidas por nome de coluna: { "nome" => quantidade }.
function preenchidasPorNome(header, rows) {
  const chaves = [...indicePorNome(header).entries()].sort((a, b) => a[1] - b[1]).map(([k]) => k);
  const conta = new Map();
  for (const r of rows) {
    chaves.forEach((k, i) => {
      if (norm(r[i]) !== "") conta.set(k, (conta.get(k) || 0) + 1);
    });
  }
  return conta;
}

// Reprojeta as linhas de {header, rows} no `layout`.
// Colunas do layout que a origem nao tem ficam vazias.
// Colunas da origem que o layout nao tem sao ANEXADAS no fim (nunca descartadas)
// e reportadas em `anexadas` — e o sinal de que o GPM ganhou pergunta nova.
function reprojetar(layout, { header, rows }) {
  const colunas = [...layout];
  const idx = indicePorNome(colunas);
  const anexadas = [];

  const de = indicePorNome(header);
  const chavesOrigem = [...de.entries()].sort((a, b) => a[1] - b[1]).map(([k]) => k);

  for (const k of chavesOrigem) {
    if (idx.has(k)) continue;
    const iOrigem = de.get(k);
    const temDado = rows.some((r) => norm(r[iOrigem]) !== "");
    // Coluna desconhecida e vazia nao vira coluna nova; com dado, vira.
    if (!temDado) continue;
    colunas.push(header[iOrigem]);
    idx.set(k, colunas.length - 1);
    anexadas.push(header[iOrigem]);
  }

  const novas = rows.map((r) => {
    const linha = new Array(colunas.length).fill("");
    chavesOrigem.forEach((k, i) => {
      const j = idx.get(k);
      if (j !== undefined) linha[j] = r[i] ?? "";
    });
    return linha;
  });

  return { header: colunas, rows: novas, anexadas };
}

// Portao de seguranca: o resultado tem que ter as mesmas celulas preenchidas que
// a origem, coluna por coluna (por nome), e a mesma quantidade de linhas.
// Devolve { ok, problemas: string[] }.
function validar(origem, destino) {
  const problemas = [];
  if (origem.rows.length !== destino.rows.length) {
    problemas.push(`linhas: origem ${origem.rows.length}, destino ${destino.rows.length}`);
  }
  const larguras = new Set(destino.rows.map((r) => r.length));
  if (larguras.size > 1 || (larguras.size === 1 && [...larguras][0] !== destino.header.length)) {
    problemas.push(`larguras irregulares no destino: ${[...larguras].join(",")} (cabecalho tem ${destino.header.length})`);
  }

  const antes = preenchidasPorNome(origem.header, origem.rows);
  const depois = preenchidasPorNome(destino.header, destino.rows);
  for (const [k, n] of antes) {
    const m = depois.get(k) || 0;
    if (m !== n) problemas.push(`coluna "${k.slice(0, 60)}": ${n} celula(s) preenchida(s) na origem, ${m} no destino`);
  }
  return { ok: problemas.length === 0, problemas };
}

// Junta partes que JA estao no mesmo layout, deduplicando por cod_checklist.
// Usada pra dissolver o arquivo de dias recuperados dentro do arquivo do ano.
function juntarNoLayout(layout, partes) {
  const idx = indicePorNome(layout);
  const ic = idx.get(norm("cod_checklist")) ?? 3;
  const vistos = new Set();
  const rows = [];
  let dup = 0;
  for (const p of partes) {
    for (const r of p.rows) {
      const cod = norm(r[ic]);
      const chave = /^\d{3,}$/.test(cod) ? `cod:${cod}` : `linha:${r.join(";")}`;
      if (vistos.has(chave)) { dup++; continue; }
      vistos.add(chave);
      rows.push(r);
    }
  }
  return { header: [...layout], rows, dup };
}

// Ano (aaaa) da coluna Data Execução de uma linha ja no layout.
function anoDaLinha(layout, row) {
  const i = layout.findIndex((h) => /^Data\s+Execu/i.test(norm(h)));
  const v = norm(row[i >= 0 ? i : 6]);
  const m = v.match(/^\d{2}\/\d{2}\/(\d{4})/);
  return m ? m[1] : null;
}

module.exports = { reprojetar, validar, juntarNoLayout, preenchidasPorNome, indicePorNome, anoDaLinha, norm };
