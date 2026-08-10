// Descobre quais dias faltam na base historica do Drive.
//
// Contexto: a Skill manual exportava com a Data Fim caindo as 00:00 (os campos
// do GPM tem enableTime), entao o ULTIMO DIA de cada intervalo exportado ficava
// fora. Nos meses em andamento isso se corrigia no dia seguinte; nos meses
// FECHADOS a ultima escrita foi a do dia 1o do mes seguinte, e o ultimo dia
// daquele mes ficou zerado pra sempre.
//
// Este modulo nao chama o GPM: so le os CSVs que ja estao no Drive e aponta os
// dias suspeitos, com o volume medio do mes como referencia (dia util com zero
// registro num mes que tem 10-20/dia e buraco, nao feriado).

const { linhasLogicas, normalizaTexto, separaHeader, contaData } = require("./merge");

const DIAS_SEMANA = ["dom", "seg", "ter", "qua", "qui", "sex", "sab"];

function ultimoDiaDoMes(ano, mes) {
  return new Date(Date.UTC(ano, mes, 0)).getUTCDate();
}

function diaDaSemana(ano, mes, dia) {
  return DIAS_SEMANA[new Date(Date.UTC(ano, mes - 1, dia)).getUTCDay()];
}

function fmtBR({ ano, mes, dia }) {
  const p = (n) => String(n).padStart(2, "0");
  return `${p(dia)}/${p(mes)}/${ano}`;
}

// Conta registros por data (chave dd/mm/aaaa) de um CSV.
function contarPorData(buf, colunaData = 6) {
  const { corpo } = separaHeader(normalizaTexto(buf));
  const linhas = linhasLogicas(corpo);
  const conta = {};
  for (const l of linhas) {
    const v = (l.split(";")[colunaData] || "").trim().replace(/^"|"$/g, "").slice(0, 10);
    if (/^\d{2}\/\d{2}\/\d{4}$/.test(v)) conta[v] = (conta[v] || 0) + 1;
  }
  return { conta, total: linhas.length };
}

// Analisa UM arquivo e devolve os dias de fim de mes sem registro.
// `nome` define o escopo: "mm.aaaa.csv" (um mes) ou "aaaa.csv" (ano inteiro).
// `mesCorrente` = "mm.aaaa" do mes que ainda esta em andamento (nao acusa buraco
// nele: o robo diario ainda vai preencher).
function analisar(nome, buf, { colunaData = 6, mesCorrente = null } = {}) {
  const mMes = nome.match(/^(\d{2})\.(\d{4})\.csv$/i);
  const mAno = nome.match(/^(\d{4})\.csv$/i);
  if (!mMes && !mAno) return { nome, escopo: "desconhecido", buracos: [] };

  const { conta, total } = contarPorData(buf, colunaData);
  const meses = mMes
    ? [{ ano: Number(mMes[2]), mes: Number(mMes[1]) }]
    : Array.from({ length: 12 }, (_, i) => ({ ano: Number(mAno[1]), mes: i + 1 }));

  const buracos = [];
  for (const { ano, mes } of meses) {
    const p = (n) => String(n).padStart(2, "0");
    if (mesCorrente === `${p(mes)}.${ano}`) continue; // mes em andamento: pula

    const doMes = Object.keys(conta).filter((k) => k.slice(3, 5) === p(mes) && k.slice(6) === String(ano));
    if (!doMes.length) continue; // mes sem nenhum dado: nao e buraco de fim de mes

    const ultimo = ultimoDiaDoMes(ano, mes);
    const chaveUltimo = `${p(ultimo)}/${p(mes)}/${ano}`;
    if ((conta[chaveUltimo] || 0) > 0) continue; // ultimo dia presente: ok

    const registros = doMes.reduce((a, k) => a + conta[k], 0);
    const wd = diaDaSemana(ano, mes, ultimo);

    // Forca da evidencia. O criterio "ultimo dia sem Data Execução" e heuristico:
    // ele nao distingue "dia perdido pelo filtro" de "dia em que ninguem
    // executou nada". Comparamos com a media dos OUTROS dias da MESMA semana no
    // mes: se sabado/domingo costuma ter ~0 execucao, um ultimo dia zerado no
    // fim de semana e provavelmente legitimo, nao buraco.
    // Caso real: 28/02/2026 (sab) e 31/05/2026 (dom) continuaram "faltando"
    // depois do backfill porque de fato nao houve execucao nesses dias — as
    // linhas recuperadas tinham Data Execução em outra data.
    const mesmoDia = doMes.filter((k) => {
      const d = Number(k.slice(0, 2));
      return diaDaSemana(ano, mes, d) === wd;
    });
    const mediaMesmoDiaSemana = mesmoDia.length
      ? mesmoDia.reduce((a, k) => a + conta[k], 0) / mesmoDia.length
      : 0;

    buracos.push({
      arquivo: nome,
      data: { ano, mes, dia: ultimo },
      dataBR: chaveUltimo,
      diaSemana: wd,
      mediaDiaDoMes: Math.round(registros / doMes.length),
      mediaMesmoDiaSemana: Math.round(mediaMesmoDiaSemana * 10) / 10,
      diasComDado: doMes.length,
      // "alta" = dia comparavel costuma ter registro, entao zero e suspeito.
      // "fraca" = esse dia da semana normalmente tem ~0; provavelmente legitimo.
      forca: mediaMesmoDiaSemana >= 1 ? "alta" : "fraca",
    });
  }
  return { nome, escopo: mMes ? "mes" : "ano", total, buracos };
}

module.exports = { analisar, contarPorData, ultimoDiaDoMes, diaDaSemana, fmtBR };
