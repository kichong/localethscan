import { useEffect, useMemo, useState } from "react";
import {
  createWalletClient,
  custom,
  createPublicClient,
  decodeEventLog,
  encodeFunctionData,
  formatEther,
  http,
  isAddress,
  toHex
} from "viem";
import type { Abi, AbiParameter, Address, Hex } from "viem";

const STORAGE_KEY = "localethscan:workspace:v2";
const LEGACY_STORAGE_KEY = "localethscan:mvp:v2";
const DEFAULT_RPC = "http://127.0.0.1:8545";

type AbiFunction = Extract<Abi[number], { type: "function" }>;
type ChainStatus = { connected: boolean; chainId?: number; latestBlock?: bigint; error?: string };
type FunctionResult = { loading?: boolean; output?: string; error?: string };
type WriteResult = { loading?: boolean; txHash?: string; receiptSummary?: string; decodedLogs?: string; error?: string };
type ContractEntry = { id: string; name: string; address: string; abiText: string; abi: Abi };
type WalletProviderId = "metamask" | "rabby" | `injected-${number}`;
type InjectedProvider = {
  request: (args: { method: string; params?: unknown[] | object }) => Promise<unknown>;
  providers?: InjectedProvider[];
  isMetaMask?: boolean;
  isRabby?: boolean;
};
type WalletProviderChoice = {
  id: WalletProviderId;
  label: string;
  provider: InjectedProvider;
};
type ContractUI = {
  fnInputs: Record<string, string[]>;
  tupleDrafts: Record<string, Record<string, string>>;
  payableValueWei: Record<string, string>;
  readResults: Record<string, FunctionResult>;
  writeResults: Record<string, WriteResult>;
  rawTopics: string;
  rawData: string;
  rawTxHash: string;
  rawDecoded: string;
};

function normalizeAddress(value: string): string {
  return value.trim().toLowerCase();
}

function isAddressLike(value: string): boolean {
  return isAddress(value as Address, { strict: false });
}

function getRpcUrlError(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return "RPC endpoint is required.";
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return "RPC endpoint must start with http:// or https://.";
    }
    return null;
  } catch {
    return "RPC endpoint URL is invalid.";
  }
}

function getInjectedWalletChoices(): WalletProviderChoice[] {
  if (typeof window === "undefined") return [];
  const root = (window as any).ethereum as InjectedProvider | undefined;
  if (!root) return [];
  const providers = Array.isArray(root.providers) && root.providers.length > 0 ? root.providers : [root];
  const unique: InjectedProvider[] = [];
  for (const provider of providers) {
    if (!provider || typeof provider.request !== "function") continue;
    if (unique.includes(provider)) continue;
    unique.push(provider);
  }
  return unique.map((provider, index) => {
    if (provider.isRabby) return { id: "rabby", label: "Rabby", provider };
    if (provider.isMetaMask) return { id: "metamask", label: "MetaMask", provider };
    return { id: `injected-${index}`, label: `Injected wallet ${index + 1}`, provider };
  });
}

function parseAbiText(input: string): Abi {
  const parsed = JSON.parse(input);
  const maybeAbi = Array.isArray(parsed) ? parsed : parsed?.abi;
  if (!Array.isArray(maybeAbi)) throw new Error("ABI must be an array or object with abi array.");
  return maybeAbi as Abi;
}

function normalizeValue(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, normalizeValue(v)]));
  }
  if (typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value)) return normalizeAddress(value);
  return value;
}

function toPrintable(value: unknown): string {
  return JSON.stringify(normalizeValue(value), null, 2) ?? String(value);
}

function formatEthBalance(wei: bigint): string {
  const value = formatEther(wei);
  const [whole, fraction = ""] = value.split(".");
  const trimmed = fraction.slice(0, 4).replace(/0+$/, "");
  return trimmed ? `${whole}.${trimmed}` : whole;
}

function getFunctionSignature(fn: AbiFunction): string {
  return `${fn.name}(${(fn.inputs ?? []).map((i) => i.type).join(",")})`;
}

function coerceAbiValue(param: AbiParameter, value: unknown): unknown {
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

function parseArgFromText(param: AbiParameter, rawValue: string): unknown {
  const trimmed = rawValue.trim();
  if (param.type.endsWith("[]") || param.type.startsWith("tuple")) {
    if (!trimmed) throw new Error(`Input required for ${param.type}.`);
    return coerceAbiValue(param, JSON.parse(trimmed));
  }
  return coerceAbiValue(param, trimmed);
}

function parseTopicsInput(input: string): Hex[] {
  const trimmed = input.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) throw new Error("Topics must be array.");
    return parsed as Hex[];
  }
  return trimmed.split(/[\s,]+/).map((i) => i.trim()).filter(Boolean) as Hex[];
}

function isExpandableTuple(param: AbiParameter): boolean {
  return param.type.startsWith("tuple") && !param.type.endsWith("[]");
}

type TupleField = {
  path: number[];
  pathText: string;
  label: string;
  param: AbiParameter;
};

function collectTupleFields(
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

function parseTupleLeafDraft(param: AbiParameter, raw: string): unknown {
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

function buildTupleValueFromDraft(
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

function emptyUI(): ContractUI {
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

function toId(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function loadSession(): {
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

function parseImportFile(text: string, fileName: string): ContractEntry[] {
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

export default function App() {
  const initial = loadSession();
  const [rpcUrl, setRpcUrl] = useState(initial.rpcUrl);
  const [rpcInputDraft, setRpcInputDraft] = useState(initial.rpcUrl);
  const [darkMode, setDarkMode] = useState(initial.darkMode);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(initial.collapsed);
  const [chainStatus, setChainStatus] = useState<ChainStatus>({ connected: false });
  const [accounts, setAccounts] = useState<string[]>([]);
  const [senderBalances, setSenderBalances] = useState<Record<string, string>>({});
  const [writeMode, setWriteMode] = useState<"local" | "wallet">("local");
  const [walletProviderId, setWalletProviderId] = useState<WalletProviderId | "">("");
  const [walletProviderLabel, setWalletProviderLabel] = useState("");
  const [walletAccounts, setWalletAccounts] = useState<string[]>([]);
  const [walletChooserOpen, setWalletChooserOpen] = useState(false);
  const [walletConnectLoading, setWalletConnectLoading] = useState(false);
  const [walletAccount, setWalletAccount] = useState("");
  const [walletBalance, setWalletBalance] = useState("");
  const [walletError, setWalletError] = useState("");
  const [fromAddress, setFromAddress] = useState("");
  const [copiedAddress, setCopiedAddress] = useState("");
  const [contracts, setContracts] = useState<ContractEntry[]>(initial.contracts);
  const [contractStates, setContractStates] = useState<Record<string, ContractUI>>(
    () => Object.fromEntries(initial.contracts.map((c) => [c.id, emptyUI()]))
  );
  const [contractNameInput, setContractNameInput] = useState("");
  const [contractAddressInput, setContractAddressInput] = useState("");
  const [abiTextInput, setAbiTextInput] = useState("");
  const [managerError, setManagerError] = useState("");
  const [managerMessage, setManagerMessage] = useState("");

  const rpcUrlError = useMemo(() => getRpcUrlError(rpcUrl), [rpcUrl]);
  const client = useMemo(
    () => (rpcUrlError ? null : createPublicClient({ transport: http(rpcUrl.trim()) })),
    [rpcUrl, rpcUrlError]
  );
  const walletChoices = getInjectedWalletChoices();
  const hasRpcAccounts = accounts.length > 0;
  const effectiveWriteMode: "local" | "wallet" = hasRpcAccounts ? writeMode : "wallet";
  const activeSenderAddress = effectiveWriteMode === "wallet" ? walletAccount : fromAddress;
  const activeSenderBalance = effectiveWriteMode === "wallet" ? walletBalance : senderBalances[fromAddress] ?? "";

  useEffect(() => {
    document.body.dataset.theme = darkMode ? "dark" : "light";
  }, [darkMode]);

  useEffect(() => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        rpcUrl,
        darkMode,
        collapsed,
        contracts: contracts.map((c) => ({ id: c.id, name: c.name, address: c.address, abiText: c.abiText }))
      })
    );
  }, [rpcUrl, darkMode, collapsed, contracts]);

  useEffect(() => {
    setRpcInputDraft(rpcUrl);
  }, [rpcUrl]);

  const applyRpcDraft = (): string => {
    const next = rpcInputDraft.trim();
    setRpcUrl(next);
    return next;
  };

  const applyAndCheckRpc = () => {
    const next = applyRpcDraft();
    if (next === rpcUrl.trim()) {
      void checkChain();
    }
  };

  const setContractState = (id: string, updater: (s: ContractUI) => ContractUI) => {
    setContractStates((prev) => ({ ...prev, [id]: updater(prev[id] ?? emptyUI()) }));
  };
  const getContractState = (id: string): ContractUI => contractStates[id] ?? emptyUI();
  const isCollapsed = (key: string, defaultCollapsed = false) =>
    key in collapsed ? Boolean(collapsed[key]) : defaultCollapsed;
  const toggleCollapsed = (key: string, defaultCollapsed = false) =>
    setCollapsed((prev) => {
      const current = key in prev ? Boolean(prev[key]) : defaultCollapsed;
      return { ...prev, [key]: !current };
    });

  const checkChain = async () => {
    if (!client) {
      setChainStatus({ connected: false, error: rpcUrlError ?? "RPC endpoint is not set." });
      setAccounts([]);
      setSenderBalances({});
      setFromAddress("");
      return;
    }
    try {
      const [chainId, latestBlock, rpcAccounts] = await Promise.all([
        client.getChainId(),
        client.getBlockNumber(),
        client.request({ method: "eth_accounts", params: [] }) as Promise<string[]>
      ]);
      const normalized = rpcAccounts.map(normalizeAddress);
      const balances = await Promise.all(
        normalized.map(async (address) => {
          const wei = await client.getBalance({ address: address as Address });
          return [address, formatEthBalance(wei)] as const;
        })
      );
      const balanceMap = Object.fromEntries(balances);
      setAccounts(normalized);
      setSenderBalances(balanceMap);
      setFromAddress((prev) => (prev && normalized.includes(prev) ? prev : normalized[0] ?? ""));
      setChainStatus({ connected: true, chainId, latestBlock });
    } catch (error) {
      setChainStatus({ connected: false, error: error instanceof Error ? error.message : "Connection failed." });
      setAccounts([]);
      setSenderBalances({});
      setFromAddress("");
    }
  };

  useEffect(() => {
    void checkChain();
    if (!client) return;
    const id = window.setInterval(() => void checkChain(), 5000);
    return () => window.clearInterval(id);
  }, [client, rpcUrlError]);

  useEffect(() => {
    if (!hasRpcAccounts && writeMode === "local") setWriteMode("wallet");
  }, [hasRpcAccounts, writeMode]);

  useEffect(() => {
    const loadWalletBalance = async () => {
      if (!walletAccount || !client) {
        setWalletBalance("");
        return;
      }
      try {
        const wei = await client.getBalance({ address: walletAccount as Address });
        setWalletBalance(formatEthBalance(wei));
      } catch {
        setWalletBalance("");
      }
    };
    void loadWalletBalance();
  }, [walletAccount, client]);

  const clearManagerStatus = () => {
    setManagerError("");
    setManagerMessage("");
  };

  const addContract = (entry: ContractEntry) => {
    setContracts((prev) => [...prev, entry]);
    setContractStates((prev) => ({ ...prev, [entry.id]: emptyUI() }));
  };

  const addSingleContract = () => {
    clearManagerStatus();
    try {
      const address = normalizeAddress(contractAddressInput);
      if (!isAddressLike(address)) throw new Error("Contract address is invalid.");
      const abi = parseAbiText(abiTextInput);
      const name = contractNameInput.trim() || `contract-${contracts.length + 1}`;
      addContract({ id: toId(), name, address, abiText: abiTextInput, abi });
      setContractNameInput("");
      setContractAddressInput("");
      setAbiTextInput("");
      setManagerMessage(`Added ${name} (${address}).`);
    } catch (error) {
      setManagerError(error instanceof Error ? error.message : "Failed to add contract.");
    }
  };

  const onAbiFilePick: React.ChangeEventHandler<HTMLInputElement> = async (event) => {
    const file = event.target.files?.[0];
    if (file) setAbiTextInput(await file.text());
  };

  const onImportFiles: React.ChangeEventHandler<HTMLInputElement> = async (event) => {
    clearManagerStatus();
    const files = event.target.files;
    if (!files || files.length === 0) return;
    try {
      const imported: ContractEntry[] = [];
      for (const file of Array.from(files)) imported.push(...parseImportFile(await file.text(), file.name));
      if (imported.length === 0) throw new Error("No contracts imported.");
      setContracts((prev) => [...prev, ...imported]);
      setContractStates((prev) => {
        const next = { ...prev };
        for (const c of imported) next[c.id] = emptyUI();
        return next;
      });
      setManagerMessage(`Imported ${imported.length} contract(s).`);
    } catch (error) {
      setManagerError(error instanceof Error ? error.message : "Bulk import failed.");
    }
  };

  const renameContract = (id: string, value: string) => {
    const name = value.trim();
    if (!name) return;
    setContracts((prev) => prev.map((c) => (c.id === id ? { ...c, name } : c)));
  };

  const removeContract = (id: string) => {
    setContracts((prev) => prev.filter((c) => c.id !== id));
    setContractStates((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setCollapsed((prev) => {
      const next = { ...prev };
      const prefix = `c:${id}`;
      for (const key of Object.keys(next)) {
        if (key === prefix || key.startsWith(`${prefix}:`)) delete next[key];
      }
      return next;
    });
  };

  const requestRemoveContract = (contract: ContractEntry) => {
    const shouldRemove = window.confirm(
      `Remove ${contract.name} (${contract.address}) from this workspace?`
    );
    if (!shouldRemove) return;
    removeContract(contract.id);
  };

  const updateFunctionInput = (contractId: string, signature: string, index: number, value: string) => {
    setContractState(contractId, (prev) => {
      const fnInputs = { ...prev.fnInputs };
      const arr = [...(fnInputs[signature] ?? [])];
      arr[index] = value;
      fnInputs[signature] = arr;
      return { ...prev, fnInputs };
    });
  };

  const updateTupleDraftInput = (
    contractId: string,
    signature: string,
    argIndex: number,
    param: AbiParameter,
    pathText: string,
    value: string
  ) => {
    setContractState(contractId, (prev) => {
      const tupleDrafts = { ...prev.tupleDrafts };
      const draft = { ...(tupleDrafts[signature] ?? {}) };
      draft[`${argIndex}:${pathText}`] = value;
      tupleDrafts[signature] = draft;

      const fnInputs = { ...prev.fnInputs };
      const arr = [...(fnInputs[signature] ?? [])];
      arr[argIndex] = JSON.stringify(buildTupleValueFromDraft(param, argIndex, draft));
      fnInputs[signature] = arr;

      return { ...prev, tupleDrafts, fnInputs };
    });
  };

  const getArgs = (contract: ContractEntry, fn: AbiFunction): unknown[] => {
    const signature = getFunctionSignature(fn);
    const values = getContractState(contract.id).fnInputs[signature] ?? [];
    return (fn.inputs ?? []).map((input, i) => parseArgFromText(input, values[i] ?? ""));
  };

  const getWalletChoice = (providerId?: WalletProviderId | ""): WalletProviderChoice | undefined => {
    const available = getInjectedWalletChoices();
    if (providerId) return available.find((choice) => choice.id === providerId);
    if (walletProviderId) return available.find((choice) => choice.id === walletProviderId) ?? available[0];
    return available[0];
  };

  const clearWalletConnection = (minimizeWalletPanel = false) => {
    setWalletProviderId("");
    setWalletProviderLabel("");
    setWalletAccounts([]);
    setWalletAccount("");
    setWalletBalance("");
    setWalletError("");
    setWalletChooserOpen(false);
    setWriteMode(hasRpcAccounts ? "local" : "wallet");
    if (minimizeWalletPanel) {
      setCollapsed((prev) => ({ ...prev, walletSender: true }));
    }
  };

  const connectWallet = async (providerId?: WalletProviderId) => {
    setWalletError("");
    const available = getInjectedWalletChoices();
    if (!available.length) {
      setWalletError("No injected wallet found. Install/use MetaMask, Rabby, or compatible wallet.");
      return;
    }
    if (!providerId && available.length > 1) {
      setWalletChooserOpen(true);
      return;
    }
    try {
      setWalletConnectLoading(true);
      const selectedProvider = getWalletChoice(providerId);
      if (!selectedProvider) throw new Error("Selected wallet provider is not available.");
      const walletClient = createWalletClient({
        transport: custom(selectedProvider.provider as any)
      });
      const addresses = (await walletClient.requestAddresses())
        .map(normalizeAddress)
        .filter(Boolean);
      if (!addresses.length) throw new Error("Wallet did not return an address.");
      setWalletProviderId(selectedProvider.id);
      setWalletProviderLabel(selectedProvider.label);
      setWalletAccounts(addresses);
      setWalletAccount((prev) => (prev && addresses.includes(prev) ? prev : addresses[0]));
      setWriteMode("wallet");
      setWalletChooserOpen(false);
    } catch (error) {
      setWalletError(error instanceof Error ? error.message : "Wallet connection failed.");
    } finally {
      setWalletConnectLoading(false);
    }
  };

  const exportWorkspace = () => {
    const payload = {
      exportedAt: new Date().toISOString(),
      rpcUrl,
      contracts: contracts.map((contract) => ({
        name: contract.name,
        address: contract.address,
        abi: contract.abi
      }))
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json"
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    a.href = url;
    a.download = `localethscan-workspace-${timestamp}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const runRead = async (contract: ContractEntry, fn: AbiFunction) => {
    const signature = getFunctionSignature(fn);
    setContractState(contract.id, (prev) => ({ ...prev, readResults: { ...prev.readResults, [signature]: { loading: true } } }));
    try {
      if (!client) throw new Error(rpcUrlError ?? "Enter a valid RPC endpoint.");
      const result = await (client as any).readContract({
        address: contract.address as Address,
        abi: contract.abi,
        functionName: fn.name,
        args: getArgs(contract, fn)
      });
      setContractState(contract.id, (prev) => ({ ...prev, readResults: { ...prev.readResults, [signature]: { output: toPrintable(result) } } }));
    } catch (error) {
      setContractState(contract.id, (prev) => ({ ...prev, readResults: { ...prev.readResults, [signature]: { error: error instanceof Error ? error.message : "Read failed." } } }));
    }
  };

  const runWrite = async (contract: ContractEntry, fn: AbiFunction) => {
    const signature = getFunctionSignature(fn);
    setContractState(contract.id, (prev) => ({ ...prev, writeResults: { ...prev.writeResults, [signature]: { loading: true } } }));
    try {
      if (!client) throw new Error(rpcUrlError ?? "Enter a valid RPC endpoint.");
      const txData = encodeFunctionData({
        abi: contract.abi,
        functionName: fn.name,
        args: getArgs(contract, fn)
      });
      const txParams: Record<string, unknown> = {
        to: contract.address as Address,
        data: txData
      };
      if (fn.stateMutability === "payable") {
        const wei = (getContractState(contract.id).payableValueWei[signature] ?? "").trim();
        if (wei) txParams.value = toHex(BigInt(wei));
      }
      let txHash: Hex;
      if (effectiveWriteMode === "wallet") {
        const selectedProvider = getWalletChoice();
        if (!selectedProvider) throw new Error("Wallet is not connected. Click Connect wallet.");
        const walletClient = createWalletClient({
          transport: custom(selectedProvider.provider as any)
        });
        const addresses = (await walletClient.requestAddresses())
          .map(normalizeAddress)
          .filter(Boolean);
        if (!addresses.length) throw new Error("Wallet did not return an address.");
        setWalletProviderId(selectedProvider.id);
        setWalletProviderLabel(selectedProvider.label);
        setWalletAccounts(addresses);
        const selected = addresses.includes(walletAccount) ? walletAccount : addresses[0];
        if (!selected) throw new Error("No wallet account available.");
        setWalletAccount(selected);
        txHash = (await walletClient.request({
          method: "eth_sendTransaction",
          params: [
            {
              from: selected as Address,
              to: contract.address as Address,
              data: txData,
              ...(txParams.value ? { value: txParams.value as string } : {})
            }
          ]
        })) as Hex;
      } else {
        if (!fromAddress) throw new Error("No unlocked sender account selected.");
        txParams.from = fromAddress as Address;
        txHash = (await client.request({
          method: "eth_sendTransaction",
          params: [txParams]
        })) as Hex;
      }
      const receipt = await client.waitForTransactionReceipt({ hash: txHash });
      const decodedLogs = receipt.logs.map((log, index) => {
        try {
          const decoded = decodeEventLog({ abi: contract.abi, topics: log.topics as any, data: log.data, strict: false });
          return { index, logAddress: normalizeAddress(log.address), eventName: decoded.eventName, args: normalizeValue(decoded.args) };
        } catch {
          return { index, logAddress: normalizeAddress(log.address), eventName: null, topics: log.topics, data: log.data };
        }
      });
      const summary = {
        status: receipt.status,
        blockNumber: receipt.blockNumber.toString(),
        gasUsed: receipt.gasUsed.toString(),
        cumulativeGasUsed: receipt.cumulativeGasUsed.toString(),
        transactionIndex: receipt.transactionIndex
      };
      setContractState(contract.id, (prev) => ({
        ...prev,
        writeResults: { ...prev.writeResults, [signature]: { txHash, receiptSummary: toPrintable(summary), decodedLogs: toPrintable(decodedLogs) } }
      }));
    } catch (error) {
      setContractState(contract.id, (prev) => ({ ...prev, writeResults: { ...prev.writeResults, [signature]: { error: error instanceof Error ? error.message : "Write failed." } } }));
    }
  };

  const decodeRawLogFromTxHash = async (contract: ContractEntry) => {
    try {
      if (!client) throw new Error(rpcUrlError ?? "Enter a valid RPC endpoint.");
      const state = getContractState(contract.id);
      const txHash = state.rawTxHash.trim() as Hex;
      if (!txHash || !txHash.startsWith("0x")) {
        throw new Error("Enter a valid transaction hash.");
      }
      const receipt = await client.getTransactionReceipt({ hash: txHash });
      const decodedLogs = receipt.logs.map((log, index) => {
        try {
          const decoded = decodeEventLog({
            abi: contract.abi,
            topics: log.topics as any,
            data: log.data,
            strict: false
          });
          return {
            index,
            logAddress: normalizeAddress(log.address),
            eventName: decoded.eventName,
            args: normalizeValue(decoded.args)
          };
        } catch {
          return {
            index,
            logAddress: normalizeAddress(log.address),
            eventName: null,
            topics: log.topics,
            data: log.data
          };
        }
      });
      setContractState(contract.id, (prev) => ({
        ...prev,
        rawDecoded: toPrintable({
          txHash,
          status: receipt.status,
          blockNumber: receipt.blockNumber.toString(),
          logs: decodedLogs
        })
      }));
    } catch (error) {
      setContractState(contract.id, (prev) => ({
        ...prev,
        rawDecoded: `Decode from tx hash failed: ${
          error instanceof Error ? error.message : "Unknown error."
        }`
      }));
    }
  };

  const decodeRawLog = (contract: ContractEntry) => {
    try {
      const state = getContractState(contract.id);
      const decoded = decodeEventLog({ abi: contract.abi, topics: parseTopicsInput(state.rawTopics) as any, data: state.rawData as Hex, strict: false });
      setContractState(contract.id, (prev) => ({ ...prev, rawDecoded: toPrintable({ eventName: decoded.eventName, args: decoded.args }) }));
    } catch (error) {
      setContractState(contract.id, (prev) => ({ ...prev, rawDecoded: `Decode failed: ${error instanceof Error ? error.message : "Unknown error."}` }));
    }
  };

  const copyAddress = async (address: string) => {
    try {
      await navigator.clipboard.writeText(address);
      setCopiedAddress(address);
      window.setTimeout(() => setCopiedAddress((prev) => (prev === address ? "" : prev)), 1000);
    } catch {
      setCopiedAddress("");
    }
  };

  return (
    <div className="app">
      <header className="pageHeader">
        <div>
          <h1>localethscan</h1>
        </div>
        <div className="row wrap">
          <button className="secondaryButton" onClick={exportWorkspace}>
            Export Workspace JSON
          </button>
          <button className="secondaryButton" onClick={() => setDarkMode((prev) => !prev)}>
            {darkMode ? "Light mode" : "Dark mode"}
          </button>
        </div>
      </header>

      <section className="zoneShell rpcZone">
        <div className="zoneHeader">
          <h2>RPC</h2>
        </div>
        <section className="panel controlPanel rpcPanel">
          <div className="panelHeader">
            <h3>RPC Endpoint</h3>
            <button
              className="secondaryButton"
              onClick={() => toggleCollapsed("rpc")}
              aria-label={isCollapsed("rpc") ? "Expand RPC panel" : "Collapse RPC panel"}
              title={isCollapsed("rpc") ? "Expand RPC panel" : "Collapse RPC panel"}
            >
              {isCollapsed("rpc") ? "+" : "-"}
            </button>
          </div>
          {!isCollapsed("rpc") ? (
            <>
              <div className="rpcInputRow">
                <input
                  value={rpcInputDraft}
                  onChange={(e) => setRpcInputDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      applyAndCheckRpc();
                    }
                  }}
                  placeholder={DEFAULT_RPC}
                />
                <button onClick={applyRpcDraft}>Apply</button>
                <button className="secondaryButton" onClick={applyAndCheckRpc}>
                  Check
                </button>
              </div>
              {rpcUrlError ? <div className="errorBox">{rpcUrlError}</div> : null}
              <div className="status rpcStatusGrid">
                {chainStatus.connected ? (
                  <>
                    <span className="statusPill ok">Connected</span>
                    <span className="statusPill">Chain ID: {chainStatus.chainId}</span>
                    <span className="statusPill">Latest block: {chainStatus.latestBlock?.toString()}</span>
                  </>
                ) : (
                  <>
                    <span className="statusPill error">Disconnected</span>
                    <span className="statusPill">{chainStatus.error ?? "No response from RPC."}</span>
                  </>
                )}
              </div>
            </>
          ) : null}
        </section>
      </section>

      <section className="zoneShell controlsZone">
        <div className="zoneHeader">
          <h2>Workspace Controls</h2>
        </div>
        <div className="controlDeck">
          <section className="panel controlPanel managerPanel">
            <div className="panelHeader">
              <h3>Contract Manager</h3>
              <button
                className="secondaryButton"
                onClick={() => toggleCollapsed("manager")}
                aria-label={isCollapsed("manager") ? "Expand contract manager" : "Collapse contract manager"}
                title={isCollapsed("manager") ? "Expand contract manager" : "Collapse contract manager"}
              >
                {isCollapsed("manager") ? "+" : "-"}
              </button>
            </div>
            {!isCollapsed("manager") ? (
              <>
                <div className="innerPanel managerPane">
                  <h4 className="controlSubhead">Add Single Contract</h4>
                  <div className="managerFieldGrid">
                    <div>
                      <label>Contract name</label>
                      <input value={contractNameInput} onChange={(e) => setContractNameInput(e.target.value)} placeholder="my-contract" />
                    </div>
                    <div>
                      <label>Contract address (stored lowercase)</label>
                      <input value={contractAddressInput} onChange={(e) => setContractAddressInput(normalizeAddress(e.target.value))} placeholder="0x..." />
                    </div>
                  </div>
                  <label>ABI JSON</label>
                  <textarea value={abiTextInput} onChange={(e) => setAbiTextInput(e.target.value)} placeholder="Paste ABI array (or object with abi)" />
                  <div className="row wrap managerActionRow">
                    <input type="file" accept=".json,application/json" onChange={onAbiFilePick} />
                    <button onClick={addSingleContract}>Add Contract</button>
                  </div>
                </div>

                <div className="innerPanel managerPane">
                  <h4 className="controlSubhead">Bulk Import</h4>
                  <label>Contracts JSON files (multi-select)</label>
                  <input type="file" accept=".json,application/json" multiple onChange={onImportFiles} />
                  <small className="hint">Supported: {`{name?, address, abi}`}, {`{contracts:[...]}`}, or array of contract objects.</small>
                </div>

                {managerError ? <div className="errorBox">{managerError}</div> : null}
                {managerMessage ? <div className="okBox">{managerMessage}</div> : null}
              </>
            ) : null}
          </section>

          <section className="panel controlPanel senderPanel">
            <div className="panelHeader">
              <h3>Write Sender</h3>
              <button
                className="secondaryButton"
                onClick={() => toggleCollapsed("sender")}
                aria-label={isCollapsed("sender") ? "Expand write sender" : "Collapse write sender"}
                title={isCollapsed("sender") ? "Expand write sender" : "Collapse write sender"}
              >
                {isCollapsed("sender") ? "+" : "-"}
              </button>
            </div>
            {!isCollapsed("sender") ? (
              <>
                <span className="hint">
                  {hasRpcAccounts
                    ? "Unlocked RPC accounts detected. Use local mode for Anvil/Hardhat writes."
                    : "No unlocked RPC accounts detected. Wallet mode is active for live/testnet writes."}
                </span>
                <label>Write mode</label>
                <div className="modeToggleGroup" role="tablist" aria-label="Write mode">
                  <button
                    type="button"
                    className={`modeToggle ${effectiveWriteMode === "local" ? "active" : ""}`}
                    aria-pressed={effectiveWriteMode === "local"}
                    onClick={() => setWriteMode("local")}
                    disabled={!hasRpcAccounts}
                    title={!hasRpcAccounts ? "Current RPC has no unlocked accounts." : "Use eth_accounts sender"}
                  >
                    Local unlocked
                  </button>
                  <button
                    type="button"
                    className={`modeToggle ${effectiveWriteMode === "wallet" ? "active" : ""}`}
                    aria-pressed={effectiveWriteMode === "wallet"}
                    onClick={() => setWriteMode("wallet")}
                  >
                    Wallet
                  </button>
                </div>

                {hasRpcAccounts ? (
                  <>
                    <label>Local sender (`eth_accounts` from current RPC)</label>
                    <select value={fromAddress} onChange={(e) => setFromAddress(normalizeAddress(e.target.value))}>
                      <option value="">Select sender</option>
                      {accounts.map((account) => (
                        <option key={account} value={account}>
                          {account} ({senderBalances[account] ?? "..."} ETH)
                        </option>
                      ))}
                    </select>
                    <div className="row wrap senderActionRow">
                      <button
                        className="secondaryButton"
                        onClick={() => void copyAddress(fromAddress)}
                        disabled={!fromAddress}
                      >
                        {copiedAddress === fromAddress && fromAddress ? "Copied" : "Copy local sender"}
                      </button>
                    </div>
                  </>
                ) : (
                  <span className="hint">Current RPC returned no unlocked addresses via `eth_accounts`.</span>
                )}

                <div className="innerPanel walletPanel">
                  <div className="panelHeader">
                    <h3>Wallet Sender (Live/Testnet/Mainnet)</h3>
                    <button
                      className="secondaryButton"
                      onClick={() => toggleCollapsed("walletSender")}
                      aria-label={isCollapsed("walletSender") ? "Expand wallet sender" : "Collapse wallet sender"}
                      title={isCollapsed("walletSender") ? "Expand wallet sender" : "Collapse wallet sender"}
                    >
                      {isCollapsed("walletSender") ? "+" : "-"}
                    </button>
                  </div>
                  {!isCollapsed("walletSender") ? (
                    <>
                      <div className="row wrap">
                        <button
                          className="secondaryButton"
                          onClick={() => void connectWallet()}
                          disabled={walletConnectLoading}
                        >
                          {walletConnectLoading
                            ? "Connecting..."
                            : walletAccount
                              ? "Reconnect wallet"
                              : "Connect wallet"}
                        </button>
                        <button
                          className="secondaryButton"
                          onClick={() => clearWalletConnection(true)}
                          disabled={walletConnectLoading}
                        >
                          Disconnect + clear
                        </button>
                        <button
                          className="secondaryButton"
                          onClick={() => void copyAddress(walletAccount)}
                          disabled={!walletAccount}
                        >
                          {copiedAddress === walletAccount && walletAccount ? "Copied" : "Copy wallet address"}
                        </button>
                      </div>

                      {walletChoices.length > 1 ? <span className="hint">Choose which wallet to open:</span> : null}
                      {walletChooserOpen && walletChoices.length > 1 ? (
                        <div className="row wrap walletChoiceRow">
                          {walletChoices.map((choice) => (
                            <button
                              key={choice.id}
                              className="secondaryButton"
                              onClick={() => void connectWallet(choice.id)}
                              disabled={walletConnectLoading}
                            >
                              Open {choice.label}
                            </button>
                          ))}
                        </div>
                      ) : null}

                      {walletAccounts.length ? (
                        <>
                          <label>Connected wallet address</label>
                          <select value={walletAccount} onChange={(e) => setWalletAccount(normalizeAddress(e.target.value))}>
                            {walletAccounts.map((address) => (
                              <option key={address} value={address}>
                                {address}
                              </option>
                            ))}
                          </select>
                        </>
                      ) : (
                        <span className="hint">No wallet address connected yet.</span>
                      )}
                      <span className="hint">Wallet provider: {walletProviderLabel || "Not selected"}</span>
                      <span className="hint">
                        Wallet balance (via current RPC): {walletAccount ? `${walletBalance || "..."} ETH` : "-"}
                      </span>
                      {walletError ? <div className="errorBox">{walletError}</div> : null}
                    </>
                  ) : (
                    <span className="hint">Wallet sender minimized.</span>
                  )}
                </div>

                <div className="senderSummary">
                  <span className="hint">Active write sender</span>
                  <code>{activeSenderAddress || "None selected"}</code>
                  <span className="hint">
                    Source: {effectiveWriteMode === "wallet" ? "Wallet" : "Local unlocked RPC sender"}
                  </span>
                  <span className="hint">
                    Balance: {activeSenderAddress ? `${activeSenderBalance || "..."} ETH` : "-"}
                  </span>
                  {effectiveWriteMode === "wallet" && !walletAccount ? (
                    <span className="hint">Connect a wallet before sending write transactions.</span>
                  ) : null}
                  {effectiveWriteMode === "local" && !fromAddress ? (
                    <span className="hint">Pick a local unlocked sender before sending write transactions.</span>
                  ) : null}
                </div>
              </>
            ) : (
              <div className="senderSummary senderCollapsedSummary">
                <span className="hint">Active write sender</span>
                <code>{activeSenderAddress || "None selected"}</code>
                <div className="row wrap">
                  <button
                    className="secondaryButton"
                    onClick={() => void copyAddress(activeSenderAddress)}
                    disabled={!activeSenderAddress}
                  >
                    {copiedAddress === activeSenderAddress && activeSenderAddress ? "Copied" : "Copy active sender"}
                  </button>
                  <span className="hint">
                    Source: {effectiveWriteMode === "wallet" ? "Wallet" : "Local unlocked RPC sender"}
                  </span>
                  <span className="hint">
                    Balance: {activeSenderAddress ? `${activeSenderBalance || "..."} ETH` : "-"}
                  </span>
                </div>
              </div>
            )}
          </section>
        </div>
      </section>

      <section className="zoneShell deployedZone">
        <div className="zoneHeader">
          <h2>Deployed Contracts</h2>
        </div>

        {contracts.length === 0 ? <section className="panel contractPanel"><p>No contracts loaded yet. Add one in Contract Manager.</p></section> : null}

        {contracts.map((contract) => {
        const state = getContractState(contract.id);
        const functions = contract.abi.filter((item) => item.type === "function") as AbiFunction[];
        const reads = functions.filter((fn) => fn.stateMutability === "view" || fn.stateMutability === "pure");
        const writes = functions.filter((fn) => fn.stateMutability !== "view" && fn.stateMutability !== "pure");
        const cKey = `c:${contract.id}`;
        const rKey = `${cKey}:read`;
        const wKey = `${cKey}:write`;
        const dKey = `${cKey}:decode`;
        const openReadCount = reads.reduce(
          (count, fn) => count + (isCollapsed(`${rKey}:${getFunctionSignature(fn)}`, true) ? 0 : 1),
          0
        );
        const openWriteCount = writes.reduce(
          (count, fn) => count + (isCollapsed(`${wKey}:${getFunctionSignature(fn)}`, true) ? 0 : 1),
          0
        );

        return (
          <section className="panel contractPanel" key={contract.id}>
            <div className="panelHeader contractHeader">
              <div className="contractIdentity">
                <h2>{contract.name}</h2>
                <div className="contractMeta">
                  <code>{contract.address}</code>
                  <span className="hint">ABI functions: {functions.length}</span>
                </div>
              </div>
              <div className="row wrap contractActions">
                <button className="secondaryButton" onClick={() => void copyAddress(contract.address)}>
                  {copiedAddress === contract.address ? "Copied" : "Copy Address"}
                </button>
                <button
                  className="dangerButton iconDangerButton"
                  onClick={() => requestRemoveContract(contract)}
                  aria-label={`Remove ${contract.name}`}
                  title="Remove contract"
                >
                  X
                </button>
                <button
                  className="secondaryButton"
                  onClick={() => toggleCollapsed(cKey)}
                  aria-label={isCollapsed(cKey) ? "Expand contract panel" : "Collapse contract panel"}
                  title={isCollapsed(cKey) ? "Expand contract panel" : "Collapse contract panel"}
                >
                  {isCollapsed(cKey) ? "+" : "-"}
                </button>
              </div>
            </div>

            {!isCollapsed(cKey) ? (
              <>
                <label>Rename contract</label>
                <input defaultValue={contract.name} onBlur={(e) => renameContract(contract.id, e.target.value)} />
                <div className="addressLine"><span>deployed:</span> <code>{contract.address}</code></div>

                <section className="innerPanel">
                  <div className="panelHeader">
                    <h3>Read Functions ({openReadCount}/{reads.length} open)</h3>
                    <div className="row wrap">
                      <button
                        className="secondaryButton"
                        onClick={() => toggleCollapsed(rKey)}
                        aria-label={isCollapsed(rKey) ? "Expand read function list" : "Collapse read function list"}
                        title={isCollapsed(rKey) ? "Expand read function list" : "Collapse read function list"}
                      >
                        {isCollapsed(rKey) ? "+" : "-"}
                      </button>
                    </div>
                  </div>
                  {!isCollapsed(rKey) ? (
                    <>
                      {reads.length === 0 ? <p>No view/pure functions found.</p> : null}
                      {reads.map((fn) => {
                        const sig = getFunctionSignature(fn);
                        const fnKey = `${rKey}:${sig}`;
                        const fnCollapsed = isCollapsed(fnKey, true);
                        const result = state.readResults[sig];
                        return (
                          <article className="fnCard" key={sig}>
                            <div className="fnHeader">
                              <button
                                type="button"
                                className="iconToggle"
                                onClick={() => toggleCollapsed(fnKey, true)}
                                aria-label={fnCollapsed ? `Expand ${sig}` : `Collapse ${sig}`}
                                title={fnCollapsed ? "Expand function" : "Collapse function"}
                              >
                                {fnCollapsed ? "+" : "-"}
                              </button>
                              <h4>{sig}</h4>
                            </div>
                            {!fnCollapsed ? (
                              <>
                                {(fn.inputs ?? []).map((input, index) => (
                                  <div key={`${sig}-r-${index}`}>
                                    <label>{input.name || `arg${index}`} ({input.type})</label>
                                    <input
                                      value={state.fnInputs[sig]?.[index] ?? ""}
                                      onChange={(e) => updateFunctionInput(contract.id, sig, index, e.target.value)}
                                      placeholder={input.type.endsWith("[]") || input.type.startsWith("tuple") ? "JSON value" : "value"}
                                    />
                                  </div>
                                ))}
                                <button onClick={() => void runRead(contract, fn)}>
                                  {result?.loading ? "Running..." : "Read"}
                                </button>
                                {result?.output ? <pre>{result.output}</pre> : null}
                                {result?.error ? <div className="errorBox">{result.error}</div> : null}
                              </>
                            ) : (
                              <>
                                {result?.error ? <div className="errorBox">Last run failed.</div> : null}
                                {result?.output ? <div className="hint">Last read output available.</div> : null}
                              </>
                            )}
                          </article>
                        );
                      })}
                    </>
                  ) : null}
                </section>

                <section className="innerPanel">
                  <div className="panelHeader">
                    <h3>Write Functions ({openWriteCount}/{writes.length} open)</h3>
                    <div className="row wrap">
                      <button
                        className="secondaryButton"
                        onClick={() => toggleCollapsed(wKey)}
                        aria-label={isCollapsed(wKey) ? "Expand write function list" : "Collapse write function list"}
                        title={isCollapsed(wKey) ? "Expand write function list" : "Collapse write function list"}
                      >
                        {isCollapsed(wKey) ? "+" : "-"}
                      </button>
                    </div>
                  </div>
                  {!isCollapsed(wKey) ? (
                    <>
                      {writes.length === 0 ? <p>No state-changing functions found.</p> : null}
                      {writes.map((fn) => {
                        const sig = getFunctionSignature(fn);
                        const fnKey = `${wKey}:${sig}`;
                        const fnCollapsed = isCollapsed(fnKey, true);
                        const result = state.writeResults[sig];
                        return (
                          <article className="fnCard" key={sig}>
                            <div className="fnHeader">
                              <button
                                type="button"
                                className="iconToggle"
                                onClick={() => toggleCollapsed(fnKey, true)}
                                aria-label={fnCollapsed ? `Expand ${sig}` : `Collapse ${sig}`}
                                title={fnCollapsed ? "Expand function" : "Collapse function"}
                              >
                                {fnCollapsed ? "+" : "-"}
                              </button>
                              <h4>{sig}</h4>
                            </div>
                            {!fnCollapsed ? (
                              <>
                                <div className="mutability">stateMutability: <strong>{fn.stateMutability}</strong></div>
                                {(fn.inputs ?? []).map((input, index) => (
                                  <div key={`${sig}-w-${index}`}>
                                    <label>{input.name || `arg${index}`} ({input.type})</label>
                                    {isExpandableTuple(input) ? (
                                      <div className="tupleEditor">
                                        {collectTupleFields(
                                          input,
                                          input.name || `arg${index}`
                                        ).map((field) => (
                                          <div key={`${sig}-tuple-${index}-${field.pathText}`}>
                                            <label>
                                              {field.label} ({field.param.type})
                                            </label>
                                            <input
                                              value={
                                                state.tupleDrafts[sig]?.[
                                                  `${index}:${field.pathText}`
                                                ] ?? ""
                                              }
                                              onChange={(e) =>
                                                updateTupleDraftInput(
                                                  contract.id,
                                                  sig,
                                                  index,
                                                  input,
                                                  field.pathText,
                                                  e.target.value
                                                )
                                              }
                                              placeholder={
                                                field.param.type.endsWith("[]")
                                                  ? "JSON array"
                                                  : "value"
                                              }
                                            />
                                          </div>
                                        ))}
                                      </div>
                                    ) : (
                                      <input
                                        value={state.fnInputs[sig]?.[index] ?? ""}
                                        onChange={(e) =>
                                          updateFunctionInput(
                                            contract.id,
                                            sig,
                                            index,
                                            e.target.value
                                          )
                                        }
                                        placeholder={
                                          input.type.endsWith("[]") ||
                                          input.type.startsWith("tuple")
                                            ? "JSON value"
                                            : "value"
                                        }
                                      />
                                    )}
                                  </div>
                                ))}
                                {fn.stateMutability === "payable" ? (
                                  <div>
                                    <label>Value (wei)</label>
                                    <input
                                      value={state.payableValueWei[sig] ?? ""}
                                      onChange={(e) => setContractState(contract.id, (prev) => ({ ...prev, payableValueWei: { ...prev.payableValueWei, [sig]: e.target.value } }))}
                                      placeholder="0"
                                    />
                                  </div>
                                ) : null}
                                <button onClick={() => void runWrite(contract, fn)}>{result?.loading ? "Sending..." : "Write"}</button>
                                {result?.txHash ? (
                                  <div className="txBox">
                                    <div className="addressLine"><span>tx hash:</span> <code>{result.txHash}</code></div>
                                    <label>Receipt Summary</label>
                                    <pre>{result.receiptSummary}</pre>
                                    <label>Decoded Logs</label>
                                    <pre>{result.decodedLogs}</pre>
                                  </div>
                                ) : null}
                                {result?.error ? <div className="errorBox">{result.error}</div> : null}
                              </>
                            ) : (
                              <>
                                {result?.error ? <div className="errorBox">Last write failed.</div> : null}
                                {result?.txHash ? <div className="hint">Last tx hash saved.</div> : null}
                              </>
                            )}
                          </article>
                        );
                      })}
                    </>
                  ) : null}
                </section>

                <section className="innerPanel">
                  <div className="panelHeader">
                    <h3>Decode Raw Log</h3>
                    <button
                      className="secondaryButton"
                      onClick={() => toggleCollapsed(dKey)}
                      aria-label={isCollapsed(dKey) ? "Expand decode log panel" : "Collapse decode log panel"}
                      title={isCollapsed(dKey) ? "Expand decode log panel" : "Collapse decode log panel"}
                    >
                      {isCollapsed(dKey) ? "+" : "-"}
                    </button>
                  </div>
                  {!isCollapsed(dKey) ? (
                    <>
                      <label>Topics (JSON array or comma/newline separated)</label>
                      <textarea value={state.rawTopics} onChange={(e) => setContractState(contract.id, (prev) => ({ ...prev, rawTopics: e.target.value }))} placeholder='["0xddf252ad...", "0x000..."]' />
                      <label>Data</label>
                      <input value={state.rawData} onChange={(e) => setContractState(contract.id, (prev) => ({ ...prev, rawData: e.target.value }))} placeholder="0x..." />
                      <div className="row wrap">
                        <button onClick={() => decodeRawLog(contract)}>Decode topics+data</button>
                      </div>
                      <label>Or decode from transaction hash</label>
                      <input
                        value={state.rawTxHash}
                        onChange={(e) =>
                          setContractState(contract.id, (prev) => ({
                            ...prev,
                            rawTxHash: e.target.value
                          }))
                        }
                        placeholder="0x transaction hash"
                      />
                      <button
                        className="secondaryButton"
                        onClick={() => void decodeRawLogFromTxHash(contract)}
                      >
                        Decode from tx hash
                      </button>
                      {state.rawDecoded ? <pre>{state.rawDecoded}</pre> : null}
                    </>
                  ) : null}
                </section>
              </>
            ) : null}
          </section>
        );
      })}
      </section>
    </div>
  );
}
