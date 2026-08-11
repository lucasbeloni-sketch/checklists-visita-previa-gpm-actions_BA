// Smoke test do carimbo: grava o timestamp na planilha de controle e sai.
// Nao mexe no GPM nem no Drive. Serve pra provar que a service account tem
// acesso EDITOR na planilha (o run diario so avisa em warning se nao tiver).
//
//   npm run carimbar

const cfg = require("../config.json");
const { carimbar } = require("../src/timestamp");

(async () => {
  const r = await carimbar(cfg, process.env.SUFIXO || "(teste manual)");
  if (!r) {
    console.error("[carimbar] FALHOU. Confira se a planilha esta compartilhada como Editor com o e-mail da service account.");
    process.exit(1);
  }
  console.log(`[carimbar] OK: ${r.stamp} em ${r.range}`);
})();
