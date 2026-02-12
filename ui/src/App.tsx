import { useEffect, useMemo, useState } from "react";
import {
  createPublicClient,
  decodeEventLog,
  encodeFunctionData,
  formatEther,
  http,
  isAddress,
  toHex
} from "viem";
import type { Abi, AbiParameter, Address, Hex } from "viem";

const STORAGE_KEY = "localethscan:mvp:v2";
const DEFAULT_RPC = "http://127.0.0.1:8545";

type AbiFunction = Extract<Abi[number], { type: "function" }>;
type ChainStatus = { connected: boolean; chainId?: number; latestBlock?: bigint; error?: string };
type FunctionResult = { loading?: boolean; output?: string; error?: string };
type WriteResult = { loading?: boolean; txHash?: string; receiptSummary?: string; decodedLogs?: string; error?: string };
type ContractEntry = { id: string; name: string; address: string; abiText: string; abi: Abi };
type ContractUI = {
  fnInputs: Record<string, string[]>;
  tupleDrafts: Record<string, Record<string, string>>;
  payableValueWei: Record<string, string>;
  readResults: Record<string, FunctionResult>;
  writeResults: Record<string, WriteResult>;
  rawTopics: string;
  rawData: string;
  rawDecoded: string;
};

function normalizeAddress(value: string): string {
  return value.trim().toLowerCase();
}

function isAddressLike(value: string): boolean {
  return isAddress(value as Address, { strict: false });
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
    const raw = localStorage.getItem(STORAGE_KEY);
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
  const [darkMode, setDarkMode] = useState(initial.darkMode);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(initial.collapsed);
  const [chainStatus, setChainStatus] = useState<ChainStatus>({ connected: false });
  const [accounts, setAccounts] = useState<string[]>([]);
  const [senderBalances, setSenderBalances] = useState<Record<string, string>>({});
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

  const client = useMemo(() => createPublicClient({ transport: http(rpcUrl) }), [rpcUrl]);

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

  const setContractState = (id: string, updater: (s: ContractUI) => ContractUI) => {
    setContractStates((prev) => ({ ...prev, [id]: updater(prev[id] ?? emptyUI()) }));
  };
  const getContractState = (id: string): ContractUI => contractStates[id] ?? emptyUI();
  const isCollapsed = (key: string) => Boolean(collapsed[key]);
  const toggleCollapsed = (key: string) => setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }));

  const checkChain = async () => {
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
    const id = window.setInterval(() => void checkChain(), 5000);
    return () => window.clearInterval(id);
  }, [client]);

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

  const runRead = async (contract: ContractEntry, fn: AbiFunction) => {
    const signature = getFunctionSignature(fn);
    setContractState(contract.id, (prev) => ({ ...prev, readResults: { ...prev.readResults, [signature]: { loading: true } } }));
    try {
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
      if (!fromAddress) throw new Error("No unlocked sender account selected.");
      const txParams: Record<string, unknown> = {
        from: fromAddress as Address,
        to: contract.address as Address,
        data: encodeFunctionData({ abi: contract.abi, functionName: fn.name, args: getArgs(contract, fn) })
      };
      if (fn.stateMutability === "payable") {
        const wei = (getContractState(contract.id).payableValueWei[signature] ?? "").trim();
        if (wei) txParams.value = toHex(BigInt(wei));
      }
      const txHash = (await client.request({ method: "eth_sendTransaction", params: [txParams] })) as Hex;
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
          <h1>localethscan MVP</h1>
          <p>Local-only contract read/write + log decode helper for Anvil-style RPCs.</p>
        </div>
        <button className="secondaryButton" onClick={() => setDarkMode((prev) => !prev)}>
          {darkMode ? "Light mode" : "Dark mode"}
        </button>
      </header>

      <section className="panel">
        <div className="panelHeader">
          <h2>RPC</h2>
          <button className="secondaryButton" onClick={() => toggleCollapsed("rpc")}>{isCollapsed("rpc") ? "Expand" : "Collapse"}</button>
        </div>
        {!isCollapsed("rpc") ? (
          <>
            <div className="row">
              <input value={rpcUrl} onChange={(e) => setRpcUrl(e.target.value)} placeholder={DEFAULT_RPC} />
              <button onClick={() => void checkChain()}>Check</button>
            </div>
            <div className="status">
              {chainStatus.connected ? (
                <>
                  <span className="ok">connected</span>
                  <span>chain id: {chainStatus.chainId}</span>
                  <span>latest block: {chainStatus.latestBlock?.toString()}</span>
                </>
              ) : (
                <>
                  <span className="error">disconnected</span>
                  <span>{chainStatus.error ?? "No response from RPC."}</span>
                </>
              )}
            </div>
          </>
        ) : null}
      </section>

      <section className="panel">
        <div className="panelHeader">
          <h2>Contract Manager</h2>
          <button className="secondaryButton" onClick={() => toggleCollapsed("manager")}>{isCollapsed("manager") ? "Expand" : "Collapse"}</button>
        </div>
        {!isCollapsed("manager") ? (
          <>
            <label>Contract name</label>
            <input value={contractNameInput} onChange={(e) => setContractNameInput(e.target.value)} placeholder="my-contract" />
            <label>Contract address (stored lowercase)</label>
            <input value={contractAddressInput} onChange={(e) => setContractAddressInput(normalizeAddress(e.target.value))} placeholder="0x..." />
            <label>ABI JSON</label>
            <textarea value={abiTextInput} onChange={(e) => setAbiTextInput(e.target.value)} placeholder="Paste ABI array (or object with abi)" />
            <div className="row wrap">
              <input type="file" accept=".json,application/json" onChange={onAbiFilePick} />
              <button onClick={addSingleContract}>Add Contract</button>
            </div>
            <label>Bulk import contracts JSON files (multi-select)</label>
            <input type="file" accept=".json,application/json" multiple onChange={onImportFiles} />
            <small className="hint">Supported: {`{name?, address, abi}`}, {`{contracts:[...]}`}, or array of contract objects.</small>
            {managerError ? <div className="errorBox">{managerError}</div> : null}
            {managerMessage ? <div className="okBox">{managerMessage}</div> : null}
          </>
        ) : null}
      </section>

      <section className="panel">
        <div className="panelHeader">
          <h2>Write Sender</h2>
          <button className="secondaryButton" onClick={() => toggleCollapsed("sender")}>{isCollapsed("sender") ? "Expand" : "Collapse"}</button>
        </div>
        {!isCollapsed("sender") ? (
          <>
            <label>From address (`eth_accounts` from current RPC)</label>
            <select value={fromAddress} onChange={(e) => setFromAddress(normalizeAddress(e.target.value))}>
              <option value="">Select sender</option>
              {accounts.map((account) => (
                <option key={account} value={account}>
                  {account} ({senderBalances[account] ?? "..."} ETH)
                </option>
              ))}
            </select>
            <div className="row wrap">
              <button
                className="secondaryButton"
                onClick={() => void copyAddress(fromAddress)}
                disabled={!fromAddress}
              >
                {copiedAddress === fromAddress && fromAddress ? "Copied" : "Copy selected"}
              </button>
              <span className="hint">
                Selected balance: {fromAddress ? `${senderBalances[fromAddress] ?? "..."} ETH` : "-"}
              </span>
            </div>
          </>
        ) : null}
      </section>

      {contracts.length === 0 ? <section className="panel"><p>No contracts loaded yet. Add one in Contract Manager.</p></section> : null}

      {contracts.map((contract) => {
        const state = getContractState(contract.id);
        const functions = contract.abi.filter((item) => item.type === "function") as AbiFunction[];
        const reads = functions.filter((fn) => fn.stateMutability === "view" || fn.stateMutability === "pure");
        const writes = functions.filter((fn) => fn.stateMutability !== "view" && fn.stateMutability !== "pure");
        const cKey = `c:${contract.id}`;
        const rKey = `${cKey}:read`;
        const wKey = `${cKey}:write`;
        const dKey = `${cKey}:decode`;

        return (
          <section className="panel" key={contract.id}>
            <div className="panelHeader">
              <h2>{contract.name}</h2>
              <div className="row">
                <button className="secondaryButton" onClick={() => void copyAddress(contract.address)}>Copy Address</button>
                <button className="secondaryButton" onClick={() => toggleCollapsed(cKey)}>{isCollapsed(cKey) ? "Expand" : "Collapse"}</button>
              </div>
            </div>

            {!isCollapsed(cKey) ? (
              <>
                <label>Rename contract</label>
                <input defaultValue={contract.name} onBlur={(e) => renameContract(contract.id, e.target.value)} />
                <div className="addressLine"><span>address:</span> <code>{contract.address}</code></div>
                <div className="hint">ABI functions: {functions.length}</div>
                <button className="dangerButton" onClick={() => removeContract(contract.id)}>Remove Contract</button>

                <section className="innerPanel">
                  <div className="panelHeader">
                    <h3>Read Functions</h3>
                    <button className="secondaryButton" onClick={() => toggleCollapsed(rKey)}>{isCollapsed(rKey) ? "Expand" : "Collapse"}</button>
                  </div>
                  {!isCollapsed(rKey) ? (
                    <>
                      {reads.length === 0 ? <p>No view/pure functions found.</p> : null}
                      {reads.map((fn) => {
                        const sig = getFunctionSignature(fn);
                        const result = state.readResults[sig];
                        return (
                          <article className="fnCard" key={sig}>
                            <h4>{sig}</h4>
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
                            <button onClick={() => void runRead(contract, fn)}>{result?.loading ? "Running..." : "Read"}</button>
                            {result?.output ? <pre>{result.output}</pre> : null}
                            {result?.error ? <div className="errorBox">{result.error}</div> : null}
                          </article>
                        );
                      })}
                    </>
                  ) : null}
                </section>

                <section className="innerPanel">
                  <div className="panelHeader">
                    <h3>Write Functions</h3>
                    <button className="secondaryButton" onClick={() => toggleCollapsed(wKey)}>{isCollapsed(wKey) ? "Expand" : "Collapse"}</button>
                  </div>
                  {!isCollapsed(wKey) ? (
                    <>
                      {writes.length === 0 ? <p>No state-changing functions found.</p> : null}
                      {writes.map((fn) => {
                        const sig = getFunctionSignature(fn);
                        const result = state.writeResults[sig];
                        return (
                          <article className="fnCard" key={sig}>
                            <h4>{sig}</h4>
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
                          </article>
                        );
                      })}
                    </>
                  ) : null}
                </section>

                <section className="innerPanel">
                  <div className="panelHeader">
                    <h3>Decode Raw Log</h3>
                    <button className="secondaryButton" onClick={() => toggleCollapsed(dKey)}>{isCollapsed(dKey) ? "Expand" : "Collapse"}</button>
                  </div>
                  {!isCollapsed(dKey) ? (
                    <>
                      <label>Topics (JSON array or comma/newline separated)</label>
                      <textarea value={state.rawTopics} onChange={(e) => setContractState(contract.id, (prev) => ({ ...prev, rawTopics: e.target.value }))} placeholder='["0xddf252ad...", "0x000..."]' />
                      <label>Data</label>
                      <input value={state.rawData} onChange={(e) => setContractState(contract.id, (prev) => ({ ...prev, rawData: e.target.value }))} placeholder="0x..." />
                      <button onClick={() => decodeRawLog(contract)}>Decode</button>
                      {state.rawDecoded ? <pre>{state.rawDecoded}</pre> : null}
                    </>
                  ) : null}
                </section>
              </>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}
