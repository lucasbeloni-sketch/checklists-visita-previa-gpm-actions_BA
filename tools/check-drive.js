// Checa o acesso da service account a pasta-destino no Drive (Shared Drive BA)
// e lista o que ja esta la. Rode ANTES do primeiro run real:
//   GOOGLE_CREDENTIALS="$(cat credentials.json)" npm run check
//
// Se der 404/403, falta compartilhar a pasta Checklists_Visita_Previa com o
// e-mail da service account como EDITOR (o Shared Drive do BA e diferente do CE,
// permissao no CE nao vale aqui).

const { google } = require("googleapis");
const cfg = require("../config.json");
const { getAuthClient } = require("../lib/google");

(async () => {
  const auth = await getAuthClient(["https://www.googleapis.com/auth/drive"]);
  const drive = google.drive({ version: "v3", auth });

  const cred = JSON.parse(process.env.GOOGLE_CREDENTIALS.trim());
  console.log(`[check] service account: ${cred.client_email}`);

  const pasta = await drive.files.get({
    fileId: cfg.destFolderId,
    fields: "id,name,driveId,mimeType",
    supportsAllDrives: true,
  });
  console.log(`[check] pasta OK: "${pasta.data.name}" (id=${pasta.data.id}, driveId=${pasta.data.driveId || "meu drive"})`);

  const list = await drive.files.list({
    q: `'${cfg.destFolderId}' in parents and trashed = false`,
    fields: "files(id,name,size,modifiedTime)",
    orderBy: "name",
    pageSize: 200,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    corpora: pasta.data.driveId ? "drive" : undefined,
    driveId: pasta.data.driveId || undefined,
  });
  const files = list.data.files || [];
  console.log(`[check] ${files.length} arquivo(s) na pasta:`);
  for (const f of files) {
    console.log(`   ${f.name}  ${f.size || "?"} bytes  mod=${f.modifiedTime}`);
  }

  // Duplicatas de mesmo nome atrapalham o "sobrescreve sempre".
  const dups = Object.entries(files.reduce((acc, f) => ((acc[f.name] = (acc[f.name] || 0) + 1), acc), {}))
    .filter(([, n]) => n > 1);
  if (dups.length) {
    console.warn(`[check] ATENCAO duplicatas: ${dups.map(([n, c]) => `${n} (${c}x)`).join(", ")}`);
  }
})().catch((e) => {
  console.error(`[check] FALHOU: ${e.message}`);
  process.exit(1);
});
