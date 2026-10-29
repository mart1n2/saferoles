import test from "node:test";
import assert from "node:assert/strict";
import { canonicalLocalUrl } from "../app/lib/canonical-origin";

test("localhost moves to 127.0.0.1 and keeps port, path, query and hash", () => {
  assert.equal(
    canonicalLocalUrl("http://localhost:5173/a?chainId=1&rolesMod=0xabc#x"),
    "http://127.0.0.1:5173/a?chainId=1&rolesMod=0xabc#x",
  );
});

test("127.0.0.1 and deployed hosts are left alone", () => {
  assert.equal(canonicalLocalUrl("http://127.0.0.1:4173/"), null);
  assert.equal(canonicalLocalUrl("https://saferoles.vercel.app/"), null);
  assert.equal(canonicalLocalUrl("https://notlocalhost.example/"), null);
});
