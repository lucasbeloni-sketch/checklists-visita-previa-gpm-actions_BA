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

// Mapeia os 4 campos de data, em ordem visual (esquerda -> direita):
//   [0] Data Servico Inicio, [1] Data Servico Fim,
//   [2] Data Inspecao Inicio, [3] Data Inspecao Fim
// Heuristica: pega os inputs que parecem campo de data (id/name/class/placeholder
// com "data"/"dd/mm", ou type=date/text mascarado) em ordem de documento e
// devolve um seletor estavel pra cada um (#id > [name=..] > nth de indice).
// Overrides de config.json vencem a heuristica quando presentes.
async function mapearCamposData(root, cfg) {
  const s = cfg.selectors;
  const overrides = [s.dataServicoInicio, s.dataServicoFim, s.dataInspecaoInicio, s.dataInspecaoFim];
  if (overrides.every(Boolean)) return overrides;

  const achados = await root.evaluate(() => {
    const ehData = (el) => {
      const bag = `${el.id} ${el.name} ${el.className} ${el.placeholder || ""}`.toLowerCase();
      if (el.type === "date") return true;
      if (el.type && !["text", "tel", ""].includes(el.type)) return false;
      return /data|dt_|dd\/mm|\bdate\b/.test(bag);
    };
    const out = [];
    for (const el of document.querySelectorAll("input")) {
      if (!ehData(el)) continue;
      const visivel = !!(el.offsetParent || el.getClientRects().length);
      if (!visivel) continue;
      out.push({
        sel: el.id ? `#${CSS.escape(el.id)}` : (el.name ? `input[name="${el.name}"]` : null),
        id: el.id, name: el.name, placeholder: el.placeholder || "",
        x: Math.round(el.getBoundingClientRect().left),
        y: Math.round(el.getBoundingClientRect().top),
      });
    }
    return out;
  });

  if (achados.length < 4) {
    await dumpFrame(root, "campos-data-insuficientes");
    throw new Error(`Esperava 4 campos de data na tela, achei ${achados.length}: ${JSON.stringify(achados)}. Fixe os 4 seletores em config.json > selectors.`);
  }
  // Ordem visual: linha (y) e depois coluna (x) — os 4 ficam na mesma faixa.
  achados.sort((a, b) => (Math.abs(a.y - b.y) > 20 ? a.y - b.y : a.x - b.x));
  const quatro = achados.slice(0, 4).map((a, i) => {
    if (a.sel) return a.sel;
    // Sem id nem name nao ha seletor estavel — melhor falhar claro.
    throw new Error(`Campo de data #${i + 1} nao tem id nem name (${JSON.stringify(a)}). Fixe os 4 seletores em config.json > selectors.`);
  });
  console.log(`[gpm] campos de data mapeados: ${quatro.join(" | ")}`);
  return overrides.map((o, i) => o || quatro[i]);
}

// Preenche UM campo de data e CONFIRMA relendo o value. Faz N tentativas:
// fill -> se nao bateu, seta value via JS + dispara eventos da mascara -> relê.
// Essa reconferencia e o que mata o bug historico do "Data Inspecao Fim".
async function setData(root, sel, valor, label, tentativas = 3) {
  const campo = root.locator(sel).first();
  try {
    await campo.waitFor({ state: "visible", timeout: 20000 });
  } catch (e) {
    await dump(paginaDe(root), `data-${label}-ausente`);
    throw new Error(`${label}: campo ${sel} nao apareceu (${e.message})`);
  }
  await campo.scrollIntoViewIfNeeded().catch(() => {});

  let lido = "";
  for (let i = 1; i <= tentativas; i++) {
    await campo.click().catch(() => {});
    await paginaDe(root).keyboard.press("Escape").catch(() => {}); // fecha datepicker preso
    await campo.fill("").catch(() => {});
    await campo.fill(valor).catch(() => {});
    lido = await campo.inputValue().catch(() => "");

    if (lido !== valor) {
      lido = await campo.evaluate((el, v) => {
        el.value = v;
        for (const t of ["input", "keyup", "change", "blur"]) {
          el.dispatchEvent(new Event(t, { bubbles: true }));
        }
        return el.value;
      }, valor).catch(() => lido);
    }
    await campo.press("Tab").catch(() => {});
    await sleep(300);
    lido = await campo.inputValue().catch(() => lido);
    if (lido === valor) {
      console.log(`[gpm] ${label} = ${valor} (${sel})`);
      return;
    }
    console.warn(`[gpm] ${label}: tentativa ${i}/${tentativas} — campo ficou "${lido}", esperava "${valor}". Repetindo...`);
  }

  await dump(paginaDe(root), `data-${label}-falha`);
  throw new Error(`${label}: esperava "${valor}" mas o campo ${sel} ficou "${lido}" apos ${tentativas} tentativas.`);
}

// Acha um <select> pelo nome logico do campo ("finalidade" | "tipoChecklist").
// Heuristica: id/name casando com o padrao, ou <label>/texto vizinho casando.
async function acharSelect(root, cfg, campo) {
  const override = cfg.selectors[campo];
  if (override) return override;

  const padrao = campo === "finalidade" ? "finalidad" : "tipo";
  const rotulo = campo === "finalidade" ? "finalidade" : "tipo de checklist";

  const sel = await root.evaluate(({ padrao, rotulo }) => {
    const norm = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "")
      .toLowerCase().replace(/\s+/g, " ").trim();
    const selects = [...document.querySelectorAll("select")];
    const idDe = (el) => (el.id ? `#${CSS.escape(el.id)}` : (el.name ? `select[name="${el.name}"]` : null));

    // 1) id/name.
    for (const el of selects) {
      if (norm(`${el.id} ${el.name}`).includes(padrao)) {
        const s = idDe(el);
        if (s) return s;
      }
    }
    // 2) <label for=...> ou texto do container.
    for (const el of selects) {
      const lab = el.id ? document.querySelector(`label[for="${el.id}"]`) : null;
      const textos = [lab?.textContent, el.closest(".form-group, .col, div")?.textContent];
      if (textos.some((t) => norm(t).includes(rotulo))) {
        const s = idDe(el);
        if (s) return s;
      }
    }
    return null;
  }, { padrao, rotulo });

  if (!sel) {
    await dumpFrame(root, `select-${campo}-nao-achado`);
    throw new Error(`Dropdown "${campo}" nao encontrado. Rode 'npm run inspect' e fixe selectors.${campo} no config.json.`);
  }
  return sel;
}

// Seleciona a opcao cujo texto casa (comparacao sem acento/caixa) com `alvo`.
// O <select> nativo pode estar escondido atras de um widget (Choices/Chosen);
// como o SUBMIT usa o select nativo, marcamos a option via JS e disparamos
// change — mesmo caminho validado nos repos irmaos de CE.
async function selecionarOpcao(root, cfg, campo, alvo) {
  const sel = await acharSelect(root, cfg, campo);
  await root.locator(sel).first().waitFor({ state: "attached", timeout: 20000 });

  const r = await root.evaluate(({ sel, alvo }) => {
    const norm = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "")
      .toLowerCase().replace(/\s+/g, " ").trim();
    const el = document.querySelector(sel);
    if (!el) return { ok: false, motivo: "select desapareceu", opcoes: [] };
    const alvoN = norm(alvo);
    const opcoes = [...el.options].map((o) => o.text.trim());

    let escolhida = [...el.options].find((o) => norm(o.text) === alvoN)
      || [...el.options].find((o) => norm(o.text).includes(alvoN))
      || [...el.options].find((o) => alvoN.includes(norm(o.text)) && norm(o.text).length > 3);
    if (!escolhida) return { ok: false, motivo: "opcao nao existe no dropdown", opcoes };

    if (el.multiple) for (const o of el.options) o.selected = false;
    el.value = escolhida.value;
    escolhida.selected = true;
    for (const t of ["input", "change"]) el.dispatchEvent(new Event(t, { bubbles: true }));
    return { ok: true, texto: escolhida.text.trim(), value: escolhida.value, opcoes };
  }, { sel, alvo });

  if (!r.ok) {
    await dumpFrame(root, `select-${campo}-falha`);
    throw new Error(`${campo}: ${r.motivo} (queria "${alvo}"). Opcoes disponiveis: ${JSON.stringify(r.opcoes)}`);
  }
  await sleep(500);

  // Reconfirma pelo select nativo (o widget visual pode mentir).
  const confirmado = await root.evaluate((sel) => {
    const el = document.querySelector(sel);
    return el ? [...el.selectedOptions].map((o) => o.text.trim()).join(" | ") : "";
  }, sel);
  console.log(`[gpm] ${campo} = "${confirmado}" (${sel})`);
  return confirmado;
}

// Relê os 4 campos de data de uma vez e confere contra o esperado. Ultimo
// portao antes de Exportar: se algum campo "voltou" pro valor antigo (o bug
// historico), abortamos em vez de exportar o periodo errado.
async function conferirDatas(root, seletores, esperados) {
  const lidos = [];
  for (const sel of seletores) {
    lidos.push(await root.locator(sel).first().inputValue().catch(() => ""));
  }
  const erradas = lidos.map((v, i) => (v === esperados[i] ? null : i)).filter((i) => i !== null);
  if (erradas.length) {
    await dump(paginaDe(root), "datas-divergentes");
    throw new Error(`Datas divergentes antes de Exportar: esperava ${JSON.stringify(esperados)}, li ${JSON.stringify(lidos)}.`);
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

  // Os 4 campos recebem o MESMO par: [servico inicio, servico fim, inspecao inicio, inspecao fim].
  const seletores = await mapearCamposData(root, cfg);
  const valores = [vInicio, vFim, vInicio, vFim];
  const labels = ["Data Servico Inicio", "Data Servico Fim", "Data Inspecao Inicio", "Data Inspecao Fim"];
  for (let i = 0; i < 4; i++) {
    await setData(root, seletores[i], valores[i], labels[i]);
  }

  await selecionarOpcao(root, cfg, "finalidade", cfg.finalidade);
  await selecionarOpcao(root, cfg, "tipoChecklist", cfg.tipoChecklist);

  // Selecionar dropdown pode re-renderizar a tela e resetar datas — conferimos
  // depois de tudo, imediatamente antes de Exportar.
  await conferirDatas(root, seletores, valores);

  const r = await exportar(page, root, cfg);
  if (r.vazio) return { vazio: true };

  const { buffer, md5, bytes, linhas } = extrairCsv(r.arquivo);
  const nomeFinal = `${mesAno}.csv`;
  console.log(`[gpm] ${nomeFinal} extraido: ${bytes} bytes, ${linhas} linhas de dados, md5=${md5}`);
  return { buffer, md5, bytes, linhas, nomeFinal };
}

module.exports = {
  login, baixarChecklists, extrairCsv, dump, dumpFrame,
  rootDaTela, abrirChecklists, mapearCamposData, acharSelect, selecionarOpcao, setData,
  conferirDatas, toastVazio, norm, primeiroVisivel,
};
