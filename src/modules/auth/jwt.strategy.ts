import { Injectable } from "@nestjs/common";
import { PassportStrategy } from "@nestjs/passport";
import { ExtractJwt, Strategy } from "passport-jwt";
import { ConfigService } from "@nestjs/config";

export interface JwtPayload {
  sub: string;
  address: string;
  iat: number;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(config: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get("JWT_SECRET", "coopfin-jwt-secret-dev"),
    });
  }

  validate(payload: JwtPayload): JwtPayload {
    // Passport attaches the return value to `request.user`
    return {
      sub: payload.sub,
      address: payload.address,
      iat: payload.iat,
    };
  }
}
