import { CUSTOM_RPC_PRESET_ID, DEFAULT_RPC, RPC_PRESET_OPTIONS } from "../config";
import type { ChainStatus } from "../types";

type RpcHeaderProps = {
  selectedRpcPresetId: string;
  selectRpcPreset: (presetId: string) => void;
  rpcInputDraft: string;
  setRpcInputDraft: (value: string) => void;
  applyRpcDraft: () => string;
  applyAndCheckRpc: () => void;
  chainStatus: ChainStatus;
  rpcUrlError: string | null;
  exportWorkspace: () => void;
  darkMode: boolean;
  toggleDarkMode: () => void;
};

export function RpcHeader({
  selectedRpcPresetId,
  selectRpcPreset,
  rpcInputDraft,
  setRpcInputDraft,
  applyRpcDraft,
  applyAndCheckRpc,
  chainStatus,
  rpcUrlError,
  exportWorkspace,
  darkMode,
  toggleDarkMode
}: RpcHeaderProps) {
  return (
    <header className="pageHeader">
      <h1 className="appTitle">localethscan</h1>

      <section className="rpcInline" aria-label="RPC endpoint and status">
        <div className="rpcPresetRow">
          <label className="rpcPresetLabel" htmlFor="rpc-preset-select">
            Preset
          </label>
          <select id="rpc-preset-select" value={selectedRpcPresetId} onChange={(e) => selectRpcPreset(e.target.value)}>
            {RPC_PRESET_OPTIONS.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
            <option value={CUSTOM_RPC_PRESET_ID}>Custom / manual</option>
          </select>
        </div>
        <div className="rpcInlineRow">
          <span className="rpcInlineLabel">RPC</span>
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
          <button className="secondaryButton" onClick={applyRpcDraft}>
            Apply
          </button>
          <button className="secondaryButton" onClick={applyAndCheckRpc}>
            Check
          </button>
        </div>
        <div className="hint">Choose a preset from the repo `.env` or paste any custom RPC URL, then use Apply or Check.</div>
        <div className="status rpcInlineStatus">
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
        {rpcUrlError ? <div className="errorBox rpcInlineError">{rpcUrlError}</div> : null}
      </section>

      <div className="row wrap headerActions">
        <button className="secondaryButton" onClick={exportWorkspace}>
          Export Workspace JSON
        </button>
        <button className="secondaryButton" onClick={toggleDarkMode}>
          {darkMode ? "Light mode" : "Dark mode"}
        </button>
      </div>
    </header>
  );
}
