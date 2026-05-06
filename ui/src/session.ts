import type { Abi } from "viem";
import { DEFAULT_RPC, LEGACY_STORAGE_KEY, STORAGE_KEY } from "./config";
import { isAddressLike, normalizeAddress, parseAbiText } from "./abi-utils";
import type { ContractEntry, ContractUI } from "./types";

export function emptyUI(): ContractUI {
  return {
    fnInputs: {},
    tupleDrafts: {},
    payableValueWei: {},
    readResults: {},
    writeResults: {},
    rawTopics: "",
    rawData: "0x",
    rawTxHash: "",
    rawDecoded: ""
  };
}

export function toId(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function loadSession(): {
  rpcUrl: string;
  darkMode: boolean;
  collapsed: Record<string, boolean>;
  contracts: ContractEntry[];
} {
  try {
    const raw = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!raw) return { rpcUrl: DEFAULT_RPC, darkMode: false, collapsed: {}, contracts: [] };
    const parsed = JSON.parse(raw);
    const contracts: ContractEntry[] = [];
    for (const item of parsed.contracts ?? []) {
      try {
        const address = normalizeAddress(item.address);
        if (!isAddressLike(address)) continue;
        contracts.push({ id: item.id || toId(), name: item.name || "contract", address, abiText: item.abiText, abi: parseAbiText(item.abiText) });
      } catch {
        // ignore invalid persisted contract
      }
    }
    return {
      rpcUrl: typeof parsed.rpcUrl === "string" ? parsed.rpcUrl : DEFAULT_RPC,
      darkMode: Boolean(parsed.darkMode),
      collapsed: parsed.collapsed && typeof parsed.collapsed === "object" ? parsed.collapsed : {},
      contracts
    };
  } catch {
    return { rpcUrl: DEFAULT_RPC, darkMode: false, collapsed: {}, contracts: [] };
  }
}

export function parseImportFile(text: string, fileName: string): ContractEntry[] {
  const parsed = JSON.parse(text);
  const base = fileName.replace(/\.json$/i, "");
  const parseOne = (raw: unknown, fallbackName: string): ContractEntry => {
    const item = raw as Record<string, unknown>;
    const address = normalizeAddress(String(item.address ?? ""));
    if (!isAddressLike(address)) throw new Error("Invalid address in import file.");
    const abi = item.abi;
    if (!Array.isArray(abi)) throw new Error("Import object needs abi array.");
    const name = typeof item.name === "string" && item.name.trim() ? item.name.trim() : fallbackName;
    return { id: toId(), name, address, abiText: JSON.stringify(abi, null, 2), abi: abi as Abi };
  };

  if (Array.isArray(parsed)) return parsed.map((item, idx) => parseOne(item, `${base}-${idx + 1}`));
  if (parsed && typeof parsed === "object" && Array.isArray((parsed as any).contracts)) {
    return (parsed as any).contracts.map((item: unknown, idx: number) => parseOne(item, `${base}-${idx + 1}`));
  }
  if (parsed && typeof parsed === "object") return [parseOne(parsed, base)];
  throw new Error(`${fileName}: unsupported JSON format.`);
}
