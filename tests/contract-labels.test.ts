import { indexedDB, IDBKeyRange } from "fake-indexeddb";
Object.assign(globalThis, { indexedDB, IDBKeyRange });
import assert from "node:assert/strict";
import test from "node:test";
import { getAddress } from "ethers";
import { LOCAL_DATABASE, LOCAL_DATABASE_VERSION, localRead, localUpdate, openLocalDatabase } from "../app/lib/local-db";
import { readContractLabel, saveContractLabel, normalizeContractAddress, addLocalContract, listLocalContracts, removeLocalContract } from "../app/lib/contract-labels";

const address = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";

test("existing local data survives adding the independent labels store", async () => {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open(LOCAL_DATABASE, 2);
    request.onupgradeneeded = () => {
      for (const name of ["drafts", "submissions", "abis", "secrets", "forms"]) request.result.createObjectStore(name);
      request.transaction!.objectStore("forms").put("existing draft", "migration-proof");
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => { request.result.close(); resolve(); };
  });
  const database = await openLocalDatabase();
  assert.equal(database.version, LOCAL_DATABASE_VERSION);
  assert.ok(database.objectStoreNames.contains("labels"));
  assert.equal(await localRead("forms", "migration-proof"), "existing draft");
});

test("labels survive draft cleanup and use network plus normalized address", async () => {
  await saveContractLabel(1, address, "Treasury USDC");
  await saveContractLabel(11155111, address, "Test USDC");
  await localUpdate("forms", "migration-proof", () => undefined);
  assert.equal(await readContractLabel(1, getAddress(address)), "Treasury USDC");
  assert.equal(await readContractLabel(11155111, address), "Test USDC");
  assert.equal(await readContractLabel(10, address), null);
  await saveContractLabel(1, address, "");
  assert.equal(await readContractLabel(1, address), "");
});

test("latest label writes win and malformed labels are rejected", async () => {
  await Promise.all(["A", "AB", "ABC"].map((label) => saveContractLabel(1, address, label)));
  assert.equal(await readContractLabel(1, address), "ABC");
  await assert.rejects(saveContractLabel(1, address, "x".repeat(257)));
  await assert.rejects(saveContractLabel(1, "0x12", "bad target"));
  await assert.rejects(saveContractLabel(0, address, "bad network"));
  await localUpdate("labels", `1:${address}`, () => ({ version: 1, chainId: 10, address, label: "wrong network" }));
  assert.equal(await readContractLabel(1, address), null);
});

test("local whitelist deduplicates all letter cases and displays checksum addresses", async () => {
  const mixed = "0xA0b86991C6218b36c1d19D4a2e9Eb0cE3606EB48";
  assert.equal(normalizeContractAddress(mixed), getAddress(address));
  await addLocalContract(1, mixed, "USDC");
  await addLocalContract(1, address.toUpperCase(), "USDC");
  assert.deepEqual(await listLocalContracts(1), [{ chainId: 1, address: getAddress(address), label: "USDC" }]);
  assert.deepEqual(await listLocalContracts(10), []);
});

test("renaming, removing and restoring whitelist entries preserve independent labels", async () => {
  await saveContractLabel(1, address, "Treasury token");
  assert.equal((await listLocalContracts(1))[0]!.label, "Treasury token");
  await removeLocalContract(1, address);
  assert.deepEqual(await listLocalContracts(1), []);
  assert.equal(await readContractLabel(1, address), "Treasury token");
  await addLocalContract(1, address);
  assert.equal((await listLocalContracts(1))[0]!.label, "Treasury token");
  await addLocalContract(10, address, "Another network");
  assert.equal((await listLocalContracts(10))[0]!.label, "Another network");
  assert.equal((await listLocalContracts(1))[0]!.label, "Treasury token");
});
