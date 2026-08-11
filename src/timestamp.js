// Carimba o horario do fim da execucao numa celula de planilha (Sheets API).
//
// Serve de "heartbeat" pra quem olha a planilha: mostra quando o robo rodou por
// ultimo, sem abrir o GitHub Actions. Escopo separado do Drive (spreadsheets),
// entao a service account precisa ter acesso EDITOR na planilha alvo.
//
// Falha aqui NAO derruba o run: o CSV do mes ja foi pro Drive quando chegamos
// aqui, e um carimbo perdido nao justifica marcar a rotina como quebrada.

const { google } = require("googleapis");
const { getAuthClient, stampBR, withRetry } = require("../lib/google");

const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];

// Monta o range A1. Nome de aba com espaco/pontuacao precisa de aspas simples,
// e aspas simples internas dobram ('BD ''X''!C8').
function rangeA1(aba, celula) {
  const nome = /^[A-Za-z0-9_]+$/.test(aba) ? aba : `'${String(aba).replace(/'/g, "''")}'`;
  return `${nome}!${celula}`;
}

// Grava o timestamp. Retorna { stamp, range } ou null se cfg.timestamp nao
// estiver configurado / a escrita falhar.
async function carimbar(cfg, extra = "") {
  const t = cfg.timestamp;
  if (!t || !t.spreadsheetId) {
    console.log("[timestamp] cfg.timestamp ausente; nada a carimbar.");
    return null;
  }
  const range = rangeA1(t.aba || "BD_Config", t.celula || "C8");
  const stamp = stampBR(cfg.timezone) + (extra ? ` ${extra}` : "");
  try {
    const auth = await getAuthClient(SCOPES);
    const sheets = google.sheets({ version: "v4", auth });
    await withRetry(
      () => sheets.spreadsheets.values.update({
        spreadsheetId: t.spreadsheetId,
        range,
        // USER_ENTERED: o Sheets interpreta "dd/MM/aaaa HH:mm:ss" como data-hora
        // de verdade, entao a celula da pra usar em formula/ordenacao.
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [[stamp]] },
      }),
      { label: "timestamp" }
    );
    console.log(`[timestamp] ${stamp} gravado em ${range}.`);
    return { stamp, range };
  } catch (e) {
    console.warn(`[timestamp] NAO consegui gravar em ${range}: ${e.message}`);
    return null;
  }
}

module.exports = { carimbar, rangeA1 };
