/**
 * ABI signature and value handling.
 *
 * Every value that reaches calldata passes through here, so the rules are
 * strict: a signature must be a signature ethers can parse, and a value must
 * parse cleanly against its declared parameter type. Nothing is inferred from
 * surrounding display text.
 */
import { FunctionFragment, ParamType, getAddress, isAddress, isHexString } from "ethers";

export type ParsedSignature = {
  fragment: FunctionFragment;
  /** 4-byte selector, 0x-prefixed. */
  selector: string;
  params: readonly ParamType[];
  /** Canonical form, e.g. `transfer(address,uint256)`. The selector hashes from this. */
  canonical: string;
  /**
   * Readable form with any declared parameter names, e.g.
   * `transfer(address to, uint256 value)`. Display only.
   */
  readable: string;
};

/**
 * Parses and validates a full function signature.
 *
 * @throws if the signature is malformed or names a type the ABI coder rejects.
 *         This is what stops `foo(notAType)` from being hashed into a selector
 *         for a function that does not exist.
 */
export function parseSignature(signature: string): ParsedSignature {
  const trimmed = signature.trim();
  if (!trimmed) throw new Error("Enter a function signature.");
  if (!trimmed.includes("(") || !trimmed.endsWith(")")) {
    throw new Error(
      `"${trimmed}" is not a function signature. Expected a form like transfer(address,uint256).`,
    );
  }

  let fragment: FunctionFragment;
  try {
    fragment = FunctionFragment.from(trimmed);
  } catch (error) {
    throw new Error(
      `Cannot parse "${trimmed}": ${error instanceof Error ? error.message : "invalid signature"}`,
    );
  }

  // FunctionFragment.from accepts named params and human-readable forms; the
  // canonical selector form is what the Roles modifier stores.
  return {
    fragment,
    selector: fragment.selector,
    params: fragment.inputs,
    canonical: fragment.format("sighash"),
    readable: `${fragment.name}(${fragment.inputs
      .map((input) => input.format("full"))
      .join(", ")})`,
  };
}

/** True when `signature` hashes to `selector`. Used to adopt an imported selector. */
export function signatureMatchesSelector(
  signature: string,
  selector: string,
): boolean {
  try {
    return (
      parseSignature(signature).selector.toLowerCase() === selector.toLowerCase()
    );
  } catch {
    return false;
  }
}

export function isNumericType(type: string): boolean {
  return /^u?int(\d+)?$/.test(type);
}

export function isAddressType(type: string): boolean {
  return type === "address";
}

/**
 * Parses a user-entered value into the JS representation the ABI coder expects
 * for `param`.
 *
 * @throws with a message naming the parameter, so the UI can surface it as a
 *         blocking issue rather than emitting ambiguous calldata.
 */
export function parseValue(param: ParamType, raw: string): unknown {
  const label = param.name ? `${param.name} (${param.type})` : param.type;
  const value = raw.trim();
  if (!value) throw new Error(`${label}: enter a value.`);

  if (param.baseType === "address") {
    // Strict: no scraping an address out of surrounding text.
    if (!isAddress(value)) {
      throw new Error(
        `${label}: "${value}" is not a 20-byte address. Enter the full address on its own.`,
      );
    }
    return getAddress(value);
  }

  if (param.baseType === "bool") {
    if (value === "true") return true;
    if (value === "false") return false;
    throw new Error(`${label}: enter true or false.`);
  }

  if (isNumericType(param.baseType)) {
    const digits = value.replaceAll(",", "").replaceAll("_", "");
    if (!/^-?\d+$/.test(digits)) {
      throw new Error(
        `${label}: enter an integer in base units, with no decimal point.`,
      );
    }
    const parsed = BigInt(digits);
    if (param.baseType.startsWith("uint") && parsed < 0n) {
      throw new Error(`${label}: unsigned parameters cannot be negative.`);
    }
    return parsed;
  }

  if (param.baseType === "bytes" || /^bytes\d+$/.test(param.baseType)) {
    if (!isHexString(value)) {
      throw new Error(`${label}: enter 0x-prefixed hex.`);
    }
    const fixed = /^bytes(\d+)$/.exec(param.baseType);
    if (fixed) {
      const expected = Number(fixed[1]);
      const actual = (value.length - 2) / 2;
      if (actual !== expected) {
        throw new Error(
          `${label}: expected ${expected} bytes, received ${actual}.`,
        );
      }
    }
    return value;
  }

  if (param.baseType === "string") return value;

  // Arrays and tuples: accept JSON so composite values stay expressible.
  if (param.baseType === "array" || param.baseType === "tuple") {
    try {
      return JSON.parse(value);
    } catch {
      throw new Error(
        `${label}: enter a JSON ${param.baseType === "array" ? "array" : "array of tuple members"}, e.g. ${
          param.baseType === "array" ? "[1, 2]" : '["0xabc…", 1]'
        }.`,
      );
    }
  }

  return value;
}

/**
 * Formats an allowance/role key for display, decoding bytes32-encoded strings
 * back to their readable form when possible.
 */
export function shortHex(value: string, lead = 6, tail = 4): string {
  if (!value.startsWith("0x") || value.length <= lead + tail + 2) return value;
  return `${value.slice(0, lead)}…${value.slice(-tail)}`;
}
