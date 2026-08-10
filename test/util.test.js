const test = require("node:test");
const assert = require("node:assert");
const { ontem, intervaloD1, mesAnoD1, fmtBR, contarLinhasDados, validarIntervalo } = require("../src/util");

const TZ = "America/Sao_Paulo";
// Meio-dia UTC de uma data local BA (UTC-3) — evita ambiguidade de fuso.
const em = (iso) => new Date(`${iso}T15:00:00Z`);

test("ontem: dia comum", () => {
  assert.deepStrictEqual(ontem(TZ, em("2026-08-10")), { ano: 2026, mes: 8, dia: 9 });
});

test("ontem: virada de mes (dia 1 cai no mes anterior)", () => {
  assert.deepStrictEqual(ontem(TZ, em("2026-08-01")), { ano: 2026, mes: 7, dia: 31 });
  assert.deepStrictEqual(ontem(TZ, em("2026-03-01")), { ano: 2026, mes: 2, dia: 28 });
  assert.deepStrictEqual(ontem(TZ, em("2024-03-01")), { ano: 2024, mes: 2, dia: 29 }); // bissexto
});

test("ontem: virada de ano", () => {
  assert.deepStrictEqual(ontem(TZ, em("2026-01-01")), { ano: 2025, mes: 12, dia: 31 });
});

test("intervaloD1: mes vigente parcial (exemplo da Skill)", () => {
  const { inicio, fim } = intervaloD1(TZ, em("2026-08-10"));
  assert.strictEqual(fmtBR(inicio), "01/08/2026");
  assert.strictEqual(fmtBR(fim), "09/08/2026");
});

test("intervaloD1: dia 1 fecha o mes anterior completo", () => {
  const { inicio, fim } = intervaloD1(TZ, em("2026-08-01"));
  assert.strictEqual(fmtBR(inicio), "01/07/2026");
  assert.strictEqual(fmtBR(fim), "31/07/2026");
});

test("intervaloD1: inicio nunca depois do fim, e sempre no mesmo mes", () => {
  for (const dia of ["2026-01-01", "2026-02-15", "2026-03-01", "2026-12-31", "2024-02-29"]) {
    const { inicio, fim } = intervaloD1(TZ, em(dia));
    assert.strictEqual(inicio.dia, 1, dia);
    assert.strictEqual(inicio.mes, fim.mes, dia);
    assert.strictEqual(inicio.ano, fim.ano, dia);
    assert.ok(inicio.dia <= fim.dia, dia);
  }
});

test("mesAnoD1: usa o mes de ONTEM, nao o de hoje", () => {
  assert.strictEqual(mesAnoD1(TZ, em("2026-08-10")), "08.2026");
  assert.strictEqual(mesAnoD1(TZ, em("2026-08-01")), "07.2026"); // dia 1
  assert.strictEqual(mesAnoD1(TZ, em("2026-01-01")), "12.2025"); // virada de ano
});

test("contarLinhasDados: ignora cabecalho, BOM e linhas vazias", () => {
  assert.strictEqual(contarLinhasDados("h1;h2\na;b\nc;d\n"), 2);
  assert.strictEqual(contarLinhasDados("﻿h1;h2\na;b\n\n"), 1);
  assert.strictEqual(contarLinhasDados("h1;h2\n"), 0);
});

test("validarIntervalo: datas dentro do mes esperado", () => {
  const csv = 'N;Data Execução;Obra\n1;05/08/2026;X\n2;09/08/2026;Y\n';
  const r = validarIntervalo(Buffer.from(csv, "utf8"), "08.2026");
  assert.strictEqual(r.fora, false);
  assert.strictEqual(r.min, "05/08/2026");
  assert.strictEqual(r.max, "09/08/2026");
  assert.strictEqual(r.total, 2);
});

test("validarIntervalo: acusa data fora do mes (bug de filtro)", () => {
  const csv = 'N;Data Execução;Obra\n1;05/08/2026;X\n2;30/06/2026;Y\n';
  const r = validarIntervalo(Buffer.from(csv, "utf8"), "08.2026");
  assert.strictEqual(r.fora, true);
  assert.strictEqual(r.min, "30/06/2026");
});

test("validarIntervalo: sem a coluna Data Execução nao acusa nada", () => {
  const r = validarIntervalo(Buffer.from("a;b\n1;2\n", "utf8"), "08.2026");
  assert.strictEqual(r.fora, false);
  assert.strictEqual(r.min, null);
  assert.strictEqual(r.total, 1);
});
