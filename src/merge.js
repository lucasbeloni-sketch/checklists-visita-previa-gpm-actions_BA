// Merge de um CSV recem-exportado dentro de um CSV que ja existe no Drive.
// Usado so pelo backfill dos dias perdidos (o robo diario NAO faz merge: ele
// sobrescreve o arquivo do mes inteiro).
//
// Regras, todas conservadoras — a base historica nao pode ser corrompida:
//
//  1. CABECALHO TEM QUE SER IDENTICO. O questionario do checklist mudou ao
//     longo dos anos (2023.csv tem 69 colunas, 2025.csv tem 81, 07.2026.csv
//     tem 78). Se o export de hoje vier com colunas diferentes do arquivo de
//     destino, as colunas nao se alinham e o merge e ABORTADO.
//  2. Append e TEXTUAL: as linhas do destino nao sao reserializadas, so
//     concatenamos as linhas novas. Assim campos com quebra de linha dentro de
//     aspas (as perguntas de observacao tem) nao correm risco de ser reescritos
//     errado.
//  3. DEDUP por cod_checklist (coluna 3), porque o export de um dia pode trazer
//     linhas cuja "Data Execução" e de outro dia (o filtro e por Data Serviço /
//     Data Inspeção, nao por Data Execução) e essas podem ja estar no destino.
//     Sem chave utilizavel, cai pra comparacao da linha inteira.

const BOM = "﻿";

// Tira BOM e normaliza CRLF -> LF, preservando o resto byte a byte.
function normalizaTexto(buf) {
  let t = Buffer.isBuffer(buf) ? buf.toString("utf8") : String(buf);
  if (t.startsWith(BOM)) t = t.slice(BOM.length);
  return t.replace(/\r\n/g, "\n");
}

// Separa a primeira linha (cabecalho) do resto. Nao tenta parsear campos: o
// resto fica como um bloco de texto, do jeito que veio.
function separaHeader(texto) {
  const i = texto.indexOf("\n");
  if (i < 0) return { header: texto.trim(), corpo: "" };
  return { header: texto.slice(0, i).trim(), corpo: texto.slice(i + 1) };
}

// Quebra o corpo em "linhas logicas": uma linha de dados pode conter \n dentro
// de campos entre aspas, entao contamos aspas pra saber se a linha continua.
function linhasLogicas(corpo) {
  const out = [];
  let atual = "";
  let aspas = 0;
  for (const linha of corpo.split("\n")) {
    atual = atual ? `${atual}\n${linha}` : linha;
    for (const ch of linha) if (ch === '"') aspas++;
    if (aspas % 2 === 0) {              // aspas fechadas -> linha completa
      if (atual.trim() !== "") out.push(atual);
      atual = "";
    }
  }
  if (atual.trim() !== "") out.push(atual);
  return out;
}

// Chave de dedup: cod_checklist (coluna 3). As colunas 0..3 (Contrato, Ordem
// trabalho, Ordem trabalho Principal, cod_checklist) nao tem ";" dentro, entao
// o split simples resolve. Se o valor nao parecer um codigo, devolve null e o
// chamador cai pra linha inteira.
function chaveDaLinha(linha, coluna = 3) {
  const campos = linha.split(";");
  if (campos.length <= coluna) return null;
  const v = campos[coluna].trim().replace(/^"|"$/g, "");
  return /^\d{3,}$/.test(v) ? v : null;
}

// Conta quantas linhas do corpo tem a data alvo (dd/mm/aaaa) na coluna de
// "Data Execução". Serve pra decidir se o dia realmente falta no destino.
function contaData(linhas, dataBR, colunaData = 6) {
  let n = 0;
  for (const l of linhas) {
    const campos = l.split(";");
    const v = (campos[colunaData] || "").trim().replace(/^"|"$/g, "");
    if (v.slice(0, 10) === dataBR) n++;
  }
  return n;
}

// Mescla `novoBuf` (export recente) dentro de `destBuf` (arquivo do Drive).
// Devolve { ok, texto, add, dup, motivo, headerDestino, headerNovo }.
// `ok:false` = NAO grave nada; leia `motivo`.
function mesclar(destBuf, novoBuf, { dataBR = null, colunaChave = 3, colunaData = 6 } = {}) {
  const dest = separaHeader(normalizaTexto(destBuf));
  const novo = separaHeader(normalizaTexto(novoBuf));

  if (dest.header !== novo.header) {
    const nd = dest.header.split(";").length;
    const nn = novo.header.split(";").length;
    return {
      ok: false,
      motivo: `cabecalhos diferentes (destino ${nd} colunas, export novo ${nn}) — o questionario do checklist mudou; nao dá pra mesclar sem desalinhar as colunas`,
      headerDestino: dest.header, headerNovo: novo.header,
    };
  }

  const linhasDest = linhasLogicas(dest.corpo);
  const linhasNovas = linhasLogicas(novo.corpo);
  if (!linhasNovas.length) {
    return { ok: false, motivo: "export novo nao tem linhas de dados" };
  }

  // O dia ja esta no destino? (entao nao e um dia perdido — nao mexe)
  if (dataBR) {
    const jaTem = contaData(linhasDest, dataBR, colunaData);
    if (jaTem > 0) {
      return { ok: false, motivo: `destino ja tem ${jaTem} linha(s) com Data Execução ${dataBR} — nada a recuperar` };
    }
  }

  const chaves = new Set();
  let semChave = false;
  for (const l of linhasDest) {
    const k = chaveDaLinha(l, colunaChave);
    if (k === null) semChave = true;
    chaves.add(k === null ? `linha:${l}` : `cod:${k}`);
  }

  const add = [];
  let dup = 0;
  for (const l of linhasNovas) {
    const k = chaveDaLinha(l, colunaChave);
    const id = k === null ? `linha:${l}` : `cod:${k}`;
    if (chaves.has(id)) { dup++; continue; }
    chaves.add(id);
    add.push(l);
  }

  if (!add.length) {
    return { ok: false, motivo: `todas as ${linhasNovas.length} linha(s) do export ja existiam no destino (dedup por cod_checklist)` };
  }

  const corpoFinal = dest.corpo.endsWith("\n") || dest.corpo === ""
    ? dest.corpo + add.join("\n") + "\n"
    : `${dest.corpo}\n${add.join("\n")}\n`;
  const texto = `${dest.header}\n${corpoFinal}`;

  return {
    ok: true,
    texto,
    add: add.length,
    dup,
    semChave,
    totalAntes: linhasDest.length,
    totalDepois: linhasDest.length + add.length,
  };
}

module.exports = { normalizaTexto, separaHeader, linhasLogicas, chaveDaLinha, contaData, mesclar };
