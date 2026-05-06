import type { RpcPreset } from "./types";

export const STORAGE_KEY = "localethscan:workspace:v2";
export const LEGACY_STORAGE_KEY = "localethscan:mvp:v2";
export const DEFAULT_RPC = "http://127.0.0.1:8545";
export const CUSTOM_RPC_PRESET_ID = "__custom__";
export const PRIVACY_MODE_ENABLED = true;
export const REDACTED_TOKEN = "[redacted]";
export const SENSITIVE_RPC_KEYS = [
  "key",
  "api_key",
  "apikey",
  "token",
  "access_token",
  "secret",
  "client_secret",
  "password",
  "signature",
  "sig",
  "auth",
  "authorization"
];

declare const __RPC_PRESET_OPTIONS__: RpcPreset[];

export const RPC_PRESET_OPTIONS = __RPC_PRESET_OPTIONS__;
