import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const DEFAULT_RPC = "http://127.0.0.1:8545";
const ENV_FILE = resolve(__dirname, "..", ".env");

type RpcPreset = {
  id: string;
  label: string;
  url: string;
};

function formatRpcPresetLabel(rawKey: string): string {
  const aliases: Record<string, string> = {
    ETH: "Ethereum",
    MAIN: "Mainnet",
    OP: "Optimism",
    RPC: "RPC",
    SEP: "Sepolia",
    UNI: "Unichain",
    URL: "URL",
    WORLD: "World Chain"
  };

  return rawKey
    .replace(/_RPC_URL$/i, "")
    .replace(/_CHAIN/gi, "")
    .split("_")
    .filter(Boolean)
    .map((part) => aliases[part] ?? `${part.slice(0, 1)}${part.slice(1).toLowerCase()}`)
    .join(" ");
}

function readRpcPresets(): RpcPreset[] {
  const presets: RpcPreset[] = [
    { id: "forge-local", label: "Local Forge", url: DEFAULT_RPC }
  ];
  const seenUrls = new Set([DEFAULT_RPC]);

  if (!existsSync(ENV_FILE)) return presets;

  const envText = readFileSync(ENV_FILE, "utf8");
  for (const rawLine of envText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const equalsIndex = line.indexOf("=");
    if (equalsIndex <= 0) continue;

    const key = line.slice(0, equalsIndex).trim();
    let value = line.slice(equalsIndex + 1).trim();
    if (!/_RPC_URL$/i.test(key)) continue;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1).trim();
    }
    if (!value) continue;

    try {
      const url = new URL(value).toString();
      if (seenUrls.has(url)) continue;
      seenUrls.add(url);
      presets.push({
        id: key.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
        label: formatRpcPresetLabel(key),
        url
      });
    } catch {
      // Ignore invalid or partial RPC URLs in the env file.
    }
  }

  return presets;
}

export default defineConfig({
  plugins: [react()],
  define: {
    __RPC_PRESET_OPTIONS__: JSON.stringify(readRpcPresets())
  }
});
