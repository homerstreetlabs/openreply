import { describe, it, expect, vi, beforeEach } from "vitest";

interface IncidentRow {
  kind: string;
  openKey: string | null;
  connectedAccountId: string;
  message: string;
}

let incidents: IncidentRow[] = [];
const refresh = vi.fn();

vi.mock("@/lib/db/client", () => ({
  prisma: {
    connectedAccount: {
      findMany: async () => [
        {
          id: "acct_yt",
          platform: "YOUTUBE",
          workspaceId: "ws_1",
          username: "creator",
          accessToken: "enc-access",
          refreshToken: "enc-refresh",
          tokenExpiresAt: new Date(),
        },
      ],
      update: async () => ({}),
    },
    incident: {
      upsert: async (args: {
        where: { connectedAccountId_openKey: { connectedAccountId: string; openKey: string } };
        create: IncidentRow;
        update: { message: string };
      }) => {
        const key = args.where.connectedAccountId_openKey;
        const open = incidents.find(
          (i) => i.connectedAccountId === key.connectedAccountId && i.openKey === key.openKey
        );
        if (open) open.message = args.update.message;
        else incidents.push({ ...args.create });
      },
      updateMany: async (args: { where: { connectedAccountId: string; openKey: unknown } }) => {
        const kinds = (args.where.openKey as { in?: string[] }).in ?? [args.where.openKey];
        for (const i of incidents) {
          if (i.connectedAccountId === args.where.connectedAccountId && kinds.includes(i.openKey)) {
            i.openKey = null;
          }
        }
      },
    },
    operationalEvent: { create: async () => ({}) },
  },
}));

vi.mock("@/lib/meta/oauth", () => ({
  decryptToken: (t: string) => t,
  encryptToken: (t: string) => t,
}));

vi.mock("@/lib/platforms/registry", () => ({
  ADAPTERS: { YOUTUBE: { tokens: { kind: "refreshable", refreshWithinMs: 600_000 } } },
  adapterFor: () => ({ tokens: { kind: "refreshable", refreshWithinMs: 600_000, refresh } }),
}));

const { refreshTokens } = await import("../lib/jobs/refresh-tokens");

const openIncidents = () => incidents.filter((i) => i.openKey !== null);

beforeEach(() => {
  incidents = [];
  refresh.mockReset();
});

describe("token refresh incidents", () => {
  /**
   * Google once answered a refresh with a bare "error code: 520" page. The
   * failure opened an incident, every later refresh succeeded, and the fleet
   * view kept reporting the account as failing for days.
   */
  it("clears an incident from a non-JSON upstream error once a refresh succeeds", async () => {
    refresh.mockRejectedValueOnce(
      new SyntaxError(`Unexpected token 'e', "error code: 520\n" is not valid JSON`)
    );
    await refreshTokens();
    expect(openIncidents()).toHaveLength(1);

    refresh.mockResolvedValueOnce({ accessToken: "new", expiresInSeconds: 3600 });
    await refreshTokens();

    expect(openIncidents()).toEqual([]);
  });

  it("clears an expired-token incident once a refresh succeeds", async () => {
    refresh.mockRejectedValueOnce(new Error("Token has been expired or revoked."));
    await refreshTokens();
    expect(openIncidents()).toHaveLength(1);

    refresh.mockResolvedValueOnce({ accessToken: "new", expiresInSeconds: 3600 });
    await refreshTokens();

    expect(openIncidents()).toEqual([]);
  });

  it("keeps the incident open while refreshes keep failing", async () => {
    refresh.mockRejectedValue(new Error("YouTube token refresh failed: invalid_grant"));
    await refreshTokens();
    await refreshTokens();

    expect(openIncidents()).toHaveLength(1);
  });
});
