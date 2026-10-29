import test from "node:test";
import assert from "node:assert/strict";
import { safeWalletIcon } from "../app/lib/use-wallet";

test("wallet icons are limited to inline images", () => {
  assert.equal(safeWalletIcon("data:image/png;base64,AAAA"), "data:image/png;base64,AAAA");
  assert.ok(safeWalletIcon("data:image/svg+xml;base64,PHN2Zz4="));
  assert.equal(safeWalletIcon("https://example.com/logo.png"), null);
  assert.equal(safeWalletIcon("data:text/html;base64,PHNjcmlwdD4="), null);
  assert.equal(safeWalletIcon(undefined), null);
});
