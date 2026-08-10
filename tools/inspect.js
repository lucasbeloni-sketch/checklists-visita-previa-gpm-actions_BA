// Helper de calibracao da tela "Checklists Pergunta/Resposta" (GPM BA).
// Abre o GPM, loga (manual em HEADED, ou automatico com creds), navega ate a
// tela, despeja o HTML em ./debug e LISTA os candidatos de seletor que o robo
// usaria: hrefs do menu, inputs de data, selects (Finalidade / Tipo de
// Checklist) e botoes de export.
//
// Uso local:
//   HEADED=1 npm run inspect                            (abre o browser; faca o login)
//   GPM_BA_USER=... GPM_BA_PASS=... npm run inspect      (tenta logar sozinho)
//
// Depois de rodar, cole no config.json: checklistsUrl e os selectors listados.

const { chromium } = require("playwright");
const cfg = require("../config.json");
const { login, dump, dumpFrame, rootDaTela, abrirChecklists } = require("../src/gpm");

(async () => {
  const headless = process.env.HEADED ? false : !!process.env.CI;
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  page.setDefaultTimeout(60000);

  // Login: automatico se houver creds; senao janela aberta p/ login manual.
  if ((process.env.GPM_BA_USER || process.env.GPM_USER) && (process.env.GPM_BA_PASS || process.env.GPM_PASS)) {
    await login(page, cfg);
  } else {
    await page.goto(cfg.baseUrl, { waitUntil: "domcontentloaded" });
    await dump(page, "inspect-01-login");
    if (!headless) {
      console.log("\n[inspect] FACA O LOGIN na janela. ~90s...");
      await page.waitForTimeout(90000);
    }
  }

  // 1) Menu: lista todo link cujo texto/href cheire a Checklists — e daqui que
  // sai o valor de checklistsUrl.
  const menu = await page.evaluate(() => {
    const norm = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "")
      .toLowerCase().replace(/\s+/g, " ").trim();
    return [...document.querySelectorAll("a")]
      .map((a) => ({ texto: a.textContent.trim().slice(0, 80), href: a.getAttribute("href") || "", onclick: (a.getAttribute("onclick") || "").slice(0, 160) }))
      .filter((x) => /checklist|seguranca|segurança|exporta/i.test(x.texto) || /checklist|exporta/i.test(x.href) || /checklist/i.test(x.onclick))
      .filter((x, i, arr) => arr.findIndex((y) => y.texto === x.texto && y.href === x.href) === i);
  });
  console.log("\n=== [1] LINKS DE MENU candidatos (procure 'Checklists Pergunta/Resposta') ===");
  for (const m of menu) console.log(`  "${m.texto}" | href=${m.href} | onclick=${m.onclick}`);

  // 2) Tenta abrir a tela (por URL do config se houver, senao pelo menu).
  let root;
  try {
    root = await abrirChecklists(page, cfg);
  } catch (e) {
    console.warn(`\n[inspect] nao consegui abrir a tela automaticamente: ${e.message}`);
    if (!headless) {
      console.log("[inspect] ABRA A TELA MANUALMENTE na janela (Seguranca > Checklists > Exportacoes > Checklists Pergunta/Resposta). ~60s...");
      await page.waitForTimeout(60000);
    }
    root = await rootDaTela(page);
  }

  console.log(`\n[inspect] URL da pagina: ${page.url()}`);
  await dump(page, "inspect-02-shell");
  await dumpFrame(root, "inspect-03-tela");

  // 3) Enumera os controles da tela.
  const controles = await root.evaluate(() => {
    const rect = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top) }; };
    const visivel = (el) => !!(el.offsetParent || el.getClientRects().length);
    const labelDe = (el) => {
      const lab = el.id ? document.querySelector(`label[for="${el.id}"]`) : null;
      if (lab) return lab.textContent.trim().slice(0, 60);
      const box = el.closest(".form-group, .col, .col-md-2, .col-md-3, div");
      return (box ? box.textContent.trim().replace(/\s+/g, " ").slice(0, 60) : "");
    };
    const inputs = [...document.querySelectorAll("input")].filter(visivel).map((el) => ({
      tag: "input", type: el.type, id: el.id, name: el.name, cls: el.className,
      placeholder: el.placeholder || "", value: el.value, label: labelDe(el), ...rect(el),
    }));
    const selects = [...document.querySelectorAll("select")].map((el) => ({
      tag: "select", id: el.id, name: el.name, cls: el.className, multiple: el.multiple,
      label: labelDe(el), visivel: visivel(el), nOpcoes: el.options.length,
      primeiras: [...el.options].slice(0, 6).map((o) => o.text.trim()),
      selecionadas: [...el.selectedOptions].map((o) => o.text.trim()), ...rect(el),
    }));
    const botoes = [...document.querySelectorAll("button, a.btn, input[type=submit], input[type=button]")]
      .filter(visivel).map((el) => ({
        tag: el.tagName.toLowerCase(), texto: (el.textContent || el.value || "").trim().slice(0, 40),
        id: el.id, cls: el.className, ...rect(el),
      }));
    return { inputs, selects, botoes };
  });

  console.log("\n=== [2] INPUTS visiveis (os 4 primeiros com cara de data, em ordem visual, sao Data Servico Ini/Fim e Data Inspecao Ini/Fim) ===");
  for (const i of controles.inputs) {
    console.log(`  #${i.id || "-"} name=${i.name || "-"} type=${i.type} cls="${i.cls}" ph="${i.placeholder}" val="${i.value}" (x=${i.x},y=${i.y}) label="${i.label}"`);
  }
  console.log("\n=== [3] SELECTS (ache Finalidade e Tipo de Checklist) ===");
  for (const s of controles.selects) {
    console.log(`  #${s.id || "-"} name=${s.name || "-"} multiple=${s.multiple} visivel=${s.visivel} opcoes=${s.nOpcoes} cls="${s.cls}"`);
    console.log(`      label="${s.label}"`);
    console.log(`      primeiras=${JSON.stringify(s.primeiras)} selecionadas=${JSON.stringify(s.selecionadas)}`);
  }
  console.log("\n=== [4] BOTOES (ache o verde 'Exportar') ===");
  for (const b of controles.botoes) {
    console.log(`  <${b.tag}> "${b.texto}" id=${b.id || "-"} cls="${b.cls}" (x=${b.x},y=${b.y})`);
  }

  console.log(`\n[inspect] pronto. Cole no config.json:
  "checklistsUrl": "${page.url()}",
  e os ids reais em selectors (dataServicoInicio/Fim, dataInspecaoInicio/Fim, finalidade, tipoChecklist, exportar).`);

  if (!headless) await page.waitForTimeout(5000);
  await browser.close();
})();
