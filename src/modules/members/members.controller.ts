import { Controller, Get, Post, Param, Body, UseGuards } from "@nestjs/common";
import { ApiTags, ApiBearerAuth } from "@nestjs/swagger";
import { MembersService } from "./members.service";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";

@ApiTags("members")
@Controller("groups/:groupId/members")
export class MembersController {
  constructor(private readonly membersService: MembersService) {}

  @Get()
  findByGroup(@Param("groupId") groupId: string) {
    return this.membersService.findByGroup(groupId);
  }

  @Post()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  add(
    @Param("groupId") groupId: string,
    @Body("address") address: string,
    @Body("displayName") displayName?: string,
  ) {
    return this.membersService.add(groupId, address, displayName);
  }
}
