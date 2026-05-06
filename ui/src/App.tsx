import { useEffect, useMemo, useState } from "react";
import {
  createWalletClient,
  custom,
  createPublicClient,
  decodeEventLog,
  encodeFunctionData,
  http,
  toHex
} from "viem";
import type { AbiParameter, Address, Hex } from "viem";
import {
  buildTupleValueFromDraft,
  collectTupleFields,
  formatEthBalance,
  getFunctionSignature,
  isAddressLike,
  isExpandableTuple,
  normalizeAddress,
  normalizeValue,
  parseAbiText,
  parseArgFromText,
  parseTopicsInput,
  toPrintable
} from "./abi-utils";
import { CUSTOM_RPC_PRESET_ID, RPC_PRESET_OPTIONS, STORAGE_KEY } from "./config";
import { getRpcUrlError, redactRpcUrlForPrivacy } from "./rpc";
import { emptyUI, loadSession, parseImportFile, toId } from "./session";
import type {
  AbiFunction,
  ChainStatus,
  ContractEntry,
  ContractUI,
  Eip6963ProviderDetail,
  WalletProviderChoice,
  WalletProviderId
} from "./types";
import { getInjectedWalletChoices, getInjectedWalletFingerprint, parseChainId, requestInjectedWalletChainId } from "./wallets";
import { ContractManagerPanel } from "./components/ContractManagerPanel";
import { RpcHeader } from "./components/RpcHeader";
import { WriteSenderPanel } from "./components/WriteSenderPanel";

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
  const [walletTargetProviderId, setWalletTargetProviderId] = useState<WalletProviderId | "">("");
  const [walletProviderLabel, setWalletProviderLabel] = useState("");
  const [walletAccounts, setWalletAccounts] = useState<string[]>([]);
  const [walletConnectLoading, setWalletConnectLoading] = useState(false);
  const [walletAccount, setWalletAccount] = useState("");
  const [walletBalance, setWalletBalance] = useState("");
  const [walletChainId, setWalletChainId] = useState<number | null>(null);
  const [walletError, setWalletError] = useState("");
  const [announcedWalletProviders, setAnnouncedWalletProviders] = useState<Eip6963ProviderDetail[]>([]);
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

  useEffect(() => {
    if (typeof window === "undefined") return;

    const onAnnounceProvider = (event: Event) => {
      const detail = (event as CustomEvent<Eip6963ProviderDetail>).detail;
      if (!detail?.provider || typeof detail.provider.request !== "function" || !detail.info) return;

      setAnnouncedWalletProviders((previous) => {
        const fingerprint = getInjectedWalletFingerprint(detail.provider, detail.info);
        if (!fingerprint) {
          return previous.some((item) => item.provider === detail.provider) ? previous : [...previous, detail];
        }

        const existingIndex = previous.findIndex(
          (item) => getInjectedWalletFingerprint(item.provider, item.info) === fingerprint
        );
        if (existingIndex < 0) return [...previous, detail];

        const existing = previous[existingIndex];
        if (
          existing.provider === detail.provider &&
          existing.info.uuid === detail.info.uuid &&
          existing.info.name === detail.info.name &&
          existing.info.rdns === detail.info.rdns
        ) {
          return previous;
        }

        const next = [...previous];
        next[existingIndex] = detail;
        return next;
      });
    };

    window.addEventListener("eip6963:announceProvider", onAnnounceProvider as EventListener);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    return () => window.removeEventListener("eip6963:announceProvider", onAnnounceProvider as EventListener);
  }, []);

  const rpcUrlError = useMemo(() => getRpcUrlError(rpcUrl), [rpcUrl]);
  const selectedRpcPresetId = useMemo(() => {
    const trimmedDraft = rpcInputDraft.trim();
    return RPC_PRESET_OPTIONS.find((option) => option.url.trim() === trimmedDraft)?.id ?? CUSTOM_RPC_PRESET_ID;
  }, [rpcInputDraft]);
  const client = useMemo(
    () => (rpcUrlError ? null : createPublicClient({ transport: http(rpcUrl.trim()) })),
    [rpcUrl, rpcUrlError]
  );
  const walletChoices = useMemo(() => getInjectedWalletChoices(announcedWalletProviders), [announcedWalletProviders]);
  const walletNetworkWarning = useMemo(() => {
    if (!walletAccount || walletChainId == null || !chainStatus.connected || chainStatus.chainId == null) return "";
    if (walletChainId === chainStatus.chainId) return "";
    return `Wallet network mismatch: connected wallet is on chain ${walletChainId}, but the current RPC is on chain ${chainStatus.chainId}. Switch the wallet network or change the RPC before sending a transaction.`;
  }, [walletAccount, walletChainId, chainStatus.connected, chainStatus.chainId]);
  const selectedWalletProviderId =
    (walletTargetProviderId && walletChoices.some((choice) => choice.id === walletTargetProviderId)
      ? walletTargetProviderId
      : walletProviderId && walletChoices.some((choice) => choice.id === walletProviderId)
        ? walletProviderId
        : walletChoices[0]?.id) ?? "";
  const hasRpcAccounts = accounts.length > 0;
  const effectiveWriteMode: "local" | "wallet" = hasRpcAccounts ? writeMode : "wallet";
  const activeSenderAddress = effectiveWriteMode === "wallet" ? walletAccount : fromAddress;
  const activeSenderBalance = effectiveWriteMode === "wallet" ? walletBalance : senderBalances[fromAddress] ?? "";

  useEffect(() => {
    document.body.dataset.theme = darkMode ? "dark" : "light";
  }, [darkMode]);

  useEffect(() => {
    const persistedRpcUrl = redactRpcUrlForPrivacy(rpcUrl);
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        rpcUrl: persistedRpcUrl,
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

  const selectRpcPreset = (presetId: string) => {
    if (presetId === CUSTOM_RPC_PRESET_ID) return;
    const preset = RPC_PRESET_OPTIONS.find((option) => option.id === presetId);
    if (!preset) return;
    setRpcInputDraft(preset.url);
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

  useEffect(() => {
    if (!walletProviderId) {
      setWalletChainId(null);
      return;
    }
    const selectedProvider = getWalletChoice(walletProviderId);
    if (!selectedProvider) {
      setWalletChainId(null);
      return;
    }

    let cancelled = false;
    const syncWalletChainId = async () => {
      const nextChainId = await requestInjectedWalletChainId(selectedProvider.provider);
      if (!cancelled) setWalletChainId(nextChainId);
    };

    const onChainChanged = (nextChainId: unknown) => {
      if (cancelled) return;
      setWalletChainId(parseChainId(nextChainId));
    };

    void syncWalletChainId();
    selectedProvider.provider.on?.("chainChanged", onChainChanged);
    return () => {
      cancelled = true;
      selectedProvider.provider.removeListener?.("chainChanged", onChainChanged);
    };
  }, [walletProviderId, walletChoices]);

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

  const getWalletChoice = (
    providerId?: WalletProviderId | "",
    choices: WalletProviderChoice[] = walletChoices
  ): WalletProviderChoice | undefined => {
    if (providerId) return choices.find((choice) => choice.id === providerId);
    return choices[0];
  };

  const clearWalletConnection = (minimizeWalletPanel = false) => {
    setWalletProviderId("");
    setWalletProviderLabel("");
    setWalletAccounts([]);
    setWalletAccount("");
    setWalletBalance("");
    setWalletChainId(null);
    setWalletError("");
    setWriteMode(hasRpcAccounts ? "local" : "wallet");
    if (minimizeWalletPanel) {
      setCollapsed((prev) => ({ ...prev, walletSender: true }));
    }
  };

  const connectWallet = async (providerId?: WalletProviderId) => {
    setWalletError("");
    const available = walletChoices;
    if (!available.length) {
      setWalletError("No injected wallet found. Install/use Zerion, MetaMask, Rabby, or another compatible wallet.");
      return;
    }
    try {
      setWalletConnectLoading(true);
      const fallbackProviderId =
        (selectedWalletProviderId && available.some((choice) => choice.id === selectedWalletProviderId)
          ? selectedWalletProviderId
          : "") ||
        (walletProviderId && available.some((choice) => choice.id === walletProviderId) ? walletProviderId : "") ||
        available[0].id;
      const selectedProvider = getWalletChoice(providerId ?? fallbackProviderId, available);
      if (!selectedProvider) throw new Error("Selected wallet provider is not available.");
      const walletClient = createWalletClient({
        transport: custom(selectedProvider.provider as any)
      });
      const addresses = (await walletClient.requestAddresses())
        .map(normalizeAddress)
        .filter(Boolean);
      const connectedWalletChainId = await requestInjectedWalletChainId(selectedProvider.provider);
      if (!addresses.length) throw new Error("Wallet did not return an address.");
      setWalletProviderId(selectedProvider.id);
      setWalletProviderLabel(selectedProvider.label);
      setWalletAccounts(addresses);
      setWalletAccount((prev) => (prev && addresses.includes(prev) ? prev : addresses[0]));
      setWalletChainId(connectedWalletChainId);
      setWalletTargetProviderId(selectedProvider.id);
      setWriteMode("wallet");
    } catch (error) {
      setWalletError(error instanceof Error ? error.message : "Wallet connection failed.");
    } finally {
      setWalletConnectLoading(false);
    }
  };

  const exportWorkspace = () => {
    const exportedRpcUrl = redactRpcUrlForPrivacy(rpcUrl);
    const payload = {
      exportedAt: new Date().toISOString(),
      rpcUrl: exportedRpcUrl,
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
        if (!walletProviderId || !walletAccount) {
          throw new Error("Wallet is disconnected. Click Connect wallet first.");
        }
        const selectedProvider = getWalletChoice(walletProviderId);
        if (!selectedProvider) {
          throw new Error("Connected wallet provider is no longer available. Reconnect wallet.");
        }
        const walletClient = createWalletClient({
          transport: custom(selectedProvider.provider as any)
        });
        const currentWalletChainId = await requestInjectedWalletChainId(selectedProvider.provider);
        setWalletChainId(currentWalletChainId);
        if (
          currentWalletChainId != null &&
          chainStatus.connected &&
          chainStatus.chainId != null &&
          currentWalletChainId !== chainStatus.chainId
        ) {
          const shouldContinue = window.confirm(
            `Wallet network mismatch.\n\nConnected wallet chain: ${currentWalletChainId}\nCurrent RPC chain: ${chainStatus.chainId}\n\nPress OK to continue anyway, or Cancel to stop this transaction.`
          );
          if (!shouldContinue) {
            throw new Error("Transaction cancelled because the connected wallet is on a different network than the current RPC.");
          }
        }
        txHash = (await walletClient.request({
          method: "eth_sendTransaction",
          params: [
            {
              from: walletAccount as Address,
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
      <RpcHeader
        selectedRpcPresetId={selectedRpcPresetId}
        selectRpcPreset={selectRpcPreset}
        rpcInputDraft={rpcInputDraft}
        setRpcInputDraft={setRpcInputDraft}
        applyRpcDraft={applyRpcDraft}
        applyAndCheckRpc={applyAndCheckRpc}
        chainStatus={chainStatus}
        rpcUrlError={rpcUrlError}
        exportWorkspace={exportWorkspace}
        darkMode={darkMode}
        toggleDarkMode={() => setDarkMode((prev) => !prev)}
      />
      <section className="zoneShell controlsZone">
        <div className="zoneHeader">
          <h2>Workspace Controls</h2>
        </div>
        <div className="controlDeck">
          <ContractManagerPanel
            collapsed={isCollapsed("manager")}
            toggleCollapsed={() => toggleCollapsed("manager")}
            contractNameInput={contractNameInput}
            setContractNameInput={setContractNameInput}
            contractAddressInput={contractAddressInput}
            setContractAddressInput={setContractAddressInput}
            abiTextInput={abiTextInput}
            setAbiTextInput={setAbiTextInput}
            onAbiFilePick={onAbiFilePick}
            onImportFiles={onImportFiles}
            addSingleContract={addSingleContract}
            managerError={managerError}
            managerMessage={managerMessage}
          />
          <WriteSenderPanel
            collapsed={isCollapsed("sender")}
            toggleCollapsed={() => toggleCollapsed("sender")}
            walletSenderCollapsed={isCollapsed("walletSender")}
            toggleWalletSenderCollapsed={() => toggleCollapsed("walletSender")}
            hasRpcAccounts={hasRpcAccounts}
            effectiveWriteMode={effectiveWriteMode}
            setWriteMode={setWriteMode}
            fromAddress={fromAddress}
            setFromAddress={setFromAddress}
            accounts={accounts}
            senderBalances={senderBalances}
            copyAddress={copyAddress}
            copiedAddress={copiedAddress}
            walletChoices={walletChoices}
            selectedWalletProviderId={selectedWalletProviderId}
            setWalletTargetProviderId={setWalletTargetProviderId}
            walletConnectLoading={walletConnectLoading}
            connectWallet={connectWallet}
            clearWalletConnection={clearWalletConnection}
            walletAccounts={walletAccounts}
            walletAccount={walletAccount}
            setWalletAccount={setWalletAccount}
            walletProviderLabel={walletProviderLabel}
            walletChainId={walletChainId}
            walletBalance={walletBalance}
            walletNetworkWarning={walletNetworkWarning}
            walletError={walletError}
            activeSenderAddress={activeSenderAddress}
            activeSenderBalance={activeSenderBalance}
          />
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
