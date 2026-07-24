import { Injectable, UnauthorizedException, Logger } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import { Keypair } from "@stellar/stellar-sdk";
import { randomBytes } from "crypto";

// ─── In-memory nonce store ────────────────────────────────────────────
// Nonces expire after 5 minutes. In production, replace with Redis.

interface NonceEntry {
  message: string;
  expiresAt: number;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly nonces = new Map<string, NonceEntry>();
  private readonly NONCE_TTL_MS = 5 * 60 * 1000; // 5 minutes

  constructor(
    private jwtService: JwtService,
    private config: ConfigService,
  ) {
    // Purge expired nonces every 60 seconds
    setInterval(() => this.purgeExpiredNonces(), 60_000);
  }

  /**
   * Generate a challenge nonce for a Stellar address.
   * The client must sign this message to prove ownership of the private key.
   */
  generateNonce(address: string): { nonce: string; message: string } {
    const nonce = randomBytes(32).toString("hex");
    const timestamp = Date.now();
    const message = `CoopFinance auth challenge: ${nonce}\nAddress: ${address}\nTimestamp: ${timestamp}\nExpires: ${timestamp + this.NONCE_TTL_MS}`;

    this.nonces.set(address, {
      message,
      expiresAt: timestamp + this.NONCE_TTL_MS,
    });

    this.logger.debug(`Nonce generated for ${address}`);
    return { nonce, message };
  }

  /**
   * Verify a Stellar signature against the nonce challenge and issue a JWT.
   *
   * @param address  - Stellar public key (G…)
   * @param signature - Base64-encoded signature of the challenge message
   */
  async login(
    address: string,
    signature: string,
  ): Promise<{ accessToken: string }> {
    const entry = this.nonces.get(address);
    if (!entry) {
      throw new UnauthorizedException(
        "No active nonce found. Request GET /api/auth/nonce?address=... first.",
      );
    }

    if (Date.now() > entry.expiresAt) {
      this.nonces.delete(address);
      throw new UnauthorizedException("Nonce expired. Request a new one.");
    }

    // ── Verify Stellar signature ────────────────────────────────────
    const isValid = this.verifyStellarSignature(
      address,
      entry.message,
      signature,
    );

    if (!isValid) {
      this.logger.warn(`Invalid signature for ${address}`);
      throw new UnauthorizedException("Signature verification failed.");
    }

    // Consume the nonce (one-time use)
    this.nonces.delete(address);

    // ── Issue JWT ───────────────────────────────────────────────────
    const payload = {
      sub: address,
      address,
      iat: Math.floor(Date.now() / 1000),
    };

    const accessToken = this.jwtService.sign(payload);

    this.logger.log(`JWT issued for ${address}`);
    return { accessToken };
  }

  /**
   * Verify that `signature` is a valid Stellar signature of `message`
   * by the keypair identified by `address`.
   */
  private verifyStellarSignature(
    address: string,
    message: string,
    signature: string,
  ): boolean {
    try {
      const keypair = Keypair.fromPublicKey(address);
      const messageBytes = Buffer.from(message, "utf-8");
      const signatureBytes = Buffer.from(signature, "base64");
      return keypair.verify(messageBytes, signatureBytes);
    } catch (err) {
      this.logger.error("Signature verification error", err);
      return false;
    }
  }

  /** Remove expired nonces from the in-memory store. */
  private purgeExpiredNonces(): void {
    const now = Date.now();
    for (const [key, entry] of this.nonces) {
      if (now > entry.expiresAt) {
        this.nonces.delete(key);
      }
    }
  }
}
