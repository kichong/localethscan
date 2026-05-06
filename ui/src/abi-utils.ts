import { formatEther, isAddress } from "viem";
import type { Abi, AbiParameter, Address, Hex } from "viem";
import type { AbiFunction, TupleField } from "./types";

export function normalizeAddress(value: string): string {
  return value.trim().toLowerCase();
}

export function isAddressLike(value: string): boolean {
  return isAddress(value as Address, { strict: false });
}

export function parseAbiText(input: string): Abi {
  const parsed = JSON.parse(input);
  const maybeAbi = Array.isArray(parsed) ? parsed : parsed?.abi;
  if (!Array.isArray(maybeAbi)) throw new Error("ABI must be an array or object with abi array.");
  return maybeAbi as Abi;
}

export function normalizeValue(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, normalizeValue(v)]));
  }
  if (typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value)) return normalizeAddress(value);
  return value;
}

export function toPrintable(value: unknown): string {
  return JSON.stringify(normalizeValue(value), null, 2) ?? String(value);
}

export function formatEthBalance(wei: bigint): string {
  const value = formatEther(wei);
  const [whole, fraction = ""] = value.split(".");
  const trimmed = fraction.slice(0, 4).replace(/0+$/, "");
  return trimmed ? `${whole}.${trimmed}` : whole;
}

export function getFunctionSignature(fn: AbiFunction): string {
  return `${fn.name}(${(fn.inputs ?? []).map((i) => i.type).join(",")})`;
}

export function coerceAbiValue(param: AbiParameter, value: unknown): unknown {
  const type = param.type;
  if (type.endsWith("[]")) {
    if (!Array.isArray(value)) throw new Error(`Expected JSON array for ${type}.`);
    const child: AbiParameter = { ...param, type: type.slice(0, -2) };
    return value.map((item) => coerceAbiValue(child, item));
  }
  if (type.startsWith("tuple")) {
    const comps = "components" in param ? param.components ?? [] : [];
    if (Array.isArray(value)) return comps.map((c, i) => coerceAbiValue(c, value[i]));
    if (value && typeof value === "object") {
      const rec = value as Record<string, unknown>;
      return comps.map((c) => coerceAbiValue(c, rec[c.name]));
    }
    throw new Error(`Expected tuple JSON for ${type}.`);
  }
  if (type.startsWith("uint") || type.startsWith("int")) return BigInt(value as string);
  if (type === "bool") {
    if (typeof value === "boolean") return value;
    if (typeof value === "string" && value.toLowerCase() === "true") return true;
    if (typeof value === "string" && value.toLowerCase() === "false") return false;
    throw new Error("Expected true/false.");
  }
  if (type === "address") {
    if (typeof value !== "string" || !isAddressLike(value)) throw new Error("Invalid address input.");
    return normalizeAddress(value);
  }
  return value;
}

export function parseArgFromText(param: AbiParameter, rawValue: string): unknown {
  const trimmed = rawValue.trim();
  if (param.type.endsWith("[]") || param.type.startsWith("tuple")) {
    if (!trimmed) throw new Error(`Input required for ${param.type}.`);
    return coerceAbiValue(param, JSON.parse(trimmed));
  }
  return coerceAbiValue(param, trimmed);
}

export function parseTopicsInput(input: string): Hex[] {
  const trimmed = input.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) throw new Error("Topics must be array.");
    return parsed as Hex[];
  }
  return trimmed.split(/[\s,]+/).map((i) => i.trim()).filter(Boolean) as Hex[];
}

export function isExpandableTuple(param: AbiParameter): boolean {
  return param.type.startsWith("tuple") && !param.type.endsWith("[]");
}

export function collectTupleFields(
  param: AbiParameter,
  label: string,
  path: number[] = []
): TupleField[] {
  if (isExpandableTuple(param)) {
    const components = "components" in param ? param.components ?? [] : [];
    return components.flatMap((component, idx) =>
      collectTupleFields(
        component,
        `${label}.${component.name || `item${idx}`}`,
        [...path, idx]
      )
    );
  }
  return [{ path, pathText: path.join("."), label, param }];
}

export function parseTupleLeafDraft(param: AbiParameter, raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (param.type.endsWith("[]") || param.type.startsWith("tuple")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return raw;
    }
  }
  return raw;
}

export function buildTupleValueFromDraft(
  param: AbiParameter,
  argIndex: number,
  draft: Record<string, string>,
  path: number[] = []
): unknown {
  if (isExpandableTuple(param)) {
    const components = "components" in param ? param.components ?? [] : [];
    return components.map((component, idx) =>
      buildTupleValueFromDraft(component, argIndex, draft, [...path, idx])
    );
  }
  const key = `${argIndex}:${path.join(".")}`;
  return parseTupleLeafDraft(param, draft[key] ?? "");
}
