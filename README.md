# localethscan

Local-first mini block explorer + contract admin UI for EVM testing.

This repo is now primarily a frontend tool for interacting with contracts on local nodes (for example Anvil), with no backend required.

## Status

MVP is complete and working.

## What the UI does

- Connect to RPC (`http://127.0.0.1:8545` by default).
- Show chain status:
  - connected/disconnected
  - chain id
  - latest block
- Add and manage contracts:
  - add single contract (name + address + ABI)
  - bulk import multiple contracts from JSON files
  - rename/remove contracts
- Generate ABI-driven Read/Write forms.
- Execute reads with decoded output (`BigInt` safe).
- Execute writes and show:
  - tx hash
  - receipt summary
  - decoded emitted logs (from loaded ABI)
- Decode raw logs with topics + data.
- Write sender UX:
  - dropdown of `eth_accounts`
  - one-click copy of selected sender
  - ETH balance shown for each sender option and selected sender
- Section collapse/expand.
- Dark mode toggle.
- Local persistence for RPC, contracts, and UI preferences.

## Run

```bash
cd ui
npm install
npm run dev
```

Open the shown URL (usually `http://127.0.0.1:5173`).

## Local Anvil flow

```bash
anvil
```

Then in UI:

1. Keep RPC as `http://127.0.0.1:8545`.
2. Add/import contract(s) with ABI + deployed address.
3. Pick sender from `Write Sender`.
4. Use Read/Write panels.
5. Inspect tx receipts and decoded logs.

## Bulk Import Files

Each selected JSON file can be one of:

1. Single contract object

```json
{
  "name": "Counter",
  "address": "0x...",
  "abi": [ ... ]
}
```

2. Object with `contracts` array

```json
{
  "contracts": [
    { "name": "Token", "address": "0x...", "abi": [ ... ] },
    { "name": "Vault", "address": "0x...", "abi": [ ... ] }
  ]
}
```

3. Top-level array of contract objects

```json
[
  { "name": "Token", "address": "0x...", "abi": [ ... ] },
  { "name": "Vault", "address": "0x...", "abi": [ ... ] }
]
```

## Notes

- Best experience today is local RPCs that expose unlocked accounts (Anvil default).
- Public RPC endpoints usually do not allow `eth_sendTransaction` from arbitrary accounts; wallet integration is the next step for that.
- Solidity/Foundry files remain in this repo for contract development, but this README is centered on the UI workflow.
