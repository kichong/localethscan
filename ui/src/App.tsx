import { useEffect, useMemo, useState } from "react";
import {
  createPublicClient,
  decodeEventLog,
  encodeFunctionData,
  http,
  isAddress,
  toHex
} from "viem";
import type { Abi, AbiParameter, Address, Hex } from "viem";

const STORAGE_KEY = "localethscan:mvp:v1";
const DEFAULT_RPC = "http://127.0.0.1:8545";

type AbiFunction = Extract<Abi[number], { type: "function" }>;

type ChainStatus = {
  connected: boolean;
  chainId?: number;
  latestBlock?: bigint;
  error?: string;
};

type FunctionResult = {
  loading?: boolean;
  output?: string;
  error?: string;
};

type WriteResult = {
  loading?: boolean;
  txHash?: string;
  receiptSummary?: string;
  decodedLogs?: string;
  error?: string;
};

type SessionState = {
  rpcUrl: string;
  contractAddress: string;
  abiText: string;
};

function loadSession(): SessionState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return { rpcUrl: DEFAULT_RPC, contractAddress: "", abiText: "" };
    }
    const parsed = JSON.parse(raw);
    return {
      rpcUrl: typeof parsed.rpcUrl === "string" ? parsed.rpcUrl : DEFAULT_RPC,
      contractAddress:
        typeof parsed.contractAddress === "string" ? parsed.contractAddress : "",
      abiText: typeof parsed.abiText === "string" ? parsed.abiText : ""
    };
  } catch {
    return { rpcUrl: DEFAULT_RPC, contractAddress: "", abiText: "" };
  }
}

function normalizeAddress(value: string): string {
  return value.trim().toLowerCase();
}

function isAddressLike(value: string): boolean {
  return isAddress(value as Address, { strict: false });
}

function toPrintable(value: unknown): string {
  const serialized = JSON.stringify(normalizeValue(value), null, 2);
  return serialized ?? String(value);
}

function normalizeValue(value: unknown): unknown {
  if (typeof value === "bigint") {
    return value.toString();
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalizeValue(item));
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).map(
      ([key, item]) => [key, normalizeValue(item)]
    );
    return Object.fromEntries(entries);
  }

  if (typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value)) {
    return normalizeAddress(value);
  }

  return value;
}

function parseAbiText(input: string): Abi {
  const parsed = JSON.parse(input);
  const maybeAbi = Array.isArray(parsed) ? parsed : parsed?.abi;
  if (!Array.isArray(maybeAbi)) {
    throw new Error("ABI must be a JSON array or an object with an `abi` array.");
  }
  return maybeAbi as Abi;
}

function getFunctionSignature(fn: AbiFunction): string {
  const paramTypes = (fn.inputs ?? []).map((item) => item.type).join(",");
  return `${fn.name}(${paramTypes})`;
}

function parseArgFromText(param: AbiParameter, rawValue: string): unknown {
  const trimmed = rawValue.trim();

  if (param.type.endsWith("[]") || param.type.startsWith("tuple")) {
    if (!trimmed) {
      throw new Error(
        `Input required for complex type ${param.type}. Use JSON format.`
      );
    }
    const jsonValue = JSON.parse(trimmed);
    return coerceAbiValue(param, jsonValue);
  }

  return coerceAbiValue(param, trimmed);
}

function coerceAbiValue(param: AbiParameter, value: unknown): unknown {
  const type = param.type;

  if (type.endsWith("[]")) {
    if (!Array.isArray(value)) {
      throw new Error(`Expected JSON array for type ${type}.`);
    }
    const childType = type.slice(0, -2);
    const childParam: AbiParameter = { ...param, type: childType };
    return value.map((item) => coerceAbiValue(childParam, item));
  }

  if (type.startsWith("tuple")) {
    const components = "components" in param ? param.components ?? [] : [];
    if (Array.isArray(value)) {
      return components.map((component, index) =>
        coerceAbiValue(component, value[index])
      );
    }
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      return components.map((component) =>
        coerceAbiValue(component, record[component.name])
      );
    }
    throw new Error(`Expected tuple JSON value for type ${type}.`);
  }

  if (type.startsWith("uint") || type.startsWith("int")) {
    if (typeof value !== "string" && typeof value !== "number") {
      throw new Error(`Expected numeric value for type ${type}.`);
    }
    return BigInt(value);
  }

  if (type === "bool") {
    if (typeof value === "boolean") {
      return value;
    }
    if (typeof value === "string") {
      if (value.toLowerCase() === "true") {
        return true;
      }
      if (value.toLowerCase() === "false") {
        return false;
      }
    }
    throw new Error(`Expected true/false for type ${type}.`);
  }

  if (type === "address") {
    if (typeof value !== "string" || !isAddressLike(value)) {
      throw new Error("Invalid address input.");
    }
    return normalizeAddress(value);
  }

  if (type.startsWith("bytes") || type === "string") {
    if (typeof value !== "string") {
      throw new Error(`Expected string for type ${type}.`);
    }
    return value;
  }

  return value;
}

function parseTopicsInput(input: string): Hex[] {
  const trimmed = input.trim();
  if (!trimmed) {
    return [];
  }
  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) {
      throw new Error("Topics JSON must be an array.");
    }
    return parsed as Hex[];
  }
  return trimmed
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean) as Hex[];
}

export default function App() {
  const initial = loadSession();
  const [rpcUrl, setRpcUrl] = useState(initial.rpcUrl);
  const [contractAddress, setContractAddress] = useState(
    normalizeAddress(initial.contractAddress)
  );
  const [abiText, setAbiText] = useState(initial.abiText);
  const [loadedAbi, setLoadedAbi] = useState<Abi | null>(null);
  const [abiLoadError, setAbiLoadError] = useState("");
  const [chainStatus, setChainStatus] = useState<ChainStatus>({
    connected: false
  });
  const [accounts, setAccounts] = useState<string[]>([]);
  const [fromAddress, setFromAddress] = useState("");

  const [fnInputs, setFnInputs] = useState<Record<string, string[]>>({});
  const [payableValueWei, setPayableValueWei] = useState<Record<string, string>>(
    {}
  );
  const [readResults, setReadResults] = useState<Record<string, FunctionResult>>(
    {}
  );
  const [writeResults, setWriteResults] = useState<Record<string, WriteResult>>(
    {}
  );

  const [rawTopics, setRawTopics] = useState("");
  const [rawData, setRawData] = useState("0x");
  const [rawDecoded, setRawDecoded] = useState("");

  const client = useMemo(
    () => createPublicClient({ transport: http(rpcUrl) }),
    [rpcUrl]
  );

  useEffect(() => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ rpcUrl, contractAddress, abiText })
    );
  }, [rpcUrl, contractAddress, abiText]);

  const loadContract = () => {
    try {
      const normalizedAddress = normalizeAddress(contractAddress);
      if (!isAddressLike(normalizedAddress)) {
        throw new Error("Contract address is invalid.");
      }
      const parsedAbi = parseAbiText(abiText);
      setContractAddress(normalizedAddress);
      setLoadedAbi(parsedAbi);
      setAbiLoadError("");
      setReadResults({});
      setWriteResults({});
      setRawDecoded("");
    } catch (error) {
      setLoadedAbi(null);
      setAbiLoadError(error instanceof Error ? error.message : "Failed to load ABI.");
    }
  };

  const checkChain = async () => {
    try {
      const [chainId, latestBlock, rpcAccounts] = await Promise.all([
        client.getChainId(),
        client.getBlockNumber(),
        client.request({ method: "eth_accounts", params: [] }) as Promise<string[]>
      ]);
      const normalizedAccounts = rpcAccounts.map((item) => normalizeAddress(item));
      setAccounts(normalizedAccounts);
      setFromAddress((prev) => {
        if (prev && normalizedAccounts.includes(prev)) {
          return prev;
        }
        return normalizedAccounts[0] ?? "";
      });
      setChainStatus({
        connected: true,
        chainId,
        latestBlock
      });
    } catch (error) {
      setChainStatus({
        connected: false,
        error: error instanceof Error ? error.message : "Connection failed."
      });
      setAccounts([]);
      setFromAddress("");
    }
  };

  useEffect(() => {
    void checkChain();
    const id = window.setInterval(() => {
      void checkChain();
    }, 5000);
    return () => window.clearInterval(id);
  }, [client]);

  const functions = useMemo(() => {
    if (!loadedAbi) {
      return [];
    }
    return loadedAbi.filter((item) => item.type === "function") as AbiFunction[];
  }, [loadedAbi]);

  const readFunctions = functions.filter(
    (fn) => fn.stateMutability === "view" || fn.stateMutability === "pure"
  );
  const writeFunctions = functions.filter(
    (fn) => fn.stateMutability !== "view" && fn.stateMutability !== "pure"
  );

  const getArgValues = (fn: AbiFunction): unknown[] => {
    const signature = getFunctionSignature(fn);
    const inputs = fnInputs[signature] ?? [];
    return (fn.inputs ?? []).map((input, idx) =>
      parseArgFromText(input, inputs[idx] ?? "")
    );
  };

  const updateFunctionInput = (
    signature: string,
    index: number,
    value: string
  ) => {
    setFnInputs((prev) => {
      const next = [...(prev[signature] ?? [])];
      next[index] = value;
      return { ...prev, [signature]: next };
    });
  };

  const runRead = async (fn: AbiFunction) => {
    const signature = getFunctionSignature(fn);
    setReadResults((prev) => ({ ...prev, [signature]: { loading: true } }));

    try {
      const args = getArgValues(fn);
      const result = await (client as any).readContract({
        address: contractAddress as Address,
        abi: loadedAbi as Abi,
        functionName: fn.name,
        args
      });
      setReadResults((prev) => ({
        ...prev,
        [signature]: { output: toPrintable(result) }
      }));
    } catch (error) {
      setReadResults((prev) => ({
        ...prev,
        [signature]: {
          error: error instanceof Error ? error.message : "Read call failed."
        }
      }));
    }
  };

  const runWrite = async (fn: AbiFunction) => {
    const signature = getFunctionSignature(fn);
    setWriteResults((prev) => ({ ...prev, [signature]: { loading: true } }));

    try {
      if (!fromAddress) {
        throw new Error(
          "No unlocked sender account available. Check `eth_accounts` on your RPC."
        );
      }

      const args = getArgValues(fn);
      const data = encodeFunctionData({
        abi: loadedAbi as Abi,
        functionName: fn.name,
        args
      });

      const txParams: Record<string, unknown> = {
        from: fromAddress as Address,
        to: contractAddress as Address,
        data
      };

      if (fn.stateMutability === "payable") {
        const valueText = (payableValueWei[signature] ?? "").trim();
        if (valueText) {
          txParams.value = toHex(BigInt(valueText));
        }
      }

      const txHash = (await client.request({
        method: "eth_sendTransaction",
        params: [txParams]
      })) as Hex;

      const receipt = await client.waitForTransactionReceipt({ hash: txHash });
      const decodedLogs = receipt.logs.map((log, index) => {
        try {
          const decoded = decodeEventLog({
            abi: loadedAbi as Abi,
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

      const summary = {
        status: receipt.status,
        blockNumber: receipt.blockNumber.toString(),
        gasUsed: receipt.gasUsed.toString(),
        cumulativeGasUsed: receipt.cumulativeGasUsed.toString(),
        transactionIndex: receipt.transactionIndex
      };

      setWriteResults((prev) => ({
        ...prev,
        [signature]: {
          txHash,
          receiptSummary: toPrintable(summary),
          decodedLogs: toPrintable(decodedLogs)
        }
      }));
    } catch (error) {
      setWriteResults((prev) => ({
        ...prev,
        [signature]: {
          error: error instanceof Error ? error.message : "Write call failed."
        }
      }));
    }
  };

  const decodeRawLog = () => {
    try {
      if (!loadedAbi) {
        throw new Error("Load ABI first.");
      }
      const topics = parseTopicsInput(rawTopics);
      const decoded = decodeEventLog({
        abi: loadedAbi,
        topics: topics as any,
        data: rawData as Hex,
        strict: false
      });
      setRawDecoded(
        toPrintable({
          eventName: decoded.eventName,
          args: decoded.args
        })
      );
    } catch (error) {
      setRawDecoded(
        `Decode failed: ${
          error instanceof Error ? error.message : "Unknown decode error."
        }`
      );
    }
  };

  const handleAbiFileUpload: React.ChangeEventHandler<HTMLInputElement> = (
    event
  ) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const text = typeof reader.result === "string" ? reader.result : "";
      setAbiText(text);
    };
    reader.readAsText(file);
  };

  return (
    <div className="app">
      <header>
        <h1>localethscan MVP</h1>
        <p>Local-only contract read/write + log decode helper for Anvil-style RPCs.</p>
      </header>

      <section className="panel">
        <h2>RPC</h2>
        <div className="row">
          <input
            value={rpcUrl}
            onChange={(event) => setRpcUrl(event.target.value)}
            placeholder={DEFAULT_RPC}
          />
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
      </section>

      <section className="panel">
        <h2>Contract + ABI</h2>
        <label>Contract address (stored lowercase)</label>
        <input
          value={contractAddress}
          onChange={(event) => setContractAddress(normalizeAddress(event.target.value))}
          placeholder="0x..."
        />

        <label>ABI JSON</label>
        <textarea
          value={abiText}
          onChange={(event) => setAbiText(event.target.value)}
          placeholder="Paste contract ABI array here"
        />

        <div className="row">
          <input type="file" accept=".json,application/json" onChange={handleAbiFileUpload} />
          <button onClick={loadContract}>Load Contract</button>
        </div>

        {abiLoadError ? <div className="errorBox">{abiLoadError}</div> : null}
        {loadedAbi ? (
          <div className="okBox">
            Loaded ABI with {functions.length} function(s) for {contractAddress}.
          </div>
        ) : null}
      </section>

      {loadedAbi ? (
        <>
          <section className="panel">
            <h2>Write Sender</h2>
            <label>From address (`eth_accounts` from current RPC)</label>
            <select
              value={fromAddress}
              onChange={(event) => setFromAddress(normalizeAddress(event.target.value))}
            >
              <option value="">Select sender</option>
              {accounts.map((account) => (
                <option key={account} value={account}>
                  {account}
                </option>
              ))}
            </select>
          </section>

          <div className="columns">
            <section className="panel">
              <h2>Read Functions</h2>
              {readFunctions.length === 0 ? <p>No view/pure functions found.</p> : null}
              {readFunctions.map((fn) => {
                const signature = getFunctionSignature(fn);
                const result = readResults[signature];
                return (
                  <article className="fnCard" key={signature}>
                    <h3>{signature}</h3>
                    {(fn.inputs ?? []).map((input, index) => (
                      <div key={`${signature}-read-${index}`}>
                        <label>
                          {input.name || `arg${index}`} ({input.type})
                        </label>
                        <input
                          value={fnInputs[signature]?.[index] ?? ""}
                          onChange={(event) =>
                            updateFunctionInput(signature, index, event.target.value)
                          }
                          placeholder={
                            input.type.endsWith("[]") || input.type.startsWith("tuple")
                              ? "JSON value"
                              : "value"
                          }
                        />
                      </div>
                    ))}
                    <button onClick={() => void runRead(fn)}>
                      {result?.loading ? "Running..." : "Read"}
                    </button>
                    {result?.output ? <pre>{result.output}</pre> : null}
                    {result?.error ? <div className="errorBox">{result.error}</div> : null}
                  </article>
                );
              })}
            </section>

            <section className="panel">
              <h2>Write Functions</h2>
              {writeFunctions.length === 0 ? <p>No state-changing functions found.</p> : null}
              {writeFunctions.map((fn) => {
                const signature = getFunctionSignature(fn);
                const result = writeResults[signature];
                return (
                  <article className="fnCard" key={signature}>
                    <h3>{signature}</h3>
                    <div className="mutability">
                      stateMutability: <strong>{fn.stateMutability}</strong>
                    </div>

                    {(fn.inputs ?? []).map((input, index) => (
                      <div key={`${signature}-write-${index}`}>
                        <label>
                          {input.name || `arg${index}`} ({input.type})
                        </label>
                        <input
                          value={fnInputs[signature]?.[index] ?? ""}
                          onChange={(event) =>
                            updateFunctionInput(signature, index, event.target.value)
                          }
                          placeholder={
                            input.type.endsWith("[]") || input.type.startsWith("tuple")
                              ? "JSON value"
                              : "value"
                          }
                        />
                      </div>
                    ))}

                    {fn.stateMutability === "payable" ? (
                      <div>
                        <label>Value (wei)</label>
                        <input
                          value={payableValueWei[signature] ?? ""}
                          onChange={(event) =>
                            setPayableValueWei((prev) => ({
                              ...prev,
                              [signature]: event.target.value
                            }))
                          }
                          placeholder="0"
                        />
                      </div>
                    ) : null}

                    <button onClick={() => void runWrite(fn)}>
                      {result?.loading ? "Sending..." : "Write"}
                    </button>

                    {result?.txHash ? (
                      <div className="txBox">
                        <div>tx hash: {result.txHash}</div>
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
            </section>
          </div>

          <section className="panel">
            <h2>Decode Raw Log</h2>
            <label>Topics (JSON array or comma/newline separated)</label>
            <textarea
              value={rawTopics}
              onChange={(event) => setRawTopics(event.target.value)}
              placeholder='["0xddf252ad...", "0x000..."]'
            />
            <label>Data</label>
            <input
              value={rawData}
              onChange={(event) => setRawData(event.target.value)}
              placeholder="0x..."
            />
            <button onClick={decodeRawLog}>Decode</button>
            {rawDecoded ? <pre>{rawDecoded}</pre> : null}
          </section>
        </>
      ) : null}
    </div>
  );
}
