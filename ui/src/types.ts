import type { Abi, AbiParameter } from "viem";

export type AbiFunction = Extract<Abi[number], { type: "function" }>;
export type ChainStatus = { connected: boolean; chainId?: number; latestBlock?: bigint; error?: string };
export type FunctionResult = { loading?: boolean; output?: string; error?: string };
export type WriteResult = {
  loading?: boolean;
  txHash?: string;
  receiptSummary?: string;
  decodedLogs?: string;
  error?: string;
};
export type ContractEntry = { id: string; name: string; address: string; abiText: string; abi: Abi };
export type WalletProviderId = string;
export type Eip6963ProviderInfo = {
  uuid: string;
  name: string;
  icon: string;
  rdns: string;
};
export type InjectedProvider = {
  request: (args: { method: string; params?: unknown[] | object }) => Promise<unknown>;
  providers?: InjectedProvider[];
  isMetaMask?: boolean;
  isRabby?: boolean;
  isZerion?: boolean;
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
  providerInfo?: Partial<Eip6963ProviderInfo>;
};
export type Eip6963ProviderDetail = {
  info: Eip6963ProviderInfo;
  provider: InjectedProvider;
};
export type WalletProviderChoice = {
  id: WalletProviderId;
  label: string;
  provider: InjectedProvider;
};
export type RpcPreset = {
  id: string;
  label: string;
  url: string;
};
export type ContractUI = {
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
export type TupleField = {
  path: number[];
  pathText: string;
  label: string;
  param: AbiParameter;
};
