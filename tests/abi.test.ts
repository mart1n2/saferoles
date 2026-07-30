import assert from "node:assert/strict";
import test from "node:test";
import { describeFunctions, parseManualAbi } from "../app/lib/abi-source";
import { parseSignature, parseValue, signatureMatchesSelector } from "../app/lib/abi";
import { ParamType } from "ethers";

test("describes an ABI's functions with selectors and parameter names", () => {
  const functions = describeFunctions([
    {
      type: "function",
      name: "transfer",
      inputs: [
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
      ],
      outputs: [{ name: "", type: "bool" }],
      stateMutability: "nonpayable",
    },
    { type: "event", name: "Transfer", inputs: [] },
    { type: "constructor", inputs: [] },
  ]);

  assert.equal(functions.length, 1, "events and constructors are not callable");
  assert.equal(functions[0].signature, "transfer(address,uint256)");
  assert.equal(functions[0].selector, "0xa9059cbb");
  assert.deepEqual(
    functions[0].inputs.map((input) => `${input.name}:${input.type}`),
    ["to:address", "value:uint256"],
  );
  assert.equal(functions[0].readOnly, false);
});

test("functions carry a readable form with parameter names", () => {
  // A types-only signature leaves a reviewer guessing which argument is the
  // recipient and which is the amount — the whole judgement a review turns on.
  const [fn] = describeFunctions([
    {
      type: "function",
      name: "transfer",
      inputs: [
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
      ],
      outputs: [{ name: "", type: "bool" }],
      stateMutability: "nonpayable",
    },
  ]);

  assert.equal(fn.readable, "transfer(address to, uint256 value)");
  assert.equal(fn.signature, "transfer(address,uint256)");
  assert.equal(
    fn.selector,
    "0xa9059cbb",
    "the selector still hashes from the canonical signature",
  );
  assert.ok(!fn.readable.startsWith("function "), "no leading keyword");
  assert.ok(!fn.readable.includes("returns"), "return types are irrelevant to a grant");
});

test("the readable form names members inside a tuple", () => {
  const [fn] = describeFunctions([
    {
      type: "function",
      name: "exactInput",
      inputs: [
        {
          name: "params",
          type: "tuple",
          components: [
            { name: "path", type: "bytes" },
            { name: "recipient", type: "address" },
            { name: "amountIn", type: "uint256" },
          ],
        },
      ],
      outputs: [],
      stateMutability: "payable",
    },
  ]);

  assert.equal(
    fn.readable,
    "exactInput((bytes path, address recipient, uint256 amountIn) params)",
  );
  assert.equal(fn.signature, "exactInput((bytes,address,uint256))");
});

test("the readable form degrades to types when the ABI names nothing", () => {
  const [fn] = describeFunctions([
    {
      type: "function",
      name: "f",
      inputs: [
        { name: "", type: "address" },
        { name: "", type: "uint256" },
      ],
      outputs: [],
      stateMutability: "nonpayable",
    },
  ]);
  // Never invents labels: unnamed stays unnamed rather than becoming arg0/arg1
  // in a form the user might mistake for the contract's own naming.
  assert.equal(fn.readable, "f(address, uint256)");
});

test("a readable signature parses back to the same selector", () => {
  // The readable form must remain a valid signature, so pasting one into the
  // signature field cannot change which function is permitted.
  for (const readable of [
    "transfer(address to, uint256 value)",
    "exactInput((bytes path, address recipient, uint256 amountIn) params)",
    "poke()",
  ]) {
    const parsed = parseSignature(readable);
    assert.equal(parsed.readable, readable);
    assert.equal(parsed.selector, parseSignature(parsed.canonical).selector);
  }
});

test("read-only functions are marked and sorted last, not hidden", () => {
  // Granting a getter achieves nothing, but seeing it is what explains why.
  const functions = describeFunctions([
    {
      type: "function",
      name: "balanceOf",
      inputs: [{ name: "owner", type: "address" }],
      outputs: [{ name: "", type: "uint256" }],
      stateMutability: "view",
    },
    {
      type: "function",
      name: "approve",
      inputs: [
        { name: "spender", type: "address" },
        { name: "value", type: "uint256" },
      ],
      outputs: [],
      stateMutability: "nonpayable",
    },
  ]);

  assert.deepEqual(
    functions.map((entry) => [entry.name, entry.readOnly]),
    [
      ["approve", false],
      ["balanceOf", true],
    ],
  );
});

test("unnamed parameters get positional placeholders", () => {
  const [fn] = describeFunctions([
    {
      type: "function",
      name: "f",
      inputs: [{ name: "", type: "address" }],
      outputs: [],
      stateMutability: "nonpayable",
    },
  ]);
  assert.equal(fn.inputs[0].name, "arg0");
});

test("duplicate ABI entries collapse to one function", () => {
  const entry = {
    type: "function",
    name: "transfer",
    inputs: [
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  };
  assert.equal(describeFunctions([entry, entry]).length, 1);
});

test("accepts a manual ABI as a JSON array", () => {
  const { functions } = parseManualAbi(
    JSON.stringify([
      {
        type: "function",
        name: "harvest",
        inputs: [{ name: "vault", type: "address" }],
        outputs: [],
        stateMutability: "nonpayable",
      },
    ]),
  );
  assert.deepEqual(
    functions.map((entry) => entry.signature),
    ["harvest(address)"],
  );
  assert.equal(functions[0].inputs[0].name, "vault");
});

test("accepts an explorer payload that wraps the ABI in an object", () => {
  const { functions } = parseManualAbi(
    JSON.stringify({
      abi: [
        {
          type: "function",
          name: "poke",
          inputs: [],
          outputs: [],
          stateMutability: "nonpayable",
        },
      ],
    }),
  );
  assert.deepEqual(
    functions.map((entry) => entry.signature),
    ["poke()"],
  );
});

test("accepts human-readable signatures, one per line, and keeps names", () => {
  const { functions } = parseManualAbi(
    [
      "function harvest(address vault, uint256 minOut)",
      "function setKeeper(address keeper)",
      "function totalAssets() view returns (uint256)",
    ].join("\n"),
  );

  assert.deepEqual(
    functions.map((entry) => entry.signature),
    ["harvest(address,uint256)", "setKeeper(address)", "totalAssets()"],
  );
  const harvest = functions.find((entry) => entry.name === "harvest")!;
  assert.deepEqual(
    harvest.inputs.map((input) => input.name),
    ["vault", "minOut"],
  );
  assert.equal(functions.find((entry) => entry.name === "totalAssets")!.readOnly, true);
});

test("rejects input that is neither JSON nor signatures", () => {
  assert.throws(() => parseManualAbi("not an abi at all"), /neither valid JSON nor/);
  assert.throws(() => parseManualAbi(""), /Paste an ABI/);
});

test("rejects an ABI that declares no callable functions", () => {
  assert.throws(
    () => parseManualAbi(JSON.stringify([{ type: "event", name: "Ping", inputs: [] }])),
    /declares no functions/,
  );
});

test("a signature is only adopted when it hashes to the stored selector", () => {
  assert.ok(signatureMatchesSelector("transfer(address,uint256)", "0xa9059cbb"));
  assert.ok(signatureMatchesSelector("TRANSFER(address,uint256)", "0xa9059cbb") === false);
  assert.equal(signatureMatchesSelector("garbage", "0xa9059cbb"), false);
});

test("signature parsing rejects invented types", () => {
  assert.throws(() => parseSignature("foo(notAType)"), /Cannot parse/);
  assert.throws(() => parseSignature("noParens"), /not a function signature/);
  assert.equal(parseSignature("transfer(address,uint256)").selector, "0xa9059cbb");
});

test("values are parsed strictly against their declared type", () => {
  const address = ParamType.from("address");
  assert.throws(() => parseValue(address, "0x4444 · Ops Safe"), /not a 20-byte address/);
  assert.equal(
    parseValue(address, "0x4444444444444444444444444444444444444444"),
    "0x4444444444444444444444444444444444444444",
  );

  const amount = ParamType.from("uint256");
  assert.equal(parseValue(amount, "1,000"), 1000n);
  assert.throws(() => parseValue(amount, "1.5"), /integer in base units/);
  assert.throws(() => parseValue(amount, "-1"), /cannot be negative/);

  assert.throws(() => parseValue(ParamType.from("bytes32"), "0xdead"), /expected 32 bytes/);
  assert.equal(parseValue(ParamType.from("bool"), "true"), true);
  assert.throws(() => parseValue(ParamType.from("bool"), "yes"), /enter true or false/);
});
