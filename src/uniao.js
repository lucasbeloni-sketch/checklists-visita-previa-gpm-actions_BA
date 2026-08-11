// Uniao de CSVs com conjuntos de colunas DIFERENTES.
//
// Por que isso existe: o export de "Checklists Pergunta/Resposta" traz uma
// coluna por PERGUNTA, e so as perguntas que aparecem nos registros filtrados.
// Medido no run 31483369768, exportando um dia de cada mes de 2023-2025, o
// numero de colunas variou entre 67 e 78 — e dois dias com 67 colunas tinham
// conjuntos de perguntas distintos. Ou seja: nao existe schema estavel, nem
// dentro do mesmo ano.
//
// Entao, para juntar os dias recuperados num unico arquivo, casamos as colunas
// POR NOME: o arquivo final tem a uniao das perguntas, na ordem em que foram
// vistas, e cada linha preenche o que tem, deixando vazio o que nao se aplica.
//
// As 8 primeiras colunas sao fixas em todas as versoes vistas (Contrato, Ordem
// trabalho, Ordem trabalho Principal, cod_checklist, Cliente, Funcionario,
// Data Execução, formulario), entao a uniao preserva elas na frente.

// Parser de CSV com aspas: campo entre aspas pode conter o separador, aspas
// escapadas ("") e quebra de linha. Devolve { header: string[], rows: string[][] }.
function parseCsv(texto, sep = ";") {
  let t = Buffer.isBuffer(texto) ? texto.toString("utf8") : String(texto);
  if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);       // BOM
  t = t.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  const linhas = [];
  let campo = "";
  let linha = [];
  let dentroDeAspas = false;

  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (dentroDeAspas) {
      if (c === '"') {
        if (t[i + 1] === '"') { campo += '"'; i++; }     // aspas escapadas
        else dentroDeAspas = false;
      } else campo += c;
      continue;
    }
    if (c === '"') { dentroDeAspas = true; continue; }
    if (c === sep) { linha.push(campo); campo = ""; continue; }
    if (c === "\n") {
      linha.push(campo); campo = "";
      if (linha.some((x) => x !== "")) linhas.push(linha);
      linha = [];
      continue;
    }
    campo += c;
  }
  linha.push(campo);
  if (linha.some((x) => x !== "")) linhas.push(linha);

  const header = linhas.length ? linhas[0].map((h) => h.trim()) : [];
  return { header, rows: linhas.slice(1) };
}

// Serializa de volta. So coloca aspas quando precisa (separador, aspas ou
// quebra de linha dentro do campo) — e escapa aspas duplicando.
function serializeCsv(header, rows, sep = ";") {
  const esc = (v) => {
    const s = v === null || v === undefined ? "" : String(v);
    return s.includes(sep) || /["\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const linhas = [header.map(esc).join(sep)];
  for (const r of rows) linhas.push(r.map(esc).join(sep));
  return `${linhas.join("\n")}\n`;
}

// Garante o BOM de UTF-8 no inicio do arquivo.
//
// POR QUE ISSO IMPORTA: sem BOM, o Excel (e qualquer leitor que assuma a
// codepage do sistema) le o arquivo como Latin-1 e mostra "NÃ£o" em vez de
// "Não" — o conteudo esta certo, a leitura e que erra. O CSV que o GPM entrega
// vem com BOM; o parser daqui tira o BOM na leitura, entao ele TEM que ser
// recolocado na escrita, senao a base sai com acentuacao quebrada na tela.
const BOM_UTF8 = Buffer.from([0xef, 0xbb, 0xbf]);

function comBom(conteudo) {
  const buf = Buffer.isBuffer(conteudo) ? conteudo : Buffer.from(String(conteudo), "utf8");
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf;
  return Buffer.concat([BOM_UTF8, buf]);
}

// Chave de coluna: nome + ocorrencia, porque um header pode repetir nome
// (ex.: 2023 tem "6.1 - Todas as cavas..." e "6.1 - Todas as cavas...." ).
function chavesDeHeader(header) {
  const vistos = new Map();
  return header.map((nome) => {
    const n = vistos.get(nome) || 0;
    vistos.set(nome, n + 1);
    return n === 0 ? nome : `${nome}#${n + 1}`;
  });
}

// Junta varias partes ({ header, rows }) casando colunas por nome.
// Devolve { header, rows, colunasPorParte } — colunasPorParte ajuda a auditar
// quantas colunas cada parte contribuiu.
function unir(partes) {
  const colunas = [];          // ordem final
  const indice = new Map();    // chave -> posicao

  const registrar = (chave) => {
    if (!indice.has(chave)) {
      indice.set(chave, colunas.length);
      colunas.push(chave);
    }
    return indice.get(chave);
  };

  const mapeadas = [];
  for (const parte of partes) {
    const chaves = chavesDeHeader(parte.header);
    const posicoes = chaves.map(registrar);
    mapeadas.push({ parte, posicoes });
  }

  const rows = [];
  for (const { parte, posicoes } of mapeadas) {
    for (const r of parte.rows) {
      const nova = new Array(colunas.length).fill("");
      for (let i = 0; i < posicoes.length; i++) {
        if (i < r.length) nova[posicoes[i]] = r[i];
      }
      rows.push(nova);
    }
  }

  // Reexpande as linhas curtas caso colunas tenham crescido depois.
  for (const r of rows) while (r.length < colunas.length) r.push("");

  return {
    header: colunas.map((c) => c.replace(/#\d+$/, "")),
    rows,
    colunasPorParte: partes.map((p) => p.header.length),
    totalColunas: colunas.length,
  };
}

// Indice da coluna cod_checklist (fallback: 3, posicao fixa em todas as versoes).
function idxCodChecklist(header) {
  const i = header.findIndex((h) => /^cod_checklist$/i.test(h.trim()));
  return i >= 0 ? i : 3;
}

module.exports = { parseCsv, serializeCsv, unir, chavesDeHeader, idxCodChecklist, comBom };
