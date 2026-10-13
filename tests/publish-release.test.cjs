"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const test = require("node:test");
const { latestInstaller, publishInstaller } = require("../packaging/publish-release.cjs");

const installer = { name: "Tienda-Napoles-Offline-Setup-1.0.15.exe", version: "1.0.15" };
const bytes = Buffer.from("MZ-test-installer");
const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const asset = { name: installer.name, state: "uploaded", size: bytes.length, digest, browser_download_url: "https://github.com/test/installer.exe" };
const options = { installer, bytes, commit: "test-commit", log() {} };

test("elige la mayor version numerica y omite otros archivos", () => {
  assert.equal(latestInstaller([
    "Tienda-Napoles-Offline-Setup-1.0.9.exe", installer.name,
    "Tienda-Napoles-Offline-Setup-1.0.14.exe", "README.md"
  ]).version, "1.0.15");
  assert.throws(() => latestInstaller(["README.md"]), /No hay instaladores/);
});

test("publica como latest solo despues de subir y verificar el archivo", async () => {
  const calls = [];
  await publishInstaller({ ...options, async request(method, url, body) {
    calls.push({ method, url, body });
    if (url.endsWith("/latest")) return { tag_name: "v1.0.14" };
    if (method === "GET") return null;
    if (method === "POST" && !Buffer.isBuffer(body)) return { id: 15, draft: true, assets: [] };
    if (Buffer.isBuffer(body)) return asset;
    return {};
  } });
  assert.equal(calls[2].body.draft, true);
  assert.equal(calls[2].body.target_commitish, "test-commit");
  assert.equal(calls[3].body, bytes);
  assert.deepEqual(calls[4].body, { draft: false, prerelease: false, make_latest: "true" });
});

test("una subida incompleta no publica el borrador", async () => {
  const methods = [];
  await assert.rejects(publishInstaller({ ...options, async request(method, url, body) {
    methods.push(method);
    if (method === "GET") return null;
    if (Buffer.isBuffer(body)) return { ...asset, size: 1 };
    return { id: 15, draft: true, assets: [] };
  } }), /archivo completo/);
  assert.equal(methods.includes("PATCH"), false);
});

test("volver a publicar el mismo archivo no lo duplica ni modifica", async () => {
  const methods = [];
  await publishInstaller({ ...options, async request(method, url) {
    methods.push(method);
    return url.endsWith("/latest") ? { tag_name: "v1.0.15" } : { id: 15, draft: false, prerelease: false, assets: [asset] };
  } });
  assert.deepEqual(methods, ["GET", "GET"]);
});

test("rechaza reemplazar un archivo publicado con contenido diferente", async () => {
  await assert.rejects(publishInstaller({ ...options, async request(method, url) {
    assert.equal(method, "GET");
    return url.endsWith("/latest") ? { tag_name: "v1.0.15" } : { id: 15, assets: [{ ...asset, digest: "sha256:other" }] };
  } }), /no se reemplazan/);
});

test("un instalador antiguo no desplaza una version mas reciente", async () => {
  let calls = 0;
  await publishInstaller({ ...options, async request() { calls++; return { tag_name: "v1.0.16" }; } });
  assert.equal(calls, 1);
});
