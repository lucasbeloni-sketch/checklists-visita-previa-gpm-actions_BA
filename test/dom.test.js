// Testa as heuristicas de DOM (mapear os 4 campos de data, achar e selecionar
// os dropdowns) contra uma pagina SINTETICA que imita a tela do GPM — sem rede,
// sem GPM, sem login. Nao substitui a calibracao real (`npm run inspect`), mas
// pega regressao na logica de heuristica.
//
// Pula sozinho se o Chromium do Playwright nao estiver instalado.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const { chromium } = require("playwright");
const { mapearCamposData, acharSelect, primeiroVisivel } = require("../src/gpm");

const temChromium = (() => {
  try { return fs.existsSync(chromium.executablePath()); } catch (_) { return false; }
})();

// Tela imitando o GPM: 4 inputs de data mascarados em uma linha, 2 selects
// (Finalidade / Tipo de Checklist) e o botao verde Exportar. Ordem do DOM
// embaralhada de proposito, pra provar que o mapeamento usa a ordem VISUAL.
const HTML = `
<html><body>
<h4>Checklists Pergunta/Resposta</h4>
<div style="display:flex; gap:10px">
  <div class="form-group" style="order:3"><label for="dt_inspecao_ini">Data Inspeção Início</label>
    <input type="text" class="data" id="dt_inspecao_ini" name="dt_inspecao_ini" placeholder="dd/mm/aaaa"></div>
  <div class="form-group" style="order:1"><label for="dt_servico_ini">Data Serviço Início</label>
    <input type="text" class="data" id="dt_servico_ini" name="dt_servico_ini" placeholder="dd/mm/aaaa"></div>
  <div class="form-group" style="order:4"><label for="dt_inspecao_fim">Data Inspeção Fim</label>
    <input type="text" class="data" id="dt_inspecao_fim" name="dt_inspecao_fim" placeholder="dd/mm/aaaa"></div>
  <div class="form-group" style="order:2"><label for="dt_servico_fim">Data Serviço Fim</label>
    <input type="text" class="data" id="dt_servico_fim" name="dt_servico_fim" placeholder="dd/mm/aaaa"></div>
</div>
<div class="form-group"><label for="idFinalidade">Finalidade</label>
  <select id="idFinalidade"><option value="">Selecione</option>
    <option value="9">09 - Outra Coisa</option>
    <option value="10">10 - Vistoria de Obras Elétricas</option></select></div>
<div class="form-group"><label for="checklist_tipo">Tipo de Checklist</label>
  <select id="checklist_tipo"><option value="">Selecione</option>
    <option value="7">UTD - Visita Prévia-BA</option>
    <option value="8">UTD - Outro-BA</option></select></div>
<input type="text" id="observacao" name="observacao" placeholder="texto qualquer">
<button class="btn btn-success" id="btnExportar">Exportar</button>
</body></html>`;

async function abrirPagina() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1568, height: 698 } });
  await page.setContent(HTML);
  return { browser, page };
}

const CFG = {
  selectors: {
    dataServicoInicio: null, dataServicoFim: null,
    dataInspecaoInicio: null, dataInspecaoFim: null,
    finalidade: null, tipoChecklist: null, exportar: null,
  },
  finalidade: "10 - Vistoria de Obras Elétricas",
  tipoChecklist: "UTD - Visita Prévia-BA",
};

test("mapearCamposData acha os 4 campos na ordem visual (nao a do DOM)", { skip: !temChromium }, async () => {
  const { browser, page } = await abrirPagina();
  try {
    const sels = await mapearCamposData(page, CFG);
    assert.deepStrictEqual(sels, ["#dt_servico_ini", "#dt_servico_fim", "#dt_inspecao_ini", "#dt_inspecao_fim"]);
  } finally { await browser.close(); }
});

test("mapearCamposData respeita overrides do config", { skip: !temChromium }, async () => {
  const { browser, page } = await abrirPagina();
  try {
    const cfg = { selectors: { ...CFG.selectors, dataServicoInicio: "#a", dataServicoFim: "#b", dataInspecaoInicio: "#c", dataInspecaoFim: "#d" } };
    assert.deepStrictEqual(await mapearCamposData(page, cfg), ["#a", "#b", "#c", "#d"]);
  } finally { await browser.close(); }
});

test("acharSelect acha Finalidade e Tipo de Checklist por id/label", { skip: !temChromium }, async () => {
  const { browser, page } = await abrirPagina();
  try {
    assert.strictEqual(await acharSelect(page, CFG, "finalidade"), "#idFinalidade");
    assert.strictEqual(await acharSelect(page, CFG, "tipoChecklist"), "#checklist_tipo");
  } finally { await browser.close(); }
});

test("selecionarOpcao casa a opcao mesmo sem acento e confirma no select nativo", { skip: !temChromium }, async () => {
  const { browser, page } = await abrirPagina();
  try {
    const { selecionarOpcao } = require("../src/gpm");
    // Valor sem acento de proposito: a comparacao e normalizada.
    const f = await selecionarOpcao(page, CFG, "finalidade", "10 - Vistoria de Obras Eletricas");
    assert.strictEqual(f, "10 - Vistoria de Obras Elétricas");
    assert.strictEqual(await page.locator("#idFinalidade").inputValue(), "10");

    const t = await selecionarOpcao(page, CFG, "tipoChecklist", "UTD - Visita Previa-BA");
    assert.strictEqual(t, "UTD - Visita Prévia-BA");
    assert.strictEqual(await page.locator("#checklist_tipo").inputValue(), "7");
  } finally { await browser.close(); }
});

test("selecionarOpcao falha claro quando a opcao nao existe", { skip: !temChromium }, async () => {
  const { browser, page } = await abrirPagina();
  try {
    const { selecionarOpcao } = require("../src/gpm");
    await assert.rejects(
      () => selecionarOpcao(page, CFG, "finalidade", "99 - Nao Existe"),
      /opcao nao existe no dropdown/
    );
  } finally { await browser.close(); }
});

test("setData preenche e confirma o valor lido", { skip: !temChromium }, async () => {
  const { browser, page } = await abrirPagina();
  try {
    const { baixarChecklists } = require("../src/gpm"); // garante que o modulo carrega
    assert.strictEqual(typeof baixarChecklists, "function");
    const sels = await mapearCamposData(page, CFG);
    const { setData, conferirDatas } = require("../src/gpm");
    await setData(page, sels[3], "31/07/2026", "Data Inspecao Fim");
    await conferirDatas(page, [sels[3]], ["31/07/2026"]);
    assert.strictEqual(await page.locator(sels[3]).inputValue(), "31/07/2026");
  } finally { await browser.close(); }
});

test("botao Exportar e encontrado por texto", { skip: !temChromium }, async () => {
  const { browser, page } = await abrirPagina();
  try {
    const botao = await primeiroVisivel(page, [
      null,
      (r) => r.getByRole("button", { name: /^\s*Exportar\s*$/i }),
      "button:has-text('Exportar')",
    ], { timeout: 5000 });
    assert.strictEqual(await botao.getAttribute("id"), "btnExportar");
  } finally { await browser.close(); }
});
