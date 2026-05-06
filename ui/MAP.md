# UI Map

React + Vite frontend for local EVM contract interaction.

## Source Routes

- `src/App.tsx` - main React workspace: RPC controls, contract manager, sender selection, read/write/decode panels.
- `src/components/RpcHeader.tsx` - RPC preset/input controls, connection status display, export/theme actions.
- `src/components/ContractManagerPanel.tsx` - add-contract and bulk-import form UI.
- `src/components/WriteSenderPanel.tsx` - local/wallet sender selection UI and active sender summary.
- `src/abi-utils.ts` - ABI parsing, argument coercion, tuple field helpers, output normalization, ETH balance formatting.
- `src/wallets.ts` - injected wallet discovery, EIP-6963 provider normalization, chain ID requests.
- `src/rpc.ts` - RPC URL validation and privacy redaction.
- `src/session.ts` - localStorage load, import JSON parsing, empty contract UI state.
- `src/config.ts` - storage keys, default RPC, privacy constants, Vite-injected RPC presets.
- `src/types.ts` - shared app/domain types.
- `src/styles.css` - app layout and visual system.
- `src/main.tsx` - React mount.

## Validation

Run from `ui/`:

```bash
npm run build
```

## Refactor Guidance

- Keep transaction send, receipt wait, and log decode flows in `App.tsx` unless intentionally changing behavior.
- Pure parsing/formatting helpers belong in `abi-utils.ts`.
- Do not read `dist/`, `node_modules/`, or `*.tsbuildinfo` for normal source edits.
