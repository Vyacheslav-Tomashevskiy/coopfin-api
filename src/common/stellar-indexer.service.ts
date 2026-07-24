import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { ConfigService } from "@nestjs/config";
import { xdr, scValToNative } from "@stellar/stellar-sdk";
import { PrismaService } from "./prisma.service";

/**
 * A single contract event as returned by Horizon's
 * `/contracts/{id}/events` endpoint. Only the fields we consume are typed;
 * `topic`/`value` carry the base64 XDR ScVal payloads emitted on-chain.
 */
interface ContractEventRecord {
  id: string;
  type: string;
  ledger?: number;
  transaction_hash?: string;
  in_successful_contract_call: boolean;
  topic: Array<string | { xdr: string }>;
  value: string | { xdr: string };
}

@Injectable()
export class StellarIndexerService {
  private readonly logger = new Logger(StellarIndexerService.name);
  private readonly horizonUrl: string;

  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
  ) {
    this.horizonUrl = config.get("HORIZON_URL", "https://horizon-testnet.stellar.org");
  }

  /** Poll for contribution events every 30 seconds */
  @Cron(CronExpression.EVERY_30_SECONDS)
  async syncContributions() {
    this.logger.debug("Syncing contributions from Stellar...");
    try {
      const groups = await this.prisma.group.findMany({
        where: { treasuryContractId: { not: null } },
        select: { id: true, treasuryContractId: true },
      });

      for (const group of groups) {
        if (!group.treasuryContractId) continue;
        await this.fetchAndStoreEvents(group.id, group.treasuryContractId, "contribution");
      }
    } catch (err) {
      this.logger.error("Contribution sync failed", err);
    }
  }

  /** Poll for loan events every minute */
  @Cron(CronExpression.EVERY_MINUTE)
  async syncLoanEvents() {
    this.logger.debug("Syncing loan events from Stellar...");
    try {
      const groups = await this.prisma.group.findMany({
        where: { loanContractId: { not: null } },
        select: { id: true, loanContractId: true },
      });

      for (const group of groups) {
        if (!group.loanContractId) continue;
        await this.fetchAndStoreEvents(group.id, group.loanContractId, "loan");
      }
    } catch (err) {
      this.logger.error("Loan sync failed", err);
    }
  }

  private async fetchAndStoreEvents(
    groupId: string,
    contractId: string,
    eventType: string,
  ) {
    const url = `${this.horizonUrl}/contracts/${contractId}/events?limit=50&order=desc`;
    const res = await fetch(url);
    if (!res.ok) return;

    const { _embedded: { records } } = await res.json() as {
      _embedded: { records: ContractEventRecord[] };
    };

    this.logger.debug(`Found ${records.length} ${eventType} events for contract ${contractId}`);

    for (const record of records) {
      // Only index events emitted by a successful contract invocation.
      if (record.in_successful_contract_call === false) continue;

      try {
        await this.processEvent(groupId, record);
      } catch (err) {
        // A single malformed record must not abort the whole batch.
        this.logger.warn(
          `Skipping unparseable event ${record.id} on ${contractId}: ${
            err instanceof Error ? err.message : err
          }`,
        );
      }
    }
  }

  /**
   * Decode a single Soroban event's XDR payload and upsert it into the
   * corresponding table. Routing is driven by the event name carried in the
   * first topic (e.g. `contribution`, `loan_requested`, ...).
   */
  private async processEvent(groupId: string, record: ContractEventRecord) {
    const name = this.decodeTopicName(record.topic);
    if (!name) return;

    const value = scValToNative(this.toScVal(record.value));

    switch (name) {
      case "contribution":
        // Emitted as `(member: Address, amount: i128, period: u32)`.
        await this.upsertContribution(groupId, record, value as [string, bigint, number]);
        break;

      case "loan_requested":
      case "loan_approved":
      case "loan_repaid":
        // `(id/loan_id: u32, borrower: Address, amount: i128, [status])`.
        await this.upsertLoan(groupId, record, name, value as unknown[]);
        break;

      // `withdrawal`, `member_added`, etc. carry no row to sync here.
      default:
        break;
    }
  }

  private async upsertContribution(
    groupId: string,
    record: ContractEventRecord,
    [memberAddress, amount, period]: [string, bigint, number],
  ) {
    const txHash = record.transaction_hash ?? record.id;
    const ledger = record.ledger ?? null;

    await this.prisma.contribution.upsert({
      where: { txHash },
      update: {
        amount: BigInt(amount),
        period: Number(period),
        ledger,
      },
      create: {
        groupId,
        memberAddress,
        amount: BigInt(amount),
        period: Number(period),
        txHash,
        ledger,
      },
    });
  }

  private async upsertLoan(
    groupId: string,
    record: ContractEventRecord,
    name: string,
    value: unknown[],
  ) {
    const [onChainIdRaw, borrower, amount, status] = value as [
      number | bigint,
      string,
      bigint,
      unknown?,
    ];
    const onChainId = Number(onChainIdRaw);
    const txHash = record.transaction_hash ?? record.id;

    const statusByEvent: Record<string, string> = {
      loan_requested: "Pending",
      loan_approved: "Approved",
      loan_repaid: "Repaid",
    };
    // `loan_repaid` also carries the on-chain status; prefer it when present
    // (a partial repayment keeps the loan `Approved`).
    const derivedStatus = this.normalizeStatus(status) ?? statusByEvent[name];

    const existing = await this.prisma.loan.findFirst({
      where: { groupId, onChainId },
      select: { id: true },
    });

    if (existing) {
      await this.prisma.loan.update({
        where: { id: existing.id },
        data: {
          amount: BigInt(amount),
          status: derivedStatus,
          txHash,
          ...(name === "loan_approved" ? { approvedAt: new Date() } : {}),
          ...(name === "loan_repaid" && derivedStatus === "Repaid"
            ? { repaidAt: new Date() }
            : {}),
        },
      });
    } else {
      await this.prisma.loan.create({
        data: {
          groupId,
          onChainId,
          borrower,
          amount: BigInt(amount),
          interestBps: 0,
          purpose: "",
          status: derivedStatus,
          txHash,
        },
      });
    }
  }

  /** Decode the event name from the first topic ScVal (a Symbol). */
  private decodeTopicName(topic: ContractEventRecord["topic"]): string | null {
    if (!topic || topic.length === 0) return null;
    const decoded = scValToNative(this.toScVal(topic[0]));
    return typeof decoded === "string" ? decoded : String(decoded);
  }

  /** Accept either a raw base64 XDR string or a `{ xdr }` wrapper. */
  private toScVal(payload: string | { xdr: string }): xdr.ScVal {
    const base64 = typeof payload === "string" ? payload : payload.xdr;
    return xdr.ScVal.fromXDR(base64, "base64");
  }

  /** Contract enums decode to their variant name (as a string or `[name]`). */
  private normalizeStatus(status: unknown): string | undefined {
    if (typeof status === "string") return status;
    if (Array.isArray(status) && typeof status[0] === "string") return status[0];
    return undefined;
  }
}
