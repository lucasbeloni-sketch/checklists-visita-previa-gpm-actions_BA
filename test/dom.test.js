// Testa a interacao com os widgets da tela contra uma pagina SINTETICA que
// imita o DOM REAL capturado em 2026-08-10 (`npm run inspect`):
//   - 4 campos de data = flatpickr com altInput: input HIDDEN com id (formato
//     Y-m-d H:i, e o que o form submete) + altInput visivel (d/m/Y H:i)
//   - Finalidade (#finalidade) e Tipo de Checklist (#tipos) = <select> escondido
//     atras de widget Choices.js, com busca fuzzy e listbox
//   - #tipos so ganha opcoes DEPOIS de escolher a Finalidade (AJAX)
//   - botao Exportar = button.btn-success sem id
//
// Os stubs abaixo replicam so o contrato que o robo usa (setDate/altInput,
// is-open/cloned input/listbox). Nao substitui um run real no GPM, mas pega
// regressao na logica sem depender de login.
//
// Pula sozinho se o Chromium do Playwright nao estiver instalado.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const { chromium } = require("playwright");
const {
  camposData, fmtISO, setDataFp, lerSelect, selecionarChoices,
  esperarTiposCarregar, conferirDatas, primeiroVisivel,
} = require("../src/gpm");

const temChromium = (() => {
  try { return fs.existsSync(chromium.executablePath()); } catch (_) { return false; }
})();

const CFG = require("../config.json");

// Fixture: imita a tela. `flatpickrQuebrado` simula o campo sem instancia
// flatpickr (pra provar que o robo falha em vez de exportar periodo errado).
const html = ({ flatpickrQuebrado = false } = {}) => `
<html><body>
<h4>Checklists Pergunta/Resposta</h4>
<div id="datas"></div>

<div class="choices" data-type="select-one">
  <div class="choices__inner"><select id="finalidade" name="finalidade" class="choices__input" hidden>
    <option value="">Selecione a Finalidade</option></select>
    <div class="choices__list choices__list--single"><div class="choices__item">Selecione a Finalidade</div></div></div>
  <div class="choices__list" role="listbox"></div>
  <input type="text" class="choices__input choices__input--cloned">
</div>

<div class="choices" data-type="select-one">
  <div class="choices__inner"><select id="tipos" name="tipos" class="choices__input" hidden>
    <option value="">Selecione o Tipo de Checklist</option></select>
    <div class="choices__list choices__list--single"><div class="choices__item">Selecione o Tipo de Checklist</div></div></div>
  <div class="choices__list" role="listbox"></div>
  <input type="text" class="choices__input choices__input--cloned">
</div>

<button class="btn btn-success btns-gpm-disable-click">Exportar</button>

<script>
const p = (n) => String(n).padStart(2, "0");
const ISO = (d) => d.getFullYear() + "-" + p(d.getMonth()+1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
const BR  = (d) => p(d.getDate()) + "/" + p(d.getMonth()+1) + "/" + d.getFullYear() + " " + p(d.getHours()) + ":" + p(d.getMinutes());

// --- 4 campos de data (flatpickr + altInput) ---
const CAMPOS = [
  ["data_inicial", "Data Serviço Início"], ["data_final", "Data Serviço Final"],
  ["data_insp_in", "Data Inspeção Início"], ["data_insp_out", "Data Inspeção Final"],
];
for (const [id, ph] of CAMPOS) {
  const orig = document.createElement("input");
  orig.type = "hidden"; orig.id = id; orig.name = id; orig.placeholder = ph;
  orig.className = "form-control data data-hora datetimepicker flatpickr-input";
  const alt = document.createElement("input");
  alt.type = "text"; alt.placeholder = ph;
  alt.className = "form-control data data-hora datetimepicker flatpickr-input form-control input";
  document.getElementById("datas").append(orig, alt);
  if (!${flatpickrQuebrado}) {
    orig._flatpickr = {
      altInput: alt,
      setDate(d) { orig.value = ISO(d); alt.value = BR(d); },
    };
    // allowInput: digitar no altInput reflete no hidden (parse d/m/Y H:i).
    alt.addEventListener("change", () => {
      const m = alt.value.match(/^(\\d{2})\\/(\\d{2})\\/(\\d{4}) (\\d{2}):(\\d{2})$/);
      if (m) orig.value = m[3] + "-" + m[2] + "-" + m[1] + " " + m[4] + ":" + m[5];
    });
  }
}

// --- Choices.js stub ---
const OPCOES_FINALIDADE = [
  ["1", "1 - Veicular - turno"], ["2", "2 - Veicular - Fim de turno"],
  ["10", "10 - Vistoria de Obras Elétricas"],
];
const OPCOES_TIPOS = [
  ["7", "UTD - Visita Prévia-BA"], ["8", "UTD - Pós Obra-BA"],
];
function montaChoices(select, opcoes) {
  const wrap = select.closest("div.choices");
  const listbox = wrap.querySelector('.choices__list[role="listbox"]');
  listbox.innerHTML = "";
  for (const [value, texto] of opcoes) {
    const item = document.createElement("div");
    item.className = "choices__item choices__item--choice";
    item.dataset.value = value; item.textContent = texto;
    item.addEventListener("click", () => escolher(select, value, texto));
    listbox.appendChild(item);
  }
}
function escolher(select, value, texto) {
  if (![...select.options].some((o) => o.value === value)) {
    select.add(new Option(texto, value));
  }
  select.value = value;
  select.dispatchEvent(new Event("change", { bubbles: true }));
  const wrap = select.closest("div.choices");
  wrap.querySelector(".choices__list--single").textContent = texto;
  wrap.classList.remove("is-open");
  // Escolher a Finalidade carrega os Tipos (AJAX simulado, 300ms).
  if (select.id === "finalidade") {
    setTimeout(() => montaChoices(document.getElementById("tipos"), OPCOES_TIPOS), 300);
  }
}
for (const select of document.querySelectorAll("select.choices__input")) {
  const wrap = select.closest("div.choices");
  wrap.querySelector(".choices__inner").addEventListener("click", () => wrap.classList.add("is-open"));
  const busca = wrap.querySelector("input.choices__input--cloned");
  // Filtro fuzzy: só sobrevive item que contenha o texto digitado.
  busca.addEventListener("input", () => {
    const q = busca.value.trim().toLowerCase();
    for (const item of wrap.querySelectorAll(".choices__item--choice")) {
      item.hidden = q && !item.textContent.toLowerCase().includes(q);
    }
  });
  busca.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const item = [...wrap.querySelectorAll(".choices__item--choice")].find((i) => !i.hidden);
    if (item) escolher(select, item.dataset.value, item.textContent);
  });
}
montaChoices(document.getElementById("finalidade"), OPCOES_FINALIDADE);
</script>
</body></html>`;

async function abrir(opts) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1568, height: 698 } });
  await page.setContent(html(opts));
  return { browser, page };
}

// Esperas curtas para os casos que DEVEM falhar (o default folgado vale no GPM real).
const RAPIDO = { widget: 1500, item: 1500 };

const D1 = { ano: 2026, mes: 8, dia: 1 };   // inicio
const D31 = { ano: 2026, mes: 7, dia: 31 }; // fim (exemplo do dia 1: fecha julho)

test("camposData usa os ids calibrados e marca quais sao campos de fim", () => {
  const c = camposData(CFG);
  assert.deepStrictEqual(c.map((x) => x.sel), ["#data_inicial", "#data_final", "#data_insp_in", "#data_insp_out"]);
  assert.deepStrictEqual(c.map((x) => x.fim), [false, true, false, true]);
});

test("fmtISO formata no padrao do input hidden (Y-m-d H:i)", () => {
  assert.strictEqual(fmtISO({ ano: 2026, mes: 7, dia: 31 }, "23:59"), "2026-07-31 23:59");
  assert.strictEqual(fmtISO({ ano: 2026, mes: 7, dia: 1 }, "00:00"), "2026-07-01 00:00");
});

test("setDataFp escreve no hidden via API e reflete no altInput visivel", { skip: !temChromium }, async () => {
  const { browser, page } = await abrir();
  try {
    const campos = camposData(CFG);
    await setDataFp(page, campos[0], { ano: 2026, mes: 7, dia: 1 }, "00:00");
    assert.strictEqual(await page.locator("#data_inicial").inputValue(), "2026-07-01 00:00");
    assert.strictEqual(await page.locator("#data_inicial + input").inputValue(), "01/07/2026 00:00");
  } finally { await browser.close(); }
});

test("campos de fim ficam 23:59 (nao 00:00, que cortaria o ultimo dia)", { skip: !temChromium }, async () => {
  const { browser, page } = await abrir();
  try {
    const campos = camposData(CFG);
    await setDataFp(page, campos[1], D31, CFG.horaFim);
    await setDataFp(page, campos[3], D31, CFG.horaFim);
    assert.strictEqual(await page.locator("#data_final").inputValue(), "2026-07-31 23:59");
    assert.strictEqual(await page.locator("#data_insp_out").inputValue(), "2026-07-31 23:59");
  } finally { await browser.close(); }
});

test("setDataFp usa o altInput quando a API do flatpickr nao existe", { skip: !temChromium }, async () => {
  const { browser, page } = await abrir({ flatpickrQuebrado: true });
  try {
    // Sem instancia flatpickr o caminho da API falha; o fallback digita no
    // altInput. Como o stub quebrado nao tem o listener de parse, o robo tem
    // que ACUSAR erro em vez de seguir com o campo errado.
    await assert.rejects(
      () => setDataFp(page, camposData(CFG)[0], D1, "00:00", 1, 1500),
      /sem instancia flatpickr|esperava "2026-08-01 00:00"/
    );
  } finally { await browser.close(); }
});

test("conferirDatas passa com os 4 valores certos e acusa divergencia", { skip: !temChromium }, async () => {
  const { browser, page } = await abrir();
  try {
    const campos = camposData(CFG);
    const partes = [D1, D31, D1, D31];
    const horas = campos.map((c) => (c.fim ? CFG.horaFim : CFG.horaInicio));
    for (let i = 0; i < 4; i++) await setDataFp(page, campos[i], partes[i], horas[i]);

    const esperados = campos.map((c, i) => fmtISO(partes[i], horas[i]));
    await conferirDatas(page, campos, esperados); // nao lanca

    // Simula o campo "voltando" pro valor da rodada anterior (bug historico).
    await page.evaluate(() => { document.querySelector("#data_insp_out").value = "2026-06-30 23:59"; });
    await assert.rejects(
      () => conferirDatas(page, campos, esperados),
      /Data Inspecao Final: esperava "2026-07-31 23:59", li "2026-06-30 23:59"/
    );
  } finally { await browser.close(); }
});

test("selecionarChoices escolhe Finalidade pelo token e confirma no select nativo", { skip: !temChromium }, async () => {
  const { browser, page } = await abrir();
  try {
    const r = await selecionarChoices(page, CFG, "finalidade", CFG.finalidade, CFG.finalidadeSearch);
    assert.strictEqual(r.text, "10 - Vistoria de Obras Elétricas");
    assert.strictEqual(r.value, "10");
    assert.deepStrictEqual(await lerSelect(page, "#finalidade"), { value: "10", text: "10 - Vistoria de Obras Elétricas" });
  } finally { await browser.close(); }
});

test("Tipo de Checklist so e selecionavel depois da Finalidade (AJAX)", { skip: !temChromium }, async () => {
  const { browser, page } = await abrir();
  try {
    // Antes da Finalidade o widget de tipos esta vazio -> tem que falhar claro.
    await assert.rejects(
      () => selecionarChoices(page, CFG, "tipoChecklist", CFG.tipoChecklist, CFG.tipoChecklistSearch, RAPIDO),
      /nao selecionou "UTD - Visita Prévia-BA"/
    );

    await selecionarChoices(page, CFG, "finalidade", CFG.finalidade, CFG.finalidadeSearch);
    await esperarTiposCarregar(page, CFG);
    const t = await selecionarChoices(page, CFG, "tipoChecklist", CFG.tipoChecklist, CFG.tipoChecklistSearch);
    assert.strictEqual(t.text, "UTD - Visita Prévia-BA");
    assert.strictEqual(t.value, "7");
  } finally { await browser.close(); }
});

test("token de busca inteiro seria descartado pelo filtro fuzzy — o curto acha", { skip: !temChromium }, async () => {
  const { browser, page } = await abrir();
  try {
    // Prova a razao do config ter finalidadeSearch: buscar a string completa
    // com o "10 - " na frente nao casa o item se o GPM renderizar diferente.
    await assert.rejects(
      () => selecionarChoices(page, CFG, "finalidade", CFG.finalidade, "10 - Vistoria de Obras Eletricas", RAPIDO),
      /nao selecionou/
    );
    const r = await selecionarChoices(page, CFG, "finalidade", CFG.finalidade, CFG.finalidadeSearch);
    assert.strictEqual(r.value, "10");
  } finally { await browser.close(); }
});

test("botao Exportar e achado pelo seletor calibrado (btn-success + texto)", { skip: !temChromium }, async () => {
  const { browser, page } = await abrir();
  try {
    const botao = await primeiroVisivel(page, [CFG.selectors.exportar], { timeout: 5000 });
    assert.strictEqual((await botao.textContent()).trim(), "Exportar");
  } finally { await browser.close(); }
});
