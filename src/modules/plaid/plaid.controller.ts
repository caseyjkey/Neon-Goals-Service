import { Controller, Post, Get, Body, UseGuards, Logger, Param, Query } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PlaidService } from './plaid.service';
import { CreateLinkTokenDto, ExchangePublicTokenDto } from './dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { User } from '@prisma/client';

@Controller('plaid')
@UseGuards(JwtAuthGuard)
export class PlaidController {
  private readonly logger = new Logger(PlaidController.name);

  constructor(private readonly plaidService: PlaidService) {}

  /**
   * Create a link token for Plaid Link frontend
   * POST /plaid/create-link-token
   */
  @Post('create-link-token')
  async createLinkToken(@CurrentUser() user: User) {
    this.logger.log(`Create link token request from user: ${user.id}`);
    return this.plaidService.createLinkToken(user.id);
  }

  /**
   * Link a Plaid account (exchange public token and save to database)
   * POST /plaid/link-account
   */
  @Post('link-account')
  async linkAccount(@CurrentUser() user: User, @Body() body: { publicToken: string }) {
    this.logger.log(`Link account request from user: ${user.id}`);
    return this.plaidService.linkPlaidAccount(user.id, body.publicToken);
  }

  /**
   * Get user's linked Plaid accounts
   * GET /plaid/accounts
   */
  @Get('accounts')
  async getAccounts(@CurrentUser() user: User) {
    this.logger.log(`Get accounts request from user: ${user.id}`);
    return this.plaidService.getUserLinkedAccounts(user.id);
  }

  /**
   * Sync balances for a linked account
   * POST /plaid/sync/:accountId
   */
  @Post('sync/:accountId')
  async syncBalance(@CurrentUser() user: User, @Param('accountId') accountId: string) {
    this.logger.log(`Sync balance request from user: ${user.id} for account: ${accountId}`);
    return this.plaidService.syncAccountBalance(accountId);
  }

  /**
   * Link a Plaid account to a finance goal
   * POST /plaid/link-to-goal
   */
  @Post('link-to-goal')
  async linkToGoal(
    @CurrentUser() user: User,
    @Body() body: { plaidAccountId: string; financeGoalId: string },
  ) {
    this.logger.log(
      `Link to goal request from user: ${user.id}, account: ${body.plaidAccountId}, goal: ${body.financeGoalId}`,
    );
    return this.plaidService.linkToFinanceGoal(body.plaidAccountId, body.financeGoalId);
  }

  /**
   * Get account balance (direct from Plaid, fresh data)
   * GET /plaid/accounts/:accountId/balance
   */
  @Get('accounts/:accountId/balance')
  async getAccountBalance(@CurrentUser() user: User, @Param('accountId') accountId: string) {
    this.logger.log(`Get balance request from user: ${user.id} for account: ${accountId}`);
    return this.plaidService.getAccountBalance(accountId);
  }

  /**
   * Get account transactions (direct from Plaid, fresh data)
   * GET /plaid/accounts/:accountId/transactions
   */
  @Get('accounts/:accountId/transactions')
  async getAccountTransactions(
    @CurrentUser() user: User,
    @Param('accountId') accountId: string,
    // @Query() is not imported but we can add query params via Body decorator or parse manually
  ) {
    this.logger.log(`Get transactions request from user: ${user.id} for account: ${accountId}`);
    // Default to last 30 days
    return this.plaidService.getAccountTransactions(accountId);
  }

  /**
   * Get stored transactions from database (for AI agents and API access)
   * GET /plaid/accounts/:accountId/transactions/stored?limit=100
   */
  @Get('accounts/:accountId/transactions/stored')
  async getStoredTransactions(
    @CurrentUser() user: User,
    @Param('accountId') accountId: string,
    @Query('limit') limit?: number,
  ) {
    this.logger.log(
      `Get stored transactions request from user: ${user.id} for account: ${accountId}`,
    );
    return this.plaidService.getStoredTransactions(user.id, accountId, limit || 100);
  }

  /**
   * OAuth redirect endpoint (for OAuth flow)
   * GET /plaid/oauth_redirect
   */
  @Get('oauth_redirect')
  async oauthRedirect() {
    // Plaid Link will redirect here after OAuth flow
    // The frontend will handle the response via window.postMessage
    return { message: 'OAuth redirect handled by frontend' };
  }
}
