const test = require("node:test");
const assert = require("node:assert");
const { parseCsv, serializeCsv, unir, chavesDeHeader, idxCodChecklist } = require("../src/uniao");

test("parseCsv respeita aspas: separador, aspas escapadas e quebra de linha no campo", () => {
  const txt = 'a;b;c\n1;"tem;ponto e virgula";x\n2;"tem ""aspas"" dentro";y\n3;"tem\nquebra";z\n';
  const { header, rows } = parseCsv(txt);
  assert.deepStrictEqual(header, ["a", "b", "c"]);
  assert.strictEqual(rows.length, 3);
  assert.strictEqual(rows[0][1], "tem;ponto e virgula");
  assert.strictEqual(rows[1][1], 'tem "aspas" dentro');
  assert.strictEqual(rows[2][1], "tem\nquebra");
});

test("parseCsv tira BOM e aceita CRLF", () => {
  const { header, rows } = parseCsv("﻿a;b\r\n1;2\r\n");
  assert.deepStrictEqual(header, ["a", "b"]);
  assert.deepStrictEqual(rows, [["1", "2"]]);
});

test("serializeCsv -> parseCsv preserva o conteudo (round-trip)", () => {
  const header = ["a", "b", "c"];
  const rows = [["1", "tem;pv", 'com "aspas"'], ["2", "com\nquebra", ""]];
  const rt = parseCsv(serializeCsv(header, rows));
  assert.deepStrictEqual(rt.header, header);
  assert.deepStrictEqual(rt.rows, rows);
});

test("serializeCsv so coloca aspas quando precisa", () => {
  const txt = serializeCsv(["a", "b"], [["simples", "tem;pv"]]);
  assert.strictEqual(txt, "a;b\nsimples;\"tem;pv\"\n");
});

test("chavesDeHeader desambigua nomes repetidos", () => {
  assert.deepStrictEqual(chavesDeHeader(["x", "y", "x"]), ["x", "y", "x#2"]);
});

test("unir casa colunas por nome e deixa vazio o que nao se aplica", () => {
  // Caso real: cada dia do GPM traz so as perguntas presentes nos registros.
  const dia1 = parseCsv("Contrato;cod_checklist;P1;P2\nA;111;sim;nao\n");
  const dia2 = parseCsv("Contrato;cod_checklist;P2;P3\nB;222;talvez;ok\n");
  const u = unir([dia1, dia2]);
  assert.deepStrictEqual(u.header, ["Contrato", "cod_checklist", "P1", "P2", "P3"]);
  assert.strictEqual(u.totalColunas, 5);
  assert.deepStrictEqual(u.colunasPorParte, [4, 4]);
  // linha do dia1: P3 vazio; linha do dia2: P1 vazio
  assert.deepStrictEqual(u.rows[0], ["A", "111", "sim", "nao", ""]);
  assert.deepStrictEqual(u.rows[1], ["B", "222", "", "talvez", "ok"]);
});

test("unir preserva a ordem das 8 colunas fixas na frente", () => {
  const FIXAS = ["Contrato", "Ordem trabalho", "Ordem trabalho Principal", "cod_checklist",
    "Cliente", "Funcionario", "Data Execução", "formulario"];
  const p1 = parseCsv(`${FIXAS.join(";")};1.1\n${FIXAS.map((_, i) => i).join(";")};a\n`);
  const p2 = parseCsv(`${FIXAS.join(";")};9.9\n${FIXAS.map((_, i) => i).join(";")};b\n`);
  const u = unir([p1, p2]);
  assert.deepStrictEqual(u.header.slice(0, 8), FIXAS);
  assert.deepStrictEqual(u.header.slice(8), ["1.1", "9.9"]);
});

test("unir aguenta parte com linha mais curta que o cabecalho", () => {
  const p = { header: ["a", "b", "c"], rows: [["1", "2"]] };
  const u = unir([p]);
  assert.deepStrictEqual(u.rows[0], ["1", "2", ""]);
});

test("unir com colunas de mesmo nome em partes diferentes nao duplica coluna", () => {
  const p1 = parseCsv("a;b\n1;2\n");
  const p2 = parseCsv("b;a\n3;4\n");
  const u = unir([p1, p2]);
  assert.deepStrictEqual(u.header, ["a", "b"]);
  assert.deepStrictEqual(u.rows, [["1", "2"], ["4", "3"]]);
});

test("idxCodChecklist acha pelo nome e cai pra posicao 3", () => {
  assert.strictEqual(idxCodChecklist(["x", "cod_checklist", "y"]), 1);
  assert.strictEqual(idxCodChecklist(["a", "b", "c", "d", "e"]), 3);
});

test("uniao de 3 schemas diferentes: total de linhas preservado", () => {
  const partes = [
    parseCsv("Contrato;cod_checklist;P1\nA;1;x\nB;2;y\n"),
    parseCsv("Contrato;cod_checklist;P1;P2\nC;3;z;w\n"),
    parseCsv("Contrato;cod_checklist;P3\nD;4;k\n"),
  ];
  const u = unir(partes);
  assert.strictEqual(u.rows.length, 4);
  assert.deepStrictEqual(u.header, ["Contrato", "cod_checklist", "P1", "P2", "P3"]);
  // toda linha tem o mesmo numero de campos que o cabecalho
  for (const r of u.rows) assert.strictEqual(r.length, u.header.length);
});

test("comBom poe o BOM de UTF-8 e nao duplica se ja tiver", () => {
  const { comBom } = require("../src/uniao");
  const semBom = Buffer.from("a;b\nNão;x\n", "utf8");
  const c1 = comBom(semBom);
  assert.deepStrictEqual([...c1.slice(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.strictEqual(c1.length, semBom.length + 3);
  // idempotente
  const c2 = comBom(c1);
  assert.strictEqual(c2.length, c1.length);
  assert.deepStrictEqual([...c2.slice(0, 3)], [0xef, 0xbb, 0xbf]);
});

test("comBom aceita string e preserva a acentuacao em UTF-8", () => {
  const { comBom } = require("../src/uniao");
  const b = comBom("Não;Serviço\n");
  // depois do BOM, "Não" tem que ser c3 a3 (UTF-8 correto, sem duplo-encode)
  assert.deepStrictEqual([...b.slice(3, 7)], [0x4e, 0xc3, 0xa3, 0x6f]);
});

test("parseCsv le de volta arquivo COM BOM sem sujar a primeira coluna", () => {
  const { comBom, serializeCsv } = require("../src/uniao");
  const buf = comBom(serializeCsv(["Contrato", "b"], [["X", "Não"]]));
  const { header, rows } = parseCsv(buf);
  assert.strictEqual(header[0], "Contrato", "BOM nao pode virar parte do nome da coluna");
  assert.strictEqual(rows[0][1], "Não");
});
