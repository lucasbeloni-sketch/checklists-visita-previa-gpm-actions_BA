// Mapeia os DOIS dropdowns da tela: lista todas as Finalidades e, pra cada uma
// que interessa, todos os Tipos de Checklist (value + texto exato).
//
// Por que existe: o `inspect` so mostra as 6 primeiras opcoes de cada select, e
// o #tipos so e populado por AJAX DEPOIS de escolher a Finalidade — entao ele
// aparece vazio la. Sem esta lista, o texto exato do config e chute, e o robo
// so descobre que errou quando a rodada falha.
//
// Portado do repo de CE (checklists-formulario-vistoria-gpm-actions_CE), onde
// nasceu porque a lista de tipos de CE e outra e precisava ser descoberta.
//
// Uso:
//   GPM_BA_USER=... GPM_BA_PASS=... npm run tipos   (so a Finalidade do config)
//   TODAS=1 npm run tipos                           (varre TODAS as finalidades)
//
// Sai 0 se o config bate com a tela, 1 se nao bate (o JSON do mapa e gravado em
// debug/ nos dois casos, pra virar artefato do workflow).

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const cfg = require("../config.json");
const {
  login, abrirChecklists, selecionarChoices, esperarTiposCarregar, norm,
} = require("../src/gpm");

const SEL_TIPOS = cfg.selectors.tipoChecklist || "#tipos";
const SEL_FINAL = cfg.selectors.finalidade || "#finalidade";

// Le TODAS as opcoes de um dropdown: as do <select> nativo MAIS as do widget
// Choices.js, deduplicadas por value.
//
// Ler so o nativo nao basta. Na unidade CE o #tipos volta VAZIO no select mesmo
// com o widget cheio — o Choices guarda os itens no DOM dele e so devolve a
// opcao pro select quando ela e escolhida. Em BA o select costuma vir
// preenchido, mas ler as duas fontes torna a ferramenta indiferente a isso.
async function opcoesDe(root, sel) {
  return root.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    const placeholder = (t) => /^selecione/i.test(String(t ?? "").trim());
    const vistos = new Map();

    for (const o of [...el.options]) {
      if (o.value && !placeholder(o.text)) {
        vistos.set(o.value, { value: o.value, texto: o.text.trim(), fonte: "select" });
      }
    }
    const wrap = el.closest("div.choices");
    if (wrap) {
      const itens = wrap.querySelectorAll('.choices__list[role="listbox"] .choices__item--choice');
      for (const it of itens) {
        const value = it.dataset.value || "";
        const texto = (it.textContent || "").trim();
        if (!texto || placeholder(texto)) continue;
        if (!vistos.has(value)) vistos.set(value || texto, { value, texto, fonte: "widget" });
      }
    }
    return [...vistos.values()];
  }, sel);
}

// Diagnostico do campo: tipo do select e de onde as opcoes vieram.
async function perfilDe(root, sel) {
  return root.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    const wrap = el.closest("div.choices");
    return {
      multiple: el.multiple,
      opcoesNoSelect: el.options.length,
      itensNoWidget: wrap ? wrap.querySelectorAll('.choices__list[role="listbox"] .choices__item--choice').length : 0,
    };
  }, sel);
}

function imprimir(titulo, opcoes) {
  console.log(`\n=== ${titulo} (${opcoes ? opcoes.length : 0}) ===`);
  if (!opcoes) return console.log("  <select nao encontrado>");
  for (const o of opcoes) console.log(`  [${o.value}] ${o.texto}`);
}

(async () => {
  const browser = await chromium.launch({ headless: process.env.HEADED ? false : true });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  page.setDefaultTimeout(60000);

  const mapa = { geradoEm: new Date().toISOString(), baseUrl: cfg.baseUrl, finalidades: [], tipos: {} };
  let problemas = [];

  try {
    await login(page, cfg);
    const root = await abrirChecklists(page, cfg);

    mapa.perfilFinalidade = await perfilDe(root, SEL_FINAL);
    console.log(`[perfil] #finalidade: ${JSON.stringify(mapa.perfilFinalidade)}`);
    const finalidades = await opcoesDe(root, SEL_FINAL);
    mapa.finalidades = finalidades || [];
    imprimir("FINALIDADES", finalidades);

    // Confere o texto do config contra a tela (comparacao normalizada: sem
    // acento, minusculo, espacos colapsados — igual a do robo).
    const alvoF = (finalidades || []).find((o) => norm(o.texto) === norm(cfg.finalidade));
    if (alvoF) {
      console.log(`\n[ok] config.finalidade "${cfg.finalidade}" existe na tela (value=${alvoF.value}).`);
    } else {
      problemas.push(`config.finalidade "${cfg.finalidade}" NAO existe na lista acima.`);
    }

    // Quais finalidades varrer: a do config, ou todas com TODAS=1.
    const varrer = process.env.TODAS
      ? (finalidades || [])
      : (alvoF ? [alvoF] : []);

    for (const f of varrer) {
      console.log(`\n--- carregando tipos de "${f.texto}" ---`);
      try {
        await selecionarChoices(root, cfg, "finalidade", f.texto, f.texto.slice(0, 12));
        const carregou = await esperarTiposCarregar(root, cfg);
        const perfil = await perfilDe(root, SEL_TIPOS);
        console.log(`  [perfil] #tipos: ${JSON.stringify(perfil)}`);
        const tipos = await opcoesDe(root, SEL_TIPOS);
        mapa.tipos[f.texto] = tipos || [];
        imprimir(`TIPOS DE CHECKLIST — ${f.texto}`, tipos);
        // Lista vazia tem dois significados MUITO diferentes: "esta finalidade
        // nao tem tipo nenhum" e "o AJAX nao respondeu". Separar os dois aqui
        // evita concluir que o alvo nao existe quando so faltou esperar.
        if (!tipos || tipos.length === 0) {
          console.log(`  [${carregou ? "vazio de verdade" : "AJAX NAO RESPONDEU"}] nenhum tipo sob esta finalidade.`);
        }
      } catch (e) {
        console.warn(`  [aviso] nao consegui listar os tipos desta finalidade: ${e.message}`);
        mapa.tipos[f.texto] = null;
      }
    }

    // Confere o Tipo do config dentro da Finalidade do config.
    if (alvoF) {
      const lista = mapa.tipos[alvoF.texto] || [];
      const alvoT = lista.find((o) => norm(o.texto) === norm(cfg.tipoChecklist));
      if (alvoT) {
        console.log(`\n[ok] config.tipoChecklist "${cfg.tipoChecklist}" existe (value=${alvoT.value}).`);
      } else {
        problemas.push(`config.tipoChecklist "${cfg.tipoChecklist}" NAO existe sob a finalidade "${alvoF.texto}".`);
      }

      // Os tipos que o token de busca tambem filtra — sao os decoys que o
      // clique por texto exato precisa descartar, e o que deve ir pro fixture
      // do test/dom.test.js.
      const tk = norm(cfg.tipoChecklistSearch);
      const vizinhos = lista.filter((o) => norm(o.texto).includes(tk));
      console.log(`\n=== VIZINHOS do token "${cfg.tipoChecklistSearch}" (${vizinhos.length}) ===`);
      for (const v of vizinhos) console.log(`  [${v.value}] ${v.texto}`);
      if (vizinhos.length === 0) {
        problemas.push(`o token "${cfg.tipoChecklistSearch}" nao filtra nenhum tipo — o widget nao vai mostrar o alvo.`);
      }
      mapa.vizinhosDoToken = vizinhos;
    }
  } finally {
    fs.mkdirSync(path.join(__dirname, "..", "debug"), { recursive: true });
    const saida = path.join(__dirname, "..", "debug", "mapa-filtros.json");
    fs.writeFileSync(saida, JSON.stringify(mapa, null, 2), "utf8");
    console.log(`\n[tipos] mapa gravado em ${saida}`);
    await browser.close();
  }

  if (problemas.length) {
    console.error("\n=== VEREDITO: o config NAO bate com a tela ===");
    for (const p of problemas) console.error(`  - ${p}`);
    console.error("\nAjuste config.json (finalidade / tipoChecklist / tokens de busca) com os textos EXATOS listados acima.");
    process.exit(1);
  }
  console.log("\n=== VEREDITO: config bate com a tela. ===");
})();
