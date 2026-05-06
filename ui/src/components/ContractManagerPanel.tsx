import type { ChangeEventHandler, Dispatch, SetStateAction } from "react";
import { normalizeAddress } from "../abi-utils";

type ContractManagerPanelProps = {
  collapsed: boolean;
  toggleCollapsed: () => void;
  contractNameInput: string;
  setContractNameInput: Dispatch<SetStateAction<string>>;
  contractAddressInput: string;
  setContractAddressInput: Dispatch<SetStateAction<string>>;
  abiTextInput: string;
  setAbiTextInput: Dispatch<SetStateAction<string>>;
  onAbiFilePick: ChangeEventHandler<HTMLInputElement>;
  onImportFiles: ChangeEventHandler<HTMLInputElement>;
  addSingleContract: () => void;
  managerError: string;
  managerMessage: string;
};

export function ContractManagerPanel({
  collapsed,
  toggleCollapsed,
  contractNameInput,
  setContractNameInput,
  contractAddressInput,
  setContractAddressInput,
  abiTextInput,
  setAbiTextInput,
  onAbiFilePick,
  onImportFiles,
  addSingleContract,
  managerError,
  managerMessage
}: ContractManagerPanelProps) {
  return (
    <section className="panel controlPanel managerPanel">
      <div className="panelHeader">
        <h3>Contract Manager</h3>
        <button
          className="secondaryButton"
          onClick={toggleCollapsed}
          aria-label={collapsed ? "Expand contract manager" : "Collapse contract manager"}
          title={collapsed ? "Expand contract manager" : "Collapse contract manager"}
        >
          {collapsed ? "+" : "-"}
        </button>
      </div>
      {!collapsed ? (
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
  );
}
