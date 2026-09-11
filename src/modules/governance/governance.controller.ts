import { Controller, Get, Post, Param, Body, Query, UseGuards } from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth } from "@nestjs/swagger";
import { GovernanceService, CreateProposalDto } from "./governance.service";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";

@ApiTags("governance")
@Controller("governance")
export class GovernanceController {
  constructor(private readonly governanceService: GovernanceService) {}

  @Get("proposals")
  @ApiOperation({ summary: "List all proposals" })
  findAll(@Query("groupId") groupId?: string) {
    return this.governanceService.findAll(groupId);
  }

  @Get("proposals/:id")
  findOne(@Param("id") id: string) {
    return this.governanceService.findOne(id);
  }

  @Post("proposals")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Register proposal after on-chain creation" })
  create(@Body() dto: CreateProposalDto) {
    return this.governanceService.create(dto);
  }
}
