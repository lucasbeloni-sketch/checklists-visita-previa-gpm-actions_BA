// Automacao do GPM BA via Playwright (headless).
// Replica os passos da Skill "baixar-checklists-visita-previa-gpm":
//   login -> Seguranca > Checklists > Exportacoes > Checklists Pergunta/Resposta
//   -> 4 datas (Data Servico Inicio/Fim + Data Inspecao Inicio/Fim), TODAS com o
//      mesmo par ancorado em ontem: inicio = dia 1 do mes de ontem, fim = ontem
//   -> Finalidade = "10 - Vistoria de Obras Eletricas"
//   -> Tipo de Checklist = "UTD - Visita Previa-BA"
//   -> botao verde "Exportar" baixa o .zip -> devolve os bytes do CSV.
//
// Sobre o "BUG CONHECIDO" da Skill (Data Inspecao Fim nao atualizava): era
// artefato do preenchimento por clique/coordenada do computer-use. Aqui cada
// campo e preenchido e RELIDO (inputValue) com retry, e no fim relemos os 4
// campos juntos antes de clicar Exportar — se algum nao bateu, o robo falha em
// vez de exportar o periodo errado.
//
// O GPM e uma SPA tema Falcon: as telas costumam carregar DENTRO de um iframe
// (#frameTelasGPM). Login opera em `page`; o formulario opera no `root` (Frame
// do iframe se existir, senao a propria Page). Downloads disparam no nivel de
// `page`/contexto.

const fs = require("fs");
const path = require("path");
const AdmZip = require("adm-zip");
const crypto = require("crypto");
const { intervaloD1, fmtBR, contarLinhasDados } = require("./util");

const DEBUG_DIR = path.join(process.cwd(), "debug");
const FRAME_SEL = "#frameTelasGPM";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Normaliza texto p/ comparacao tolerante: sem acento, minusculo, espacos
// colapsados. Necessario porque o texto exato do GPM ("Visita Prévia-BA") pode
// variar em acentuacao/espacos entre telas.
function norm(s) {
  return String(s ?? "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/\s+/g, " ").trim();
}

// Acha um locator visivel por uma lista de candidatos (string CSS/seletor ou
// funcao (root)=>Locator). `root` pode ser Page ou Frame.
async function primeiroVisivel(root, candidatos, { timeout = 8000 } = {}) {
  const deadline = Date.now() + timeout;
  let ultimoErro;
  while (Date.now() < deadline) {
    for (const c of candidatos) {
      if (!c) continue;
      try {
        const loc = typeof c === "function" ? c(root) : root.locator(c);
        const first = loc.first();
        if (await first.isVisible().catch(() => false)) return first;
      } catch (e) {
        ultimoErro = e;
      }
    }
    await sleep(250);
  }
  throw new Error("Nenhum candidato visivel encontrado." + (ultimoErro ? ` Ultimo erro: ${ultimoErro.message}` : ""));
}

async function dump(page, tag) {
  try {
    fs.mkdirSync(DEBUG_DIR, { recursive: true });
    await page.screenshot({ path: path.join(DEBUG_DIR, `${tag}.png`), fullPage: true }).catch(() => {});
    const html = await page.content().catch(() => "");
    fs.writeFileSync(path.join(DEBUG_DIR, `${tag}.html`), html);
    console.warn(`[debug] artefatos salvos: debug/${tag}.png e debug/${tag}.html`);
  } catch (_) {}
}

async function dumpFrame(frame, tag) {
  try {
    fs.mkdirSync(DEBUG_DIR, { recursive: true });
    fs.writeFileSync(path.join(DEBUG_DIR, `${tag}.html`), await frame.content());
    console.warn(`[debug] HTML do iframe salvo: debug/${tag}.html`);
  } catch (_) {}
}

// Page subjacente de um root (Frame tem .page(); Page e ela mesma).
function paginaDe(root) {
  return typeof root.page === "function" ? root.page() : root;
}

// Sessao ativa = campo de senha do login NAO esta mais visivel.
async function estaLogado(page) {
  const senhaVisivel = await page.locator("#idSenha, input[type=password]").first()
    .isVisible().catch(() => false);
  return !senhaVisivel;
}

// Credenciais: preferimos as da unidade BA; caimos pras genericas (mesmas do CE)
// se as BA nao estiverem setadas — o usuario ainda nao confirmou se o login e o
// mesmo nas duas unidades.
function credenciais() {
  const user = process.env.GPM_BA_USER || process.env.GPM_USER;
  const pass = process.env.GPM_BA_PASS || process.env.GPM_PASS;
  const origem = process.env.GPM_BA_USER ? "GPM_BA_USER/GPM_BA_PASS" : "GPM_USER/GPM_PASS (fallback)";
  return { user, pass, origem };
}

async function login(page, cfg) {
  const { baseUrl, selectors: s } = cfg;
  const { user, pass, origem } = credenciais();

  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await sleep(1500);

  if (await estaLogado(page)) {
    console.log("[login] sessao ja ativa.");
    return;
  }
  if (!user || !pass) {
    // Sem creds: em modo visivel (HEADED), espera login manual (debug local).
    // Em headless/CI, falha — la o login tem que ser automatico.
    if (process.env.HEADED) {
      console.log("[login] sem credenciais — FACA O LOGIN MANUAL na janela (ate 120s)...");
      try {
        await page.waitForFunction(
          () => !document.querySelector("#idSenha, input[type=password]") ||
                !document.querySelector("#idSenha, input[type=password]").offsetParent,
          { timeout: 120000 }
        );
      } catch (_) {}
      if (await estaLogado(page)) {
        console.log("[login] login manual detectado.");
        return;
      }
    }
    await dump(page, "login-sem-credenciais");
    throw new Error("Tela de login detectada mas faltam GPM_BA_USER/GPM_BA_PASS (ou GPM_USER/GPM_PASS) no ambiente.");
  }
  console.log(`[login] usando ${origem} em ${baseUrl}`);

  try {
    const campoUser = await primeiroVisivel(page, [
      s.loginUser, "#idLogin", 'input[name="login"]', 'input[type="text"]',
    ]);
    await campoUser.fill(user);

    const campoPass = await primeiroVisivel(page, [
      s.loginPass, "#idSenha", 'input[name="password"]', 'input[type="password"]',
    ]);
    await campoPass.fill(pass);

    const botao = await primeiroVisivel(page, [
      s.loginSubmit, "button:has-text('Entrar')",
      (p) => p.getByRole("button", { name: /entrar|acessar|login/i }),
    ]);
    await Promise.all([
      page.waitForLoadState("networkidle").catch(() => {}),
      botao.click(),
    ]);
    await sleep(2000);
  } catch (e) {
    await dump(page, "login-falha");
    throw new Error(`Falha ao preencher/enviar o login: ${e.message}`);
  }

  if (!(await estaLogado(page))) {
    await dump(page, "login-pos-submit");
    throw new Error("Login enviado mas a area interna nao apareceu (credenciais invalidas, captcha ou seletor errado?).");
  }
  console.log("[login] autenticado com sucesso.");
}

// Devolve o root onde a tela vive: Frame do iframe (#frameTelasGPM) se houver,
// ou a propria Page. Ambos suportam locator/evaluate/getByRole/waitForFunction.
async function rootDaTela(page, { timeout = 8000 } = {}) {
  const iframeEl = await page.waitForSelector(FRAME_SEL, { timeout }).catch(() => null);
  if (iframeEl) {
    const frame = await iframeEl.contentFrame();
    if (frame) {
      await frame.waitForLoadState("domcontentloaded").catch(() => {});
      console.log("[gpm] tela DENTRO do iframe #frameTelasGPM.");
      return frame;
    }
  }
  console.log("[gpm] sem iframe — operando na propria pagina.");
  return page;
}

// Marcadores de que a tela certa (Checklists Pergunta/Resposta) esta carregada.
function marcadoresDaTela(cfg) {
  return [
    cfg.selectors.exportar,
    "text=/Checklists\\s+Pergunta\\s*\\/?\\s*Resposta/i",
    "text=/Tipo\\s+de\\s+Checklist/i",
    "text=/Data\\s+Inspe[cç][aã]o/i",
  ];
}

// Abre a tela de exportacao. Dois caminhos:
//  1) cfg.checklistsUrl setado (rota calibrada) -> goto direto.
//  2) null -> navega o menu lateral clicando por texto:
//     Seguranca > Checklists > Exportacoes > Checklists Pergunta/Resposta.
// O menu do GPM e accordion: clicar no pai expande, o filho aparece depois.
async function abrirChecklists(page, cfg) {
  if (cfg.checklistsUrl) {
    await page.goto(cfg.checklistsUrl, { waitUntil: "domcontentloaded" });
    const root = await rootDaTela(page);
    await primeiroVisivel(root, marcadoresDaTela(cfg), { timeout: 20000 });
    console.log(`[gpm] tela aberta direto por URL (${cfg.checklistsUrl}).`);
    return root;
  }

  console.log("[gpm] checklistsUrl=null — navegando pelo menu lateral.");
  await page.goto(cfg.baseUrl, { waitUntil: "domcontentloaded" });
  await sleep(1500);

  // Clica um item de menu por texto (no shell, fora do iframe). Tolerante a
  // acento: tentamos regex com e sem acentuacao.
  const clicarMenu = async (regex, label) => {
    const alvo = await primeiroVisivel(page, [
      (p) => p.getByRole("link", { name: regex }),
      (p) => p.locator("a, span.nav-link-text, li").filter({ hasText: regex }),
    ], { timeout: 15000 }).catch(() => null);
    if (!alvo) {
      await dump(page, `menu-sem-${label}`);
      throw new Error(`Item de menu "${label}" nao encontrado. Rode 'npm run inspect' e fixe checklistsUrl no config.json.`);
    }
    await alvo.scrollIntoViewIfNeeded().catch(() => {});
    await alvo.click({ force: true }).catch(() => {});
    await sleep(1200);
  };

  await clicarMenu(/^\s*Seguran[cç]a\s*$/i, "Seguranca");
  await clicarMenu(/^\s*Checklists\s*$/i, "Checklists");
  await clicarMenu(/^\s*Exporta[cç][oõ]es\s*$/i, "Exportacoes");
  await clicarMenu(/Checklists\s+Pergunta\s*\/?\s*Resposta/i, "Checklists Pergunta/Resposta");

  const root = await rootDaTela(page);
  await primeiroVisivel(root, marcadoresDaTela(cfg), { timeout: 20000 });
  const url = paginaDe(root).url();
  console.log(`[gpm] tela aberta pelo menu. URL atual: ${url} (cole em checklistsUrl no config.json pra acelerar).`);
  return root;
}

// Os 4 campos de data. CALIBRADO: sao flatpickr com altInput -> existem DOIS
// inputs por campo: o ORIGINAL (hidden, com id, formato Y-m-d H:i, e o que o
// form submete) e o altInput (visivel, sem id, formato d/m/Y H:i). Operamos
// sempre no original pelo id, via API do flatpickr.
//   #data_inicial  = Data Servico Inicio   (dta-zero, defaultHour 00:00)
//   #data_final    = Data Servico Final    (dta-fim,  defaultHour 23:59)
//   #data_insp_in  = Data Inspecao Inicio  (dta-zero)
//   #data_insp_out = Data Inspecao Final   (dta-fim)
function camposData(cfg) {
  const s = cfg.selectors || {};
  return [
    { sel: s.dataServicoInicio || "#data_inicial", label: "Data Servico Inicio", fim: false },
    { sel: s.dataServicoFim || "#data_final", label: "Data Servico Final", fim: true },
    { sel: s.dataInspecaoInicio || "#data_insp_in", label: "Data Inspecao Inicio", fim: false },
    { sel: s.dataInspecaoFim || "#data_insp_out", label: "Data Inspecao Final", fim: true },
  ];
}

// "aaaa-mm-dd HH:MM" — formato que o input hidden (dateFormat Y-m-d H:i) guarda
// e que o form submete. E por este valor que conferimos, nao pelo texto visivel.
function fmtISO({ ano, mes, dia }, hora) {
  const p = (n) => String(n).padStart(2, "0");
  return `${ano}-${p(mes)}-${p(dia)} ${hora}`;
}

// Preenche UM campo de data pela API do flatpickr e CONFIRMA relendo o value do
// input hidden. A hora e explicita (00:00 nos campos de inicio, 23:59 nos de
// fim, iguais aos defaultHour do proprio GPM): como enableTime esta ligado, um
// fim as 00:00 cortaria o ultimo dia inteiro do intervalo.
// Fallback: digita no altInput visivel (allowInput=true) e relê o hidden.
// `timeoutFp` = quanto esperar a instancia do flatpickr aparecer (os testes
// passam um valor curto; no CI vale o default folgado).
async function setDataFp(root, campo, parte, hora, tentativas = 3, timeoutFp = 25000) {
  const { sel, label } = campo;
  const esperado = fmtISO(parte, hora);
  const [hh, mm] = hora.split(":").map(Number);

  // O flatpickr pode demorar a instanciar (no CI mais que a tela aparecer).
  await root.waitForFunction(
    (s) => { const el = document.querySelector(s); return !!(el && el._flatpickr); },
    sel, { timeout: timeoutFp }
  ).catch(() => { /* segue: o evaluate abaixo diagnostica */ });

  let lido = "";
  for (let i = 1; i <= tentativas; i++) {
    const r = await root.evaluate(({ sel, ano, mes, dia, hh, mm }) => {
      const el = document.querySelector(sel);
      if (!el) return { ok: false, motivo: "input nao existe" };
      if (!el._flatpickr) return { ok: false, motivo: "sem instancia flatpickr", cls: (el.className || "").slice(0, 80) };
      el._flatpickr.setDate(new Date(ano, mes - 1, dia, hh, mm), true);
      return { ok: true, hidden: el.value, visivel: el._flatpickr.altInput ? el._flatpickr.altInput.value : null };
    }, { sel, ano: parte.ano, mes: parte.mes, dia: parte.dia, hh, mm });

    if (r.ok && r.hidden === esperado) {
      console.log(`[gpm] ${label} = ${esperado} (visivel: "${r.visivel}")`);
      return;
    }
    lido = r.ok ? r.hidden : `<${r.motivo}${r.cls ? ` cls="${r.cls}"` : ""}>`;

    // Fallback: digitar no altInput visivel (d/m/Y H:i) e deixar o flatpickr
    // parsear. So tem sentido se a instancia existir.
    if (r.ok) {
      const alt = root.locator(`${sel} + input, ${sel} ~ input.flatpickr-input`).first();
      if (await alt.isVisible().catch(() => false)) {
        const p = (n) => String(n).padStart(2, "0");
        await alt.fill(`${p(parte.dia)}/${p(parte.mes)}/${parte.ano} ${hora}`).catch(() => {});
        await alt.press("Escape").catch(() => {});
        await sleep(400);
        lido = await root.locator(sel).first().inputValue().catch(() => lido);
        if (lido === esperado) {
          console.log(`[gpm] ${label} = ${esperado} (via altInput).`);
          return;
        }
      }
    }
    console.warn(`[gpm] ${label}: tentativa ${i}/${tentativas} — hidden ficou "${lido}", esperava "${esperado}". Repetindo...`);
    await sleep(400);
  }

  await dump(paginaDe(root), `data-${label.replace(/\s+/g, "-")}-falha`);
  throw new Error(`${label}: esperava "${esperado}" em ${sel} mas ficou "${lido}" apos ${tentativas} tentativas.`);
}

// Le {value,text} do <select> nativo — e o que o submit usa, mesmo escondido
// atras do widget Choices.js.
async function lerSelect(root, sel) {
  return root.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return { value: "", text: "" };
    const o = el.options[el.selectedIndex];
    return { value: el.value || "", text: o ? o.text.trim() : "" };
  }, sel);
}

// Seleciona uma opcao num dropdown Choices.js (Finalidade #finalidade / Tipo de
// Checklist #tipos). Fluxo validado no repo irmao de CE (contrato):
//   abre clicando em .choices__inner (o wrapper externo nao abre)
//   -> digita um TOKEN CURTO no input de busca (a string inteira e descartada
//      pelo filtro fuzzy) -> Enter -> confere pelo <select> nativo
//   -> fallback: clica no item da listbox pelo texto.
// `tms` permite encurtar as esperas nos testes: { widget } = montagem do widget,
// { item } = clique no item da listbox no fallback.
async function selecionarChoices(root, cfg, campo, alvo, token, tms = {}) {
  const tWidget = tms.widget ?? 20000;
  const tItem = tms.item ?? 8000;
  const sel = cfg.selectors[campo] || (campo === "finalidade" ? "#finalidade" : "#tipos");
  const wrap = root.locator(`div.choices:has(${sel})`).first();
  const inner = wrap.locator(".choices__inner").first();
  const busca = wrap.locator("input.choices__input--cloned").first();
  const alvoN = norm(alvo);
  // Aceita SO o texto exato (normalizado). Frouxo aqui e perigoso: o dropdown de
  // Tipo de Checklist tem 5 opcoes contendo "Visita Prévia" (LPT, Manutenção,
  // Poda Manut., UTD, "Visita Prévia (Concluídas)") — casar por substring
  // exportaria o checklist do contrato errado sem ninguem perceber.
  const bateu = (t) => {
    const tn = norm(t);
    if (!tn || /^selecione/.test(tn)) return false;
    return tn === alvoN || tn.replace(/\s+/g, "") === alvoN.replace(/\s+/g, "");
  };

  // Espera o WRAPPER (que tem dimensao) — nao o .choices__inner: dependendo de
  // como o Choices renderiza, o inner pode ter altura zero e um waitFor
  // "visible" nele torraria o timeout inteiro antes de seguir (o clique com
  // force funciona de todo jeito, so custaria ~20s por dropdown).
  await wrap.waitFor({ state: "visible", timeout: tWidget }).catch(() => {});
  await inner.waitFor({ state: "attached", timeout: tWidget }).catch(() => {});
  await wrap.scrollIntoViewIfNeeded().catch(() => {});

  // Abre o dropdown (ate 3 tentativas; confirma pela classe is-open).
  for (let i = 0; i < 3; i++) {
    if (await wrap.evaluate((el) => el.classList.contains("is-open")).catch(() => false)) break;
    await inner.click({ force: true }).catch(() => {});
    await sleep(400);
  }

  // Filtra pelo token (o filtro do Choices e fuzzy: a string inteira costuma
  // nao casar, por isso o token curto do config).
  if (await busca.isVisible().catch(() => false)) {
    await busca.fill(token);
    await sleep(900);
  }

  // Clica no item cujo texto e EXATAMENTE o alvo. Nao usamos Enter aqui: Enter
  // seleciona o item destacado, que e o primeiro da lista filtrada — e com 5
  // opcoes contendo "Visita Prévia" o primeiro foi "LPT - Visita Prévia-BA".
  const itens = wrap.locator('.choices__list[role="listbox"] .choices__item--choice');
  const idxExato = await itens.evaluateAll((els, alvoN) => {
    const norm = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "")
      .toLowerCase().replace(/\s+/g, " ").trim();
    const semEspaco = (s) => norm(s).replace(/\s+/g, "");
    let i = els.findIndex((el) => norm(el.textContent) === alvoN);
    if (i < 0) i = els.findIndex((el) => semEspaco(el.textContent) === semEspaco(alvoN));
    return i;
  }, alvoN).catch(() => -1);

  if (idxExato >= 0) {
    await itens.nth(idxExato).click({ timeout: tItem }).catch(() => {});
    await sleep(500);
  }

  let atual = await lerSelect(root, sel);

  // Fallback: sem item exato visivel (filtro pode ter escondido), tenta o Enter
  // no destacado. Se pegar o item errado, a conferencia abaixo derruba a rodada.
  if (!bateu(atual.text) && (await busca.isVisible().catch(() => false))) {
    await busca.press("Enter").catch(() => {});
    await sleep(500);
    atual = await lerSelect(root, sel);
  }

  if (!bateu(atual.text)) {
    // Diagnostico: lista o que o widget oferecia.
    const opcoes = await wrap.locator('.choices__list[role="listbox"] .choices__item').allTextContents().catch(() => []);
    await dumpFrame(root, `choices-${campo}-falha`);
    throw new Error(`${campo}: nao selecionou "${alvo}" (token "${token}", item exato ${idxExato >= 0 ? `achado no indice ${idxExato}` : "NAO achado"}); select ficou value="${atual.value}" text="${atual.text}". Opcoes vistas: ${JSON.stringify(opcoes.slice(0, 25))}`);
  }
  console.log(`[gpm] ${campo} = "${atual.text}" (value=${atual.value}).`);
  return atual;
}

// O Tipo de Checklist e carregado por AJAX DEPOIS de escolher a Finalidade.
// Espera o widget do #tipos ter itens de verdade antes de tentar selecionar.
async function esperarTiposCarregar(root, cfg, timeout = 20000) {
  const sel = cfg.selectors.tipoChecklist || "#tipos";
  const ok = await root.waitForFunction((s) => {
    const nativo = document.querySelector(s);
    if (!nativo) return false;
    const wrap = nativo.closest("div.choices");
    const itens = wrap ? wrap.querySelectorAll('.choices__list[role="listbox"] .choices__item--choice') : [];
    return itens.length > 0 || nativo.options.length > 1;
  }, sel, { timeout }).then(() => true).catch(() => false);
  if (!ok) {
    console.warn("[gpm] Tipo de Checklist parece nao ter carregado opcoes; tento selecionar de todo jeito.");
  }
}

// Relê os 4 inputs hidden de uma vez e confere contra o esperado. Ultimo portao
// antes de Exportar: escolher Finalidade/Tipo dispara AJAX e pode resetar datas.
async function conferirDatas(root, campos, esperados) {
  const lidos = [];
  for (const c of campos) {
    lidos.push(await root.locator(c.sel).first().inputValue().catch(() => ""));
  }
  const erradas = lidos.map((v, i) => (v === esperados[i] ? null : i)).filter((i) => i !== null);
  if (erradas.length) {
    await dump(paginaDe(root), "datas-divergentes");
    const detalhe = erradas.map((i) => `${campos[i].label}: esperava "${esperados[i]}", li "${lidos[i]}"`).join(" | ");
    throw new Error(`Datas divergentes antes de Exportar -> ${detalhe}`);
  }
  console.log(`[gpm] 4 campos de data confirmados: ${lidos.join(" | ")}`);
}

// Detecta o toast laranja de "sem dados". Vem no HTML do root (e as vezes no
// shell). Mes vazio e condicao normal — nao e erro.
async function toastVazio(root, cfg) {
  const alvo = new RegExp(cfg.toastVazio || "Nenhum registro encontrado", "i");
  const htmls = [await root.content().catch(() => "")];
  const p = paginaDe(root);
  if (p !== root) htmls.push(await p.content().catch(() => ""));
  return htmls.some((h) => alvo.test(h));
}

// Clica "Exportar" e captura o download. Corrida entre 3 desfechos:
//   download (tem dados) | toast "Nenhum registro encontrado" (mes vazio) | timeout.
// Devolve { arquivo } ou { vazio: true }.
async function exportar(page, root, cfg) {
  const ctx = page.context();
  const texto = cfg.exportButtonText || "Exportar";

  let botao;
  try {
    botao = await primeiroVisivel(root, [
      cfg.selectors.exportar,
      (r) => r.getByRole("button", { name: new RegExp(`^\\s*${texto}\\s*$`, "i") }),
      (r) => r.getByRole("link", { name: new RegExp(`^\\s*${texto}\\s*$`, "i") }),
      `button:has-text('${texto}')`,
      `a:has-text('${texto}')`,
      `input[type=submit][value*='${texto}' i]`,
      `input[type=button][value*='${texto}' i]`,
    ], { timeout: 15000 });
  } catch (e) {
    await dumpFrame(root, "export-sem-botao");
    throw new Error(`Botao "${texto}" nao encontrado: ${e.message}`);
  }

  // Arma os listeners ANTES do clique (pode abrir popup).
  let onPage;
  const viaPopup = new Promise((resolve) => {
    onPage = (p) => p.waitForEvent("download", { timeout: 45000 }).then(resolve).catch(() => {});
    ctx.on("page", onPage);
  });
  const viaPage = page.waitForEvent("download", { timeout: 47000 });

  let download = null;
  try {
    await botao.scrollIntoViewIfNeeded().catch(() => {});
    await botao.click({ force: true }).catch(() => {});

    // Polling do toast em paralelo ao download: quem chegar primeiro decide.
    const viaToast = (async () => {
      const deadline = Date.now() + 45000;
      while (Date.now() < deadline) {
        if (await toastVazio(root, cfg)) return "VAZIO";
        await sleep(1000);
      }
      return null;
    })();

    const vencedor = await Promise.race([viaPage, viaPopup, viaToast]);
    if (vencedor === "VAZIO") {
      console.log('[gpm] toast "Nenhum registro encontrado" — periodo sem dados.');
      return { vazio: true };
    }
    download = vencedor;
  } catch (e) {
    if (await toastVazio(root, cfg)) {
      console.log('[gpm] toast "Nenhum registro encontrado" (visto apos timeout) — periodo sem dados.');
      return { vazio: true };
    }
    await dumpFrame(root, "export-sem-download");
    await dump(page, "export-sem-download-shell");
    throw new Error(`Cliquei Exportar mas nenhum download veio em 45s e nao houve toast de vazio. ${e.message}`);
  } finally {
    ctx.off("page", onPage);
    viaPage.catch(() => {}); // evita rejeicao orfa se o race resolveu por outro caminho
  }
  if (!download) throw new Error("Export sem objeto de download (popup pode ter fechado).");

  const sug = download.suggestedFilename();
  fs.mkdirSync(DEBUG_DIR, { recursive: true });
  const destino = path.join(DEBUG_DIR, `ultimo-download-${sug || "arquivo"}`);
  await download.saveAs(destino);
  console.log(`[gpm] download recebido: "${sug}" -> ${destino}`);
  return { arquivo: destino, nomeBaixado: sug };
}

// Extrai os bytes do CSV do arquivo baixado:
//  - ZIP ("PK"): pega o .csv de dentro; se for xlsx, erro claro.
//  - texto: usa como CSV direto.
function extrairCsv(arqPath) {
  const raw = fs.readFileSync(arqPath);
  const ehZip = raw.length >= 2 && raw[0] === 0x50 && raw[1] === 0x4b; // "PK"

  let buffer;
  if (ehZip) {
    const zip = new AdmZip(raw);
    const nomes = zip.getEntries().map((e) => e.entryName);
    const entry = zip.getEntries().find((e) => e.entryName.toLowerCase().endsWith(".csv"));
    if (!entry) {
      const ehXlsx = nomes.some((n) => /^xl\//i.test(n));
      throw new Error(ehXlsx
        ? `O download foi um XLSX (Excel), nao o .zip com CSV. Clicamos no controle errado. Conteudo: ${nomes.join(", ")}`
        : `Zip sem .csv. Conteudo: ${nomes.join(", ")}`);
    }
    buffer = entry.getData();
  } else {
    const inicio = raw.slice(0, 64).toString("utf8").toLowerCase();
    if (inicio.includes("<!doctype") || inicio.includes("<html")) {
      throw new Error("O download veio como HTML (provavel pagina de erro/sessao), nao CSV/zip.");
    }
    buffer = raw;
  }

  const md5 = crypto.createHash("md5").update(buffer).digest("hex");
  return { buffer, md5, bytes: buffer.length, linhas: contarLinhasDados(buffer), origem: ehZip ? "zip" : "csv-direto" };
}

// Rotina completa de uma rodada. `intervalo` opcional ({inicio,fim}) permite
// reaproveitar a funcao num backfill futuro; por padrao usa D-1.
async function baixarChecklists(page, cfg, mesAno, intervalo) {
  const { inicio, fim } = intervalo || intervaloD1(cfg.timezone);
  const vInicio = fmtBR(inicio);
  const vFim = fmtBR(fim);
  console.log(`\n=== Checklists Pergunta/Resposta (Visita Previa BA) | ${vInicio} a ${vFim} | arquivo ${mesAno}.csv ===`);

  const root = await abrirChecklists(page, cfg);

  // Os 4 campos recebem o MESMO par de datas ([servico ini, servico fim,
  // inspecao ini, inspecao fim]); o que difere e a HORA: 00:00 nos campos de
  // inicio, 23:59 nos de fim (enableTime esta ligado, e um fim as 00:00
  // cortaria o ultimo dia inteiro).
  const horaInicio = cfg.horaInicio || "00:00";
  const horaFim = cfg.horaFim || "23:59";
  const campos = camposData(cfg);
  const partes = [inicio, fim, inicio, fim];
  const horas = campos.map((c) => (c.fim ? horaFim : horaInicio));
  for (let i = 0; i < campos.length; i++) {
    await setDataFp(root, campos[i], partes[i], horas[i]);
  }

  await selecionarChoices(root, cfg, "finalidade", cfg.finalidade, cfg.finalidadeSearch || "Vistoria de Obras");
  // Tipo de Checklist so e populado por AJAX depois da Finalidade.
  await esperarTiposCarregar(root, cfg);
  await selecionarChoices(root, cfg, "tipoChecklist", cfg.tipoChecklist, cfg.tipoChecklistSearch || "Visita Pr");

  // Selecionar dropdown dispara AJAX e pode resetar datas — conferimos os 4
  // depois de tudo, imediatamente antes de Exportar.
  const esperados = campos.map((c, i) => fmtISO(partes[i], horas[i]));
  await conferirDatas(root, campos, esperados);

  const r = await exportar(page, root, cfg);
  if (r.vazio) return { vazio: true };

  const { buffer, md5, bytes, linhas } = extrairCsv(r.arquivo);
  const nomeFinal = `${mesAno}.csv`;
  console.log(`[gpm] ${nomeFinal} extraido: ${bytes} bytes, ${linhas} linhas de dados, md5=${md5}`);
  return { buffer, md5, bytes, linhas, nomeFinal };
}

module.exports = {
  login, baixarChecklists, extrairCsv, dump, dumpFrame,
  rootDaTela, abrirChecklists, camposData, fmtISO, setDataFp, lerSelect,
  selecionarChoices, esperarTiposCarregar, conferirDatas, toastVazio, exportar,
  norm, primeiroVisivel,
};
