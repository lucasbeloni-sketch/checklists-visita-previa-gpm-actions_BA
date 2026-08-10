const test = require("node:test");
const assert = require("node:assert");
const { mesclar, linhasLogicas, chaveDaLinha, contaData, separaHeader } = require("../src/merge");
const { analisar } = require("../src/faltantes");

// Header com as 8 primeiras colunas reais do CSV do GPM (o resto sao perguntas).
const H = "Contrato;Ordem trabalho;Ordem trabalho Principal;cod_checklist;Cliente;Funcionario;Data Execução;formulario";
const linha = (cod, dataBR, extra = "") =>
  `CONTRATO-X;B-${cod}_VIST;B-${cod};${cod};01;"FULANO DE TAL";${dataBR};"UTD - Visita Prévia-BA"${extra}`;

test("linhasLogicas junta linha quebrada dentro de aspas", () => {
  const corpo = `a;b;"obs com\nquebra";c\nd;e;f;g\n`;
  const l = linhasLogicas(corpo);
  assert.strictEqual(l.length, 2);
  assert.ok(l[0].includes("\n"), "primeira linha deve conter a quebra interna");
  assert.strictEqual(l[1], "d;e;f;g");
});

test("linhasLogicas ignora linhas em branco", () => {
  assert.strictEqual(linhasLogicas("a;b\n\n\nc;d\n").length, 2);
});

test("chaveDaLinha extrai cod_checklist e recusa valor que nao e codigo", () => {
  assert.strictEqual(chaveDaLinha(linha("749135454", "31/07/2026")), "749135454");
  assert.strictEqual(chaveDaLinha("a;b;c;nao-e-codigo;e;f;g;h"), null);
  assert.strictEqual(chaveDaLinha("so;tres;campos"), null);
});

test("contaData conta pela coluna Data Execução", () => {
  const l = [linha("1111", "30/06/2026"), linha("2222", "30/06/2026"), linha("3333", "29/06/2026")];
  assert.strictEqual(contaData(l, "30/06/2026"), 2);
  assert.strictEqual(contaData(l, "28/06/2026"), 0);
});

test("mesclar recusa cabecalhos diferentes (schema do questionario mudou)", () => {
  const dest = `${H}\n${linha("1111", "01/07/2023")}\n`;
  const novo = `${H};Nº PROJETO\n${linha("2222", "31/07/2023")};P-1\n`;
  const r = mesclar(dest, novo, { dataBR: "31/07/2023" });
  assert.strictEqual(r.ok, false);
  assert.match(r.motivo, /cabecalhos diferentes \(destino 8 colunas, export novo 9\)/);
});

test("mesclar acrescenta so o dia que faltava", () => {
  const dest = `${H}\n${linha("1111", "29/07/2026")}\n${linha("2222", "30/07/2026")}\n`;
  const novo = `${H}\n${linha("3333", "31/07/2026")}\n${linha("4444", "31/07/2026")}\n`;
  const r = mesclar(dest, novo, { dataBR: "31/07/2026" });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.add, 2);
  assert.strictEqual(r.dup, 0);
  assert.strictEqual(r.totalAntes, 2);
  assert.strictEqual(r.totalDepois, 4);
  assert.strictEqual(r.texto.split("\n")[0], H, "cabecalho preservado");
  assert.strictEqual(contaData(linhasLogicas(separaHeader(r.texto).corpo), "31/07/2026"), 2);
});

test("mesclar deduplica por cod_checklist (export do dia traz linha de outro dia ja presente)", () => {
  // O filtro do GPM e por Data Serviço/Inspeção, entao o export de 31/07 pode
  // trazer uma linha cuja Data Execução e 30/07 — e essa ja esta no destino.
  const dest = `${H}\n${linha("2222", "30/07/2026")}\n`;
  const novo = `${H}\n${linha("2222", "30/07/2026")}\n${linha("3333", "31/07/2026")}\n`;
  const r = mesclar(dest, novo, { dataBR: "31/07/2026" });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.add, 1);
  assert.strictEqual(r.dup, 1);
});

test("mesclar nao mexe se o dia ja existe no destino", () => {
  const dest = `${H}\n${linha("3333", "31/07/2026")}\n`;
  const novo = `${H}\n${linha("4444", "31/07/2026")}\n`;
  const r = mesclar(dest, novo, { dataBR: "31/07/2026" });
  assert.strictEqual(r.ok, false);
  assert.match(r.motivo, /ja tem 1 linha\(s\) com Data Execução 31\/07\/2026/);
});

test("mesclar preserva linhas com quebra interna sem reserializar", () => {
  const comQuebra = `CONTRATO-X;B-9_VIST;B-9;9999;01;"FULANO";30/07/2026;"UTD - Visita Prévia-BA";"obs\ncom quebra"`;
  const dest = `${H}\n${comQuebra}\n`;
  const novo = `${H}\n${linha("8888", "31/07/2026")}\n`;
  const r = mesclar(dest, novo, { dataBR: "31/07/2026" });
  assert.strictEqual(r.ok, true);
  assert.ok(r.texto.includes(comQuebra), "linha original tem que sair byte a byte igual");
  assert.strictEqual(r.totalDepois, 2);
});

test("mesclar recusa export sem linhas de dados", () => {
  const r = mesclar(`${H}\n${linha("1", "01/07/2026")}\n`, `${H}\n`, { dataBR: "31/07/2026" });
  assert.strictEqual(r.ok, false);
  assert.match(r.motivo, /nao tem linhas de dados/);
});

// ---- detector de dias faltantes ----

// Mes com dado todo dia util menos o ultimo dia (o buraco do bug de horario).
function mesSintetico(ano, mes, ultimoDia, { pularUltimo = true } = {}) {
  const p = (n) => String(n).padStart(2, "0");
  const linhas = [];
  for (let d = 1; d <= ultimoDia; d++) {
    if (pularUltimo && d === ultimoDia) continue;
    for (let i = 0; i < 10; i++) linhas.push(linha(`${ano}${p(mes)}${p(d)}${i}`, `${p(d)}/${p(mes)}/${ano}`));
  }
  return `${H}\n${linhas.join("\n")}\n`;
}

test("analisar acha o buraco do ultimo dia num arquivo mensal", () => {
  const r = analisar("07.2026.csv", mesSintetico(2026, 7, 31));
  assert.strictEqual(r.escopo, "mes");
  assert.strictEqual(r.buracos.length, 1);
  assert.strictEqual(r.buracos[0].dataBR, "31/07/2026");
  assert.strictEqual(r.buracos[0].diaSemana, "sex");
  assert.strictEqual(r.buracos[0].mediaDiaDoMes, 10);
});

test("analisar nao acusa nada quando o ultimo dia tem registro", () => {
  const r = analisar("07.2026.csv", mesSintetico(2026, 7, 31, { pularUltimo: false }));
  assert.strictEqual(r.buracos.length, 0);
});

test("analisar ignora o mes em andamento", () => {
  const r = analisar("08.2026.csv", mesSintetico(2026, 8, 31), { mesCorrente: "08.2026" });
  assert.strictEqual(r.buracos.length, 0);
});

test("analisar percorre os 12 meses de um arquivo anual e pula mes sem dado", () => {
  // So julho e agosto tem dado; ambos sem o ultimo dia.
  const jul = mesSintetico(2025, 7, 31).split("\n").slice(1).join("\n");
  const ago = mesSintetico(2025, 8, 31).split("\n").slice(1).join("\n");
  const r = analisar("2025.csv", `${H}\n${jul}${ago}`);
  assert.strictEqual(r.escopo, "ano");
  assert.deepStrictEqual(r.buracos.map((b) => b.dataBR), ["31/07/2025", "31/08/2025"]);
});

test("analisar ignora nome fora do padrao", () => {
  assert.strictEqual(analisar("COMPILADO.csv", `${H}\n`).escopo, "desconhecido");
});

test("analisar classifica evidencia: dia util zerado = alta, fim de semana sem movimento = fraca", () => {
  const p = (n) => String(n).padStart(2, "0");
  // Maio/2026: 31/05 e domingo. Enchemos so os dias de semana; domingos ficam 0.
  const linhas = [];
  for (let d = 1; d <= 30; d++) {
    const wd = new Date(Date.UTC(2026, 4, d)).getUTCDay();
    if (wd === 0) continue;                 // domingo sem execucao
    for (let i = 0; i < 12; i++) linhas.push(linha(`2026${p(5)}${p(d)}${i}`, `${p(d)}/05/2026`));
  }
  const r = analisar("05.2026.csv", `${H}\n${linhas.join("\n")}\n`);
  assert.strictEqual(r.buracos.length, 1);
  assert.strictEqual(r.buracos[0].dataBR, "31/05/2026");
  assert.strictEqual(r.buracos[0].diaSemana, "dom");
  assert.strictEqual(r.buracos[0].forca, "fraca", "domingo sem movimento no mes todo = evidencia fraca");

  // Julho/2026: 31/07 e sexta, e as outras sextas tem movimento -> alta.
  const jul = [];
  for (let d = 1; d <= 30; d++) {
    for (let i = 0; i < 12; i++) jul.push(linha(`2026${p(7)}${p(d)}${i}`, `${p(d)}/07/2026`));
  }
  const r2 = analisar("07.2026.csv", `${H}\n${jul.join("\n")}\n`);
  assert.strictEqual(r2.buracos[0].dataBR, "31/07/2026");
  assert.strictEqual(r2.buracos[0].forca, "alta");
});
