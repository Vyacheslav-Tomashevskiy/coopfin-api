import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { nativeToScVal, Address, Keypair } from "@stellar/stellar-sdk";
import { StellarIndexerService } from "./stellar-indexer.service";
import { PrismaService } from "./prisma.service";

/**
 * Build a base64 XDR ScVal the same way the Soroban contracts emit their
 * event topics/values, so the decoder is exercised end-to-end.
 */
const sym = (s: string) => nativeToScVal(s, { type: "symbol" }).toXDR("base64");
const addr = (a: string) => nativeToScVal(new Address(a), { type: "address" });

// A throwaway but valid Stellar public key for the borrower/member fields.
const MEMBER = Keypair.random().publicKey();

function contributionEvent() {
  const value = nativeToScVal([
    addr(MEMBER),
    nativeToScVal(1000n, { type: "i128" }),
    nativeToScVal(3, { type: "u32" }),
  ]).toXDR("base64");
  return {
    id: "ev-contribution-1",
    type: "contract",
    ledger: 42,
    transaction_hash: "tx-abc",
    in_successful_contract_call: true,
    topic: [sym("contribution")],
    value,
  };
}

function loanRequestedEvent() {
  const value = nativeToScVal([
    nativeToScVal(7, { type: "u32" }),
    addr(MEMBER),
    nativeToScVal(5000n, { type: "i128" }),
  ]).toXDR("base64");
  return {
    id: "ev-loan-1",
    type: "contract",
    ledger: 43,
    transaction_hash: "tx-loan",
    in_successful_contract_call: true,
    topic: [sym("loan_requested")],
    value,
  };
}

describe("StellarIndexerService", () => {
  let service: StellarIndexerService;
  let prisma: {
    contribution: { upsert: jest.Mock };
    loan: { findFirst: jest.Mock; create: jest.Mock; update: jest.Mock };
  };

  beforeEach(async () => {
    prisma = {
      contribution: { upsert: jest.fn() },
      loan: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn(), update: jest.fn() },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StellarIndexerService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: { get: (_k: string, d: string) => d } },
      ],
    }).compile();

    service = module.get(StellarIndexerService);
  });

  it("is defined", () => {
    expect(service).toBeDefined();
  });

  it("decodes a contribution event and upserts it on txHash", async () => {
    await (service as any).processEvent("group-1", contributionEvent());

    expect(prisma.contribution.upsert).toHaveBeenCalledTimes(1);
    const arg = prisma.contribution.upsert.mock.calls[0][0];
    expect(arg.where).toEqual({ txHash: "tx-abc" });
    expect(arg.create).toMatchObject({
      groupId: "group-1",
      memberAddress: MEMBER,
      amount: 1000n,
      period: 3,
      txHash: "tx-abc",
      ledger: 42,
    });
  });

  it("decodes a loan_requested event and creates a Pending loan", async () => {
    await (service as any).processEvent("group-1", loanRequestedEvent());

    expect(prisma.loan.findFirst).toHaveBeenCalledWith({
      where: { groupId: "group-1", onChainId: 7 },
      select: { id: true },
    });
    expect(prisma.loan.create).toHaveBeenCalledTimes(1);
    expect(prisma.loan.create.mock.calls[0][0].data).toMatchObject({
      groupId: "group-1",
      onChainId: 7,
      borrower: MEMBER,
      amount: 5000n,
      status: "Pending",
      txHash: "tx-loan",
    });
  });

  it("updates an existing loan instead of duplicating it", async () => {
    prisma.loan.findFirst.mockResolvedValueOnce({ id: "loan-row-1" });

    const approved = loanRequestedEvent();
    approved.topic = [sym("loan_approved")];

    await (service as any).processEvent("group-1", approved);

    expect(prisma.loan.create).not.toHaveBeenCalled();
    expect(prisma.loan.update).toHaveBeenCalledTimes(1);
    const data = prisma.loan.update.mock.calls[0][0].data;
    expect(data.status).toBe("Approved");
    expect(data.approvedAt).toBeInstanceOf(Date);
  });

  it("ignores unrelated events (e.g. withdrawal)", async () => {
    const withdrawal = contributionEvent();
    withdrawal.topic = [sym("withdrawal")];

    await (service as any).processEvent("group-1", withdrawal);

    expect(prisma.contribution.upsert).not.toHaveBeenCalled();
    expect(prisma.loan.create).not.toHaveBeenCalled();
  });
});
