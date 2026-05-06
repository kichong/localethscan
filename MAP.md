# localethscan Map

Local-first EVM contract admin UI with a small Foundry scaffold.

## Entry Points

- `ui/MAP.md` - frontend routes, helpers, and validation.
- `README.md` - user-facing run flow and supported import/export formats.
- `foundry.toml` - Solidity project settings.

## Common Tasks

- Change the local explorer UI: start in `ui/MAP.md`.
- Change ABI parsing, function input coercion, log decoding helpers, or printable output: `ui/src/abi-utils.ts`.
- Change RPC validation, URL privacy redaction, or preset constants: `ui/src/rpc.ts` and `ui/src/config.ts`.
- Change wallet-provider discovery or wallet chain-id handling: `ui/src/wallets.ts`.
- Change workspace persistence/import state shape: `ui/src/session.ts` and then `ui/src/App.tsx`.
- Change Foundry example contracts/tests: `src/`, `script/`, and `test/`.

## Context Notes

- `ui/src/App.tsx` owns React state and user flows. Prefer extracting pure helpers or focused components before adding more code to it.
- `ui/dist/`, `ui/node_modules/`, `cache/`, `out/`, and TypeScript build-info files are generated or dependency output; skip them during code review unless diagnosing build artifacts.
