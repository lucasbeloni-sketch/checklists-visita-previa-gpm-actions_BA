// Auditoria estrutural dos CSVs da pasta: as linhas estao alinhadas com o
// cabecalho, ou houve mistura de layouts?
//
// Contexto: os arquivos anuais (2023/2024/2025.csv) foram montados a mao
// concatenando exports mensais. Como o export do GPM traz uma coluna por
// PERGUNTA e so as perguntas presentes nos registros do periodo, o numero de
// colunas varia de export para export (67 a 78, medido). Concatenar sob um
// cabecalho unico desalinha as respostas.
//
// Como detectamos, sem depender de saber o layout certo: as 8 primeiras colunas
// sao fixas em todas as versoes do relatorio, com formato reconhecivel.
//   0 Contrato       -> texto
//   1 Ordem trabalho -> texto
//   2 Ordem trabalho Principal -> texto
//   3 cod_checklist  -> so digitos
//   4 Cliente        -> texto
//   5 Funcionario    -> texto
//   6 Data Execução  -> dd/mm/aaaa
//   7 formulario     -> nome do tipo de checklist (contem "Visita" no nosso caso)
// Linha com cod_checklist nao numerico ou Data Execução fora de formato = linha
// deslocada. Largura diferente do cabecalho = linha de outro layout.
//
//   GOOGLE_CREDENTIALS="$(cat credentials.json)" npm run auditar

const cfg = require("../config.json");
const { listarCsv, baixarCsv } = require("../src/drive");
const { parseCsv } = require("../src/uniao");

const ehData = (v) => /^\d{2}\/\d{2}\/\d{4}/.test((v || "").trim());
const ehCod = (v) => /^\d{3,}$/.test((v || "").trim());

(async () => {
  const arquivos = (await listarCsv(cfg)).sort((a, b) => a.name.localeCompare(b.name));
  console.log(`[auditar] ${arquivos.length} csv(s) na pasta\n`);

  const resumo = [];
  for (const f of arquivos) {
    const buf = await baixarCsv(f.name, cfg);
    const { header, rows } = parseCsv(buf);

    const larguras = {};
    let codRuim = 0, dataRuim = 0;
    const exemplos = [];
    for (const r of rows) {
      larguras[r.length] = (larguras[r.length] || 0) + 1;
      const cod = r[3], data = r[6];
      if (!ehCod(cod)) {
        codRuim++;
        if (exemplos.length < 3) exemplos.push(`cod_checklist="${(cod || "").slice(0, 30)}" (largura ${r.length})`);
      }
      if (!ehData(data)) {
        dataRuim++;
        if (exemplos.length < 3) exemplos.push(`Data Execução="${(data || "").slice(0, 30)}" (largura ${r.length})`);
      }
    }

    // Onde a data aparece, se nao esta na coluna 6? Indica o deslocamento.
    const deslocamentos = {};
    for (const r of rows) {
      if (ehData(r[6])) continue;
      const i = r.findIndex((v) => ehData(v));
      if (i >= 0) deslocamentos[i - 6] = (deslocamentos[i - 6] || 0) + 1;
    }

    const larguraHeader = header.length;
    const ok = codRuim === 0 && dataRuim === 0 && Object.keys(larguras).length === 1
      && Number(Object.keys(larguras)[0]) === larguraHeader;

    console.log(`${ok ? "OK  " : "RUIM"} ${f.name}`);
    console.log(`     cabecalho: ${larguraHeader} colunas | linhas: ${rows.length}`);
    console.log(`     larguras das linhas: ${Object.entries(larguras).map(([k, v]) => `${k}=>${v}`).join(", ")}`);
    if (codRuim || dataRuim) {
      console.log(`     PROBLEMA: ${codRuim} linha(s) com cod_checklist invalido, ${dataRuim} com Data Execução invalida`);
      if (Object.keys(deslocamentos).length) {
        console.log(`     deslocamento da coluna de data: ${Object.entries(deslocamentos).map(([k, v]) => `${k > 0 ? "+" : ""}${k} col => ${v} linha(s)`).join(", ")}`);
      }
      for (const e of exemplos) console.log(`     ex.: ${e}`);
    }
    console.log("");
    resumo.push({ arquivo: f.name, colunas: larguraHeader, linhas: rows.length, ok, codRuim, dataRuim, larguras: Object.keys(larguras).length });
  }

  console.log("=== Resumo ===");
  console.log("arquivo;colunas;linhas;integro;linhas_deslocadas;larguras_distintas");
  for (const r of resumo) {
    console.log(`${r.arquivo};${r.colunas};${r.linhas};${r.ok ? "sim" : "NAO"};${Math.max(r.codRuim, r.dataRuim)};${r.larguras}`);
  }
  const ruins = resumo.filter((r) => !r.ok);
  console.log(`\n${ruins.length ? `${ruins.length} arquivo(s) com problema estrutural: ${ruins.map((r) => r.arquivo).join(", ")}` : "todos estruturalmente integros"}`);
})().catch((e) => {
  console.error(`[auditar] FALHOU: ${e.message}`);
  process.exit(1);
});
