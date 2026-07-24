import { Controller, Get, Post, Body, Query } from "@nestjs/common";
import { ApiTags, ApiOperation, ApiQuery } from "@nestjs/swagger";
import { AuthService } from "./auth.service";

@ApiTags("auth")
@Controller("auth")
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Get("nonce")
  @ApiOperation({
    summary: "Get a challenge nonce for Stellar wallet authentication",
    description:
      "Returns a unique message that the client must sign with their " +
      "Stellar private key. The signature is then submitted to POST /api/auth/login.",
  })
  @ApiQuery({ name: "address", required: true, description: "Stellar public key (G…)" })
  getNonce(@Query("address") address: string) {
    return this.authService.generateNonce(address);
  }

  @Post("login")
  @ApiOperation({
    summary: "Verify Stellar signature and issue a JWT",
    description:
      "Submit a base64-encoded signature of the nonce challenge message. " +
      "Returns a JWT access token for use in the Authorization header.",
  })
  login(
    @Body("address") address: string,
    @Body("signature") signature: string,
  ) {
    return this.authService.login(address, signature);
  }
}
