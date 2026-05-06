import type {
  Eip6963ProviderDetail,
  Eip6963ProviderInfo,
  InjectedProvider,
  WalletProviderChoice
} from "./types";

export function parseChainId(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = trimmed.startsWith("0x") ? Number.parseInt(trimmed, 16) : Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function requestInjectedWalletChainId(provider: InjectedProvider): Promise<number | null> {
  try {
    return parseChainId(await provider.request({ method: "eth_chainId" }));
  } catch {
    return null;
  }
}

function normalizeWalletLabel(label?: string): string {
  const trimmed = label?.trim() ?? "";
  if (!trimmed) return "";
  const normalized = trimmed.toLowerCase();
  if (normalized.includes("zerion")) return "Zerion";
  if (normalized.includes("rabby")) return "Rabby";
  if (normalized.includes("metamask")) return "MetaMask";
  return trimmed;
}

function getInjectedWalletLabel(provider: InjectedProvider, info?: Partial<Eip6963ProviderInfo>): string {
  const announcedLabel = normalizeWalletLabel(info?.name ?? provider.providerInfo?.name);
  const announcedRdns = (info?.rdns ?? provider.providerInfo?.rdns ?? "").trim().toLowerCase();
  if (provider.isZerion || announcedLabel === "Zerion" || announcedRdns.includes("zerion")) return "Zerion";
  if (provider.isRabby || announcedLabel === "Rabby" || announcedRdns.includes("rabby")) return "Rabby";
  if (provider.isMetaMask || announcedLabel === "MetaMask" || announcedRdns.includes("metamask")) return "MetaMask";
  return announcedLabel || "Injected wallet";
}

export function getInjectedWalletFingerprint(
  provider: InjectedProvider,
  info?: Partial<Eip6963ProviderInfo>
): string | null {
  const uuid = info?.uuid?.trim().toLowerCase();
  if (uuid) return `eip6963-${uuid}`;
  const rdns = (info?.rdns ?? provider.providerInfo?.rdns ?? "").trim().toLowerCase();
  if (rdns) return `rdns-${rdns}`;
  if (provider.isZerion) return "flag-zerion";
  if (provider.isRabby) return "flag-rabby";
  if (provider.isMetaMask) return "flag-metamask";
  return null;
}

function getInjectedWalletPriority(provider: InjectedProvider, info?: Partial<Eip6963ProviderInfo>): number {
  let score = 0;
  if (info?.uuid) score += 100;
  if (info?.rdns || provider.providerInfo?.rdns) score += 20;
  if (info?.name || provider.providerInfo?.name) score += 10;
  if (provider.isZerion || provider.isRabby || provider.isMetaMask) score += 5;
  return score;
}

export function getInjectedWalletChoices(announcedProviders: Eip6963ProviderDetail[] = []): WalletProviderChoice[] {
  if (typeof window === "undefined") return [];
  const root = (window as any).ethereum as InjectedProvider | undefined;
  const rabby = (window as any).rabby as InjectedProvider | undefined;
  const candidates: Array<WalletProviderChoice & { priority: number }> = [];
  const seenFingerprints = new Set<string>();
  const pushProvider = (provider?: InjectedProvider, info?: Partial<Eip6963ProviderInfo>) => {
    if (!provider || typeof provider.request !== "function") return;
    const label = getInjectedWalletLabel(provider, info);
    const priority = getInjectedWalletPriority(provider, info);
    const fingerprint = getInjectedWalletFingerprint(provider, info);
    if (fingerprint) {
      if (seenFingerprints.has(fingerprint)) return;
      seenFingerprints.add(fingerprint);
    } else if (candidates.some((choice) => choice.provider === provider)) {
      return;
    }
    if (label !== "Injected wallet") {
      const existingIndex = candidates.findIndex((choice) => choice.label === label);
      if (existingIndex >= 0) {
        if (priority <= candidates[existingIndex].priority) return;
        candidates[existingIndex] = {
          id: fingerprint ?? candidates[existingIndex].id,
          label,
          provider,
          priority
        };
        return;
      }
    }
    const baseId = fingerprint ?? `${label.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "injected-wallet"}-${candidates.length + 1}`;
    candidates.push({
      id: baseId,
      label,
      provider,
      priority
    });
  };

  for (const announced of announcedProviders) {
    pushProvider(announced.provider, announced.info);
  }

  pushProvider(root, root?.providerInfo);
  if (Array.isArray(root?.providers)) {
    for (const provider of root.providers) pushProvider(provider, provider.providerInfo);
  }
  pushProvider(rabby, rabby?.providerInfo);

  const labelCounts = new Map<string, number>();
  return candidates.map((choice) => {
    const nextCount = (labelCounts.get(choice.label) ?? 0) + 1;
    labelCounts.set(choice.label, nextCount);
    const labelSuffix = choice.label === "Injected wallet" && nextCount > 1 ? ` ${nextCount}` : "";
    return {
      id: choice.id,
      label: `${choice.label}${labelSuffix}`,
      provider: choice.provider
    };
  });
}
