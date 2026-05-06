import { normalizeAddress } from "../abi-utils";
import type { WalletProviderChoice, WalletProviderId } from "../types";

type WriteMode = "local" | "wallet";

type WriteSenderPanelProps = {
  collapsed: boolean;
  toggleCollapsed: () => void;
  walletSenderCollapsed: boolean;
  toggleWalletSenderCollapsed: () => void;
  hasRpcAccounts: boolean;
  effectiveWriteMode: WriteMode;
  setWriteMode: (mode: WriteMode) => void;
  fromAddress: string;
  setFromAddress: (address: string) => void;
  accounts: string[];
  senderBalances: Record<string, string>;
  copyAddress: (address: string) => Promise<void>;
  copiedAddress: string;
  walletChoices: WalletProviderChoice[];
  selectedWalletProviderId: WalletProviderId | "";
  setWalletTargetProviderId: (providerId: WalletProviderId | "") => void;
  walletConnectLoading: boolean;
  connectWallet: () => Promise<void>;
  clearWalletConnection: (minimizeWalletPanel?: boolean) => void;
  walletAccounts: string[];
  walletAccount: string;
  setWalletAccount: (address: string) => void;
  walletProviderLabel: string;
  walletChainId: number | null;
  walletBalance: string;
  walletNetworkWarning: string;
  walletError: string;
  activeSenderAddress: string;
  activeSenderBalance: string;
};

export function WriteSenderPanel({
  collapsed,
  toggleCollapsed,
  walletSenderCollapsed,
  toggleWalletSenderCollapsed,
  hasRpcAccounts,
  effectiveWriteMode,
  setWriteMode,
  fromAddress,
  setFromAddress,
  accounts,
  senderBalances,
  copyAddress,
  copiedAddress,
  walletChoices,
  selectedWalletProviderId,
  setWalletTargetProviderId,
  walletConnectLoading,
  connectWallet,
  clearWalletConnection,
  walletAccounts,
  walletAccount,
  setWalletAccount,
  walletProviderLabel,
  walletChainId,
  walletBalance,
  walletNetworkWarning,
  walletError,
  activeSenderAddress,
  activeSenderBalance
}: WriteSenderPanelProps) {
  return (
    <section className="panel controlPanel senderPanel">
      <div className="panelHeader">
        <h3>Write Sender</h3>
        <button
          className="secondaryButton"
          onClick={toggleCollapsed}
          aria-label={collapsed ? "Expand write sender" : "Collapse write sender"}
          title={collapsed ? "Expand write sender" : "Collapse write sender"}
        >
          {collapsed ? "+" : "-"}
        </button>
      </div>
      {!collapsed ? (
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
                onClick={toggleWalletSenderCollapsed}
                aria-label={walletSenderCollapsed ? "Expand wallet sender" : "Collapse wallet sender"}
                title={walletSenderCollapsed ? "Expand wallet sender" : "Collapse wallet sender"}
              >
                {walletSenderCollapsed ? "+" : "-"}
              </button>
            </div>
            {!walletSenderCollapsed ? (
              <>
                {walletChoices.length ? (
                  <>
                    <label>Wallet provider</label>
                    <select
                      value={selectedWalletProviderId}
                      onChange={(e) => setWalletTargetProviderId(e.target.value)}
                      disabled={walletConnectLoading}
                    >
                      {walletChoices.map((choice) => (
                        <option key={choice.id} value={choice.id}>
                          {choice.label}
                        </option>
                      ))}
                    </select>
                    <span className="hint">Pick provider, then click Connect wallet.</span>
                  </>
                ) : (
                  <span className="hint">No injected wallet found. Install/use Zerion, MetaMask, Rabby, or another compatible wallet.</span>
                )}

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
                  Wallet chain ID: {walletAccount ? (walletChainId ?? "Unknown") : "-"}
                </span>
                <span className="hint">
                  Wallet balance (via current RPC): {walletAccount ? `${walletBalance || "..."} ETH` : "-"}
                </span>
                {walletNetworkWarning ? <div className="errorBox">{walletNetworkWarning}</div> : null}
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
  );
}
