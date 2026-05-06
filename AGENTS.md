# Agent Notes

If an important product or behavior question is unclear, ask the user before changing behavior.

## Fast Routing

- Start with `MAP.md` for repo layout and task routes.
- Frontend app work lives under `ui/`; use `ui/MAP.md` before opening source files.
- Keep behavior-preserving refactors small. This repo is mainly a local EVM contract admin UI; avoid changing RPC, wallet, storage, or transaction behavior without a direct reason.

## Validation

- Frontend: run `npm run build` from `ui/`.
- Contracts: run the Foundry checks that match the touched Solidity files.
