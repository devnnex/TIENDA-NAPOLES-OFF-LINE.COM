"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");

const repository = "devnnex/TIENDA-NAPOLES-OFF-LINE.COM";
const apiRoot = `https://api.github.com/repos/${repository}`;

function compareVersions(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  }
  return 0;
}

function latestInstaller(names) {
  const installers = names.flatMap((name) => {
    const match = /^Tienda-Napoles-Offline-Setup-(\d+\.\d+\.\d+)\.exe$/.exec(name);
    return match ? [{ name, version: match[1] }] : [];
  });
  installers.sort((a, b) => compareVersions(b.version, a.version));
  if (!installers.length) throw new Error("No hay instaladores en dist.");
  return installers[0];
}

async function publishInstaller({ installer, bytes, commit, request, log = console.log }) {
  const hash = createHash("sha256").update(bytes).digest("hex");
  const tag = `v${installer.version}`;
  const latest = await request("GET", `${apiRoot}/releases/latest`, undefined, true);
  const latestVersion = /^v?(\d+\.\d+\.\d+)$/.exec(latest?.tag_name || "");
  if (latestVersion && compareVersions(latestVersion[1], installer.version) > 0) {
    log(`Se conserva ${latest.tag_name}: es mas reciente que ${tag}.`);
    return;
  }

  let release = await request("GET", `${apiRoot}/releases/tags/${tag}`, undefined, true);
  if (!release) {
    // El borrador evita que la landing vea una version sin archivo de descarga.
    release = await request("POST", `${apiRoot}/releases`, {
      tag_name: tag,
      target_commitish: commit,
      name: `Tienda Napoles Offline ${installer.version}`,
      body: `Instalador de Windows ${installer.version}.\n\nInstala con el mismo usuario de Windows para actualizar la aplicacion y sus accesos directos.\n\nSHA256: \`${hash}\``,
      draft: true,
      prerelease: false
    });
  }

  let asset = release.assets?.find((item) => item.name === installer.name);
  if (asset) {
    if (asset.state !== "uploaded" || asset.size !== bytes.length || asset.digest !== `sha256:${hash}`) {
      throw new Error(`El archivo de ${tag} no coincide. Genera una version nueva; no se reemplazan instaladores publicados.`);
    }
  } else {
    const uploadRoot = `https://uploads.github.com/repos/${repository}/releases/${release.id}/assets`;
    asset = await request("POST", `${uploadRoot}?name=${encodeURIComponent(installer.name)}`, bytes);
    if (asset.state !== "uploaded" || asset.size !== bytes.length || asset.digest !== `sha256:${hash}`) {
      throw new Error("GitHub no confirmo el archivo completo con el SHA256 esperado.");
    }
  }

  if (release.draft || release.prerelease || latest?.tag_name !== tag) {
    await request("PATCH", `${apiRoot}/releases/${release.id}`, {
      draft: false,
      prerelease: false,
      make_latest: "true"
    });
  }
  log(`Disponible para la landing: ${tag} - ${asset.browser_download_url}`);
}

async function main() {
  const root = path.resolve(__dirname, "..");
  const installer = latestInstaller(fs.readdirSync(path.join(root, "dist")));
  const bytes = fs.readFileSync(path.join(root, "dist", installer.name));
  if (bytes.length < 2 || bytes.subarray(0, 2).toString() !== "MZ") {
    throw new Error("El instalador no es un ejecutable de Windows valido.");
  }
  const token = process.env.GH_TOKEN;
  if (!token) throw new Error("Falta GH_TOKEN para publicar el instalador.");
  const commit = process.env.GITHUB_SHA || execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  async function request(method, url, body, allowMissing = false) {
    const binary = Buffer.isBuffer(body);
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "tienda-napoles-release-publisher",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body ? { "Content-Type": binary ? "application/octet-stream" : "application/json" } : {})
      },
      ...(body ? { body: binary ? body : JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(120000)
    });
    if (response.status === 404 && allowMissing) return null;
    const result = await response.json();
    if (!response.ok) throw new Error(`GitHub ${response.status}: ${result.message || "No se pudo publicar."}`);
    return result;
  }
  await publishInstaller({ installer, bytes, commit, request });
}

module.exports = { compareVersions, latestInstaller, publishInstaller };
if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
