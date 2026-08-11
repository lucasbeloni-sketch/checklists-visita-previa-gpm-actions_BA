const test = require("node:test");
const assert = require("node:assert");
const { reprojetar, validar, juntarNoLayout, preenchidasPorNome, anoDaLinha } = require("../src/padronizar");
const { parseCsv, serializeCsv } = require("../src/uniao");
const layoutReal = require("../layout.json");

const LAYOUT = ["Contrato", "cod_checklist", "Data Execução", "P1", "P2", "P3"];

test("layout.json tem 90 colunas, 78 canonicas + 12 aposentadas, sem repetidas", () => {
  assert.strictEqual(layoutReal.colunas.length, 90);
  assert.strictEqual(layoutReal.canonicas, 78);
  assert.strictEqual(layoutReal.aposentadas, 12);
  assert.strictEqual(new Set(layoutReal.colunas).size, 90, "nao pode ter nome repetido");
  // As 8 primeiras sao as fixas do relatorio.
  assert.deepStrictEqual(layoutReal.colunas.slice(0, 8), [
    "Contrato", "Ordem trabalho", "Ordem trabalho Principal", "cod_checklist",
    "Cliente", "Funcionario", "Data Execução", "formulario",
  ]);
});

test("reprojetar poe cada valor na coluna do layout e deixa vazio o que falta", () => {
  const origem = parseCsv("Contrato;cod_checklist;Data Execução;P3\nA;111;01/06/2024;xis\n");
  const r = reprojetar(LAYOUT, origem);
  assert.deepStrictEqual(r.header, LAYOUT);
  assert.deepStrictEqual(r.rows[0], ["A", "111", "01/06/2024", "", "", "xis"]);
  assert.deepStrictEqual(r.anexadas, []);
});

test("reprojetar ANEXA coluna desconhecida com dado (pergunta nova do GPM)", () => {
  const origem = parseCsv("Contrato;cod_checklist;Data Execução;P9\nA;111;01/06/2024;novo\n");
  const r = reprojetar(LAYOUT, origem);
  assert.deepStrictEqual(r.anexadas, ["P9"]);
  assert.strictEqual(r.header.length, LAYOUT.length + 1);
  assert.strictEqual(r.rows[0][r.header.length - 1], "novo");
});

test("reprojetar ignora coluna desconhecida totalmente vazia", () => {
  const origem = parseCsv("Contrato;cod_checklist;Data Execução;LIXO\nA;111;01/06/2024;\n");
  const r = reprojetar(LAYOUT, origem);
  assert.deepStrictEqual(r.anexadas, []);
  assert.deepStrictEqual(r.header, LAYOUT);
});

test("validar aprova reprojecao correta", () => {
  const origem = parseCsv("Contrato;cod_checklist;Data Execução;P2\nA;111;01/06/2024;sim\nB;222;02/06/2024;\n");
  const destino = reprojetar(LAYOUT, origem);
  const v = validar(origem, destino);
  assert.strictEqual(v.ok, true, JSON.stringify(v.problemas));
});

test("validar acusa perda de celula preenchida", () => {
  const origem = parseCsv("Contrato;cod_checklist;Data Execução;P2\nA;111;01/06/2024;sim\n");
  const destino = reprojetar(LAYOUT, origem);
  destino.rows[0][4] = "";                      // apaga a resposta de P2 de proposito
  const v = validar(origem, destino);
  assert.strictEqual(v.ok, false);
  assert.match(v.problemas.join(" | "), /"P2": 1 celula\(s\) preenchida\(s\) na origem, 0 no destino/);
});

test("validar acusa contagem de linhas diferente", () => {
  const origem = parseCsv("Contrato;cod_checklist;Data Execução\nA;111;01/06/2024\nB;222;02/06/2024\n");
  const destino = reprojetar(LAYOUT, origem);
  destino.rows.pop();
  assert.strictEqual(validar(origem, destino).ok, false);
});

test("validar acusa largura irregular", () => {
  const origem = parseCsv("Contrato;cod_checklist;Data Execução\nA;111;01/06/2024\n");
  const destino = reprojetar(LAYOUT, origem);
  destino.rows[0].push("sobrando");
  assert.strictEqual(validar(origem, destino).ok, false);
});

test("reprojetar preserva valores com ; aspas e quebra de linha (round-trip)", () => {
  const origem = parseCsv('Contrato;cod_checklist;Data Execução;P1\nA;111;01/06/2024;"tem;pv e\nquebra"\n');
  const d = reprojetar(LAYOUT, origem);
  assert.strictEqual(validar(origem, d).ok, true);
  const rt = parseCsv(serializeCsv(d.header, d.rows));
  assert.strictEqual(rt.rows[0][3], "tem;pv e\nquebra");
});

test("juntarNoLayout dissolve partes e deduplica por cod_checklist", () => {
  const L = ["Contrato", "x", "y", "cod_checklist", "Data Execução"];
  const p1 = { header: L, rows: [["A", "", "", "111", "01/06/2024"]] };
  const p2 = { header: L, rows: [["A", "", "", "111", "01/06/2024"], ["B", "", "", "222", "30/06/2024"]] };
  const j = juntarNoLayout(L, [p1, p2]);
  assert.strictEqual(j.rows.length, 2);
  assert.strictEqual(j.dup, 1);
});

test("preenchidasPorNome conta por nome, nao por posicao", () => {
  const c = preenchidasPorNome(["a", "b"], [["1", ""], ["2", "3"]]);
  assert.strictEqual(c.get("a"), 2);
  assert.strictEqual(c.get("b"), 1);
});

test("anoDaLinha le o ano da coluna Data Execução do layout real", () => {
  const linha = new Array(layoutReal.colunas.length).fill("");
  linha[6] = "31/12/2025 00:00";
  assert.strictEqual(anoDaLinha(layoutReal.colunas, linha), "2025");
});
