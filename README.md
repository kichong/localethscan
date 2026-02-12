## Foundry

**Foundry is a blazing fast, portable and modular toolkit for Ethereum application development written in Rust.**

Foundry consists of:

- **Forge**: Ethereum testing framework (like Truffle, Hardhat and DappTools).
- **Cast**: Swiss army knife for interacting with EVM smart contracts, sending transactions and getting chain data.
- **Anvil**: Local Ethereum node, akin to Ganache, Hardhat Network.
- **Chisel**: Fast, utilitarian, and verbose solidity REPL.

## Documentation

https://book.getfoundry.sh/

## Usage

### Build

```shell
$ forge build
```

### Test

```shell
$ forge test
```

### Format

```shell
$ forge fmt
```

### Gas Snapshots

```shell
$ forge snapshot
```

### Anvil

```shell
$ anvil
```

### Deploy

```shell
$ forge script script/Counter.s.sol:CounterScript --rpc-url <your_rpc_url> --private-key <your_private_key>
```

### Cast

```shell
$ cast <subcommand>
```

### Help

```shell
$ forge --help
$ anvil --help
$ cast --help
```

## localethscan UI MVP

This repo now includes a local-only frontend at `ui/` for interacting with contracts deployed to local EVM nodes (for example Anvil).

### What this MVP does

- Connect to an RPC (default: `http://127.0.0.1:8545`) and show:
  - connection status
  - chain id
  - latest block
- Load a contract address (normalized to lowercase) and ABI (paste JSON or upload `.json` file).
- Auto-generate contract function forms in:
  - `Read` (`view`/`pure`)
  - `Write` (state-changing)
- Execute reads with decoded output (including `uint256`/`BigInt` support).
- Execute writes through `eth_sendTransaction` using unlocked local RPC accounts, then show:
  - tx hash
  - receipt summary
  - decoded receipt logs/events via current ABI
- Decode a raw log by pasting topics + data.
- Persist local session state in browser storage:
  - RPC URL
  - last contract address
  - last ABI text

### Run the UI

```shell
cd ui
npm install
npm run dev
```

Open the Vite URL shown in terminal (usually `http://127.0.0.1:5173`).

### Connect to Anvil

Start Anvil in another terminal:

```shell
anvil
```

Then in UI:

1. Keep RPC as `http://127.0.0.1:8545`.
2. Paste deployed contract address (lowercase is fine/preferred).
3. Paste ABI JSON (array or object with `abi` field), then click `Load Contract`.
4. Use `Read` and `Write` sections.
5. For writes, choose one unlocked account from `eth_accounts`.
6. Inspect tx receipt + decoded logs below each write call.

### Notes

- This is intentionally local-first and does not use any backend service.
- Write actions assume your local node exposes unlocked accounts (Anvil default behavior).
