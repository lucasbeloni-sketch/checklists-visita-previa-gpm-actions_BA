const cfg = require("./config.json");
const { baixarCsv } = require("./src/drive");
const { parseCsv } = require("./src/uniao");
(async () => {
  const { header, rows } = parseCsv(await baixarCsv("08.2026.csv", cfg));
  console.log("=== AS 90 COLUNAS ===");
  header.forEach((h,i) => {
    const marca = i < 78 ? "  " : " *";
    console.log(`${String(i+1).padStart(2)}${marca} ${h.length > 92 ? h.slice(0,89)+"..." : h}`);
  });
  console.log("\n(* = as 12 aposentadas, no fim)");
  console.log("\n=== PRIMEIRAS 6 LINHAS, COLUNAS 1-8 ===");
  const larg = [26,16,12,11,8,22,11,22];
  const corta = (v,n) => { const s=String(v||"").replace(/\s+/g," "); return (s.length>n ? s.slice(0,n-1)+"…" : s).padEnd(n); };
  console.log(header.slice(0,8).map((h,i)=>corta(h,larg[i])).join(" "));
  console.log(larg.map(n=>"-".repeat(n)).join(" "));
  for (const r of rows.slice(0,6)) console.log(r.slice(0,8).map((v,i)=>corta(v,larg[i])).join(" "));
  console.log("\n=== UM REGISTRO COMPLETO (so campos preenchidos) ===");
  const r = rows.find(x => x.filter(v=>String(v||"").trim()!=="").length > 40) || rows[0];
  header.forEach((h,i) => {
    const v = String(r[i]||"").replace(/\s+/g," ").trim();
    if (v) console.log(`  ${h.length>60?h.slice(0,57)+"...":h} = ${v.length>70?v.slice(0,67)+"...":v}`);
  });
  const vazios = header.filter((_,i)=>!String(r[i]||"").trim()).length;
  console.log(`  (${vazios} das 90 colunas vazias nesse registro)`);
})().catch(e=>{console.error(e.message);process.exit(1)});
