// Funcoes puras (sem browser/rede) — testaveis isoladamente.

// {ano, mes(1-12), dia} de uma data no timezone alvo.
function partesData(tz, now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return { ano: Number(p.year), mes: Number(p.month), dia: Number(p.day) };
}

// Ontem (D-1) no timezone alvo, atravessando virada de mes/ano corretamente.
// Fazemos a aritmetica em UTC sobre as PARTES do dia local — assim o resultado
// nao depende do offset e nunca cai um dia errado por causa de DST.
function ontem(tz, now = new Date()) {
  const hoje = partesData(tz, now);
  const d = new Date(Date.UTC(hoje.ano, hoje.mes - 1, hoje.dia) - 86400000);
  return { ano: d.getUTCFullYear(), mes: d.getUTCMonth() + 1, dia: d.getUTCDate() };
}

// Intervalo dos 4 filtros de data, ancorado em ontem (D-1) — regra da Skill:
//   inicio = 1o dia do MES DE ONTEM
//   fim    = ontem
// O mes que importa e o mes a que ONTEM pertence, nao o mes do relogio. Como
// consequencia natural, no dia 1 de cada mes ontem ainda pertence ao mes
// anterior, entao a rodada fecha o mes anterior COMPLETO (01/mm ate o ultimo
// dia dele) sem nenhum tratamento especial. Os dois pares de campos (Data
// Servico e Data Inspecao) usam esse mesmo par de valores.
function intervaloD1(tz, now = new Date()) {
  const fim = ontem(tz, now);
  const inicio = { ano: fim.ano, mes: fim.mes, dia: 1 };
  return { inicio, fim };
}

// "mm.aaaa" do MES DE ONTEM (vira o nome do arquivo: mm.aaaa.csv). Nunca use o
// mes de hoje: no dia 1 eles diferem e o arquivo iria pro mes errado.
function mesAnoD1(tz, now = new Date()) {
  const { ano, mes } = ontem(tz, now);
  return `${String(mes).padStart(2, "0")}.${ano}`;
}

// "dd/mm/aaaa" de uma parte {ano,mes,dia} — formato que os campos do GPM usam.
function fmtBR({ ano, mes, dia }) {
  return `${String(dia).padStart(2, "0")}/${String(mes).padStart(2, "0")}/${ano}`;
}

// Conta linhas de DADOS de um CSV (buffer com/sem BOM). Cabecalho nao conta.
function contarLinhasDados(buffer) {
  let txt = Buffer.isBuffer(buffer) ? buffer.toString("utf8") : String(buffer);
  if (txt.charCodeAt(0) === 0xfeff) txt = txt.slice(1); // tira BOM
  const linhas = txt.split(/\r?\n/).filter((l) => l.trim() !== "");
  return Math.max(0, linhas.length - 1);
}

// Le a coluna "Data Execução" do CSV e devolve {min, max, fora} — mesma
// validacao do preparar_csv.py da Skill (AVISO_INTERVALO). `fora` = alguma data
// caiu fora do mes/ano esperado ("mm.aaaa"), sinal de filtro de data errado.
// CSV do GPM: separador ";", datas dd/mm/aaaa.
function validarIntervalo(buffer, mesAno) {
  let txt = Buffer.isBuffer(buffer) ? buffer.toString("utf8") : String(buffer);
  if (txt.charCodeAt(0) === 0xfeff) txt = txt.slice(1);
  const linhas = txt.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (!linhas.length) return { min: null, max: null, fora: false, total: 0 };

  const header = linhas[0].split(";").map((c) => c.trim().replace(/^"|"$/g, ""));
  const idx = header.findIndex((c) => /^Data\s+Execu[cç][aã]o$/i.test(c));
  if (idx < 0) return { min: null, max: null, fora: false, total: linhas.length - 1 };

  const [mm, aaaa] = String(mesAno).split(".");
  let min = null, max = null, fora = false;
  for (const linha of linhas.slice(1)) {
    const bruto = (linha.split(";")[idx] || "").trim().replace(/^"|"$/g, "");
    const m = bruto.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
    if (!m) continue;
    const [, d, mes, ano] = m;
    const ord = `${ano}${mes}${d}`; // ordenavel como string
    if (min === null || ord < min.ord) min = { ord, br: `${d}/${mes}/${ano}` };
    if (max === null || ord > max.ord) max = { ord, br: `${d}/${mes}/${ano}` };
    if (mes !== mm || ano !== aaaa) fora = true;
  }
  return { min: min?.br ?? null, max: max?.br ?? null, fora, total: linhas.length - 1 };
}

module.exports = { partesData, ontem, intervaloD1, mesAnoD1, fmtBR, contarLinhasDados, validarIntervalo };
