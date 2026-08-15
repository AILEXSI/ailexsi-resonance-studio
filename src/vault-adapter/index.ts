/**
 * Vault Adapter — the ONLY integration surface toward AILEXSI Core Vault V2.
 *
 * Rules (non-negotiable):
 * - ailexsi-core-vault-v2 is an immutable dependency / foundation
 * - This product CONSUMES the Vault; it never modifies Vault packages or Core
 * - On accepted creative decisions we MAY create a Memory via the Vault's
 *   public command path (cultivation / command-adapter) with tags:
 *     resonance-studio, creative-decision, accepted
 * - Rejected proposals stay ephemeral and never touch the Vault
 * - No dual-write of canonical facts
 *
 * V0.1: stub that records locally. Later: wire to pinned Vault V2 packages
 * or DesktopHost bridge without forking Vault source.
 */

export interface CreativeDecision {
  id: string;
  proposalId: string;
  decision: "accepted" | "rejected" | "adjusted";
  at: string;
  naturalLanguage: string;
  rationale: string;
  projectId: string;
}

export interface VaultAdapter {
  persistAcceptedCreativeDecision(input: {
    projectId: string;
    proposalId: string;
    rationale: string;
    naturalLanguage: string;
  }): Promise<{ memoryId?: string }>;
  getStatus(): { connected: boolean; mode: "local-stub" | "vault-v2" };
}

export const localOnlyVaultAdapter: VaultAdapter = {
  async persistAcceptedCreativeDecision(input) {
    const memoryId = `local:${input.proposalId}`;
    // Honest V0.1: only local record. Real Vault write comes later.
    try {
      const key = `resonance-studio:decision:${input.proposalId}`;
      localStorage.setItem(
        key,
        JSON.stringify({
          ...input,
          memoryId,
          at: new Date().toISOString(),
        })
      );
    } catch {
      // ignore
    }
    console.info("[vault-adapter] local record only — Vault not yet wired", input);
    return { memoryId };
  },
  getStatus() {
    return { connected: false, mode: "local-stub" };
  },
};
