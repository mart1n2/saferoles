import assert from "node:assert/strict";
import {readFile,readdir} from "node:fs/promises";
import test from "node:test";
const root=new URL("../",import.meta.url);
test("build output is a portable static SPA with no server or database artifacts",async()=>{
  const html=await readFile(new URL("dist/index.html",root),"utf8");
  assert.match(html,/<div id="root"><\/div>/);assert.match(html,/type="module".*\/assets\//);
  const entries=await readdir(new URL("dist/",root));assert.ok(!entries.includes("server"));assert.ok(!entries.includes("worker"));assert.ok(!entries.includes(".openai"));
  for(const name of await readdir(new URL("dist/assets/",root))){if(!name.endsWith(".js"))continue;const body=await readFile(new URL(`dist/assets/${name}`,root),"utf8");assert.doesNotMatch(body,/\/api\/(drafts|rolesmod|rolesmods|proposals|abi|abis|selectors|safe-transaction)(?:\?|["'`])/);assert.doesNotMatch(body,/cloudflare:workers|oai-authenticated-user-email/);}
});
test("Safe manifest and both static host header configurations are packaged",async()=>{
  const manifest=JSON.parse(await readFile(new URL("dist/manifest.json",root),"utf8"));assert.equal(manifest.name,"SafeRoles");assert.ok((await readFile(new URL(`dist/${manifest.iconPath}`,root))).length>0);
  const headers=await readFile(new URL("dist/_headers",root),"utf8");assert.match(headers,/Access-Control-Allow-Origin: \*/);assert.match(headers,/frame-ancestors.*app.safe.global/);assert.doesNotMatch(headers,/X-Frame-Options/i);
  const vercel=JSON.parse(await readFile(new URL("vercel.json",root),"utf8"));assert.equal(vercel.outputDirectory,"dist");assert.ok(vercel.headers.find(row=>row.source==="/manifest.json").headers.some(header=>header.key==="Access-Control-Allow-Origin" && header.value==="*"));
});
