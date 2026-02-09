import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PlaidService } from './plaid.service';
import { PrismaService } from '../../config/prisma.service';

/**
 * Scheduled tasks for Plaid data synchronization
 * Runs weekly to sync transaction data from Plaid
 */
@Injectable()
export class PlaidSchedulerService {
  private readonly logger = new Logger(PlaidSchedulerService.name);

  constructor(
    private plaidService: PlaidService,
    private prisma: PrismaService,
  ) {}

  /**
   * Run every Sunday at 2am to sync all transactions
   * Cron: 0 2 * * 0 (second, minute, hour, day, month, weekday)
   */
  @Cron('0 2 * * 0', {
    name: 'sync-plaid-transactions',
    timeZone: 'America/Los_Angeles',
  })
  async syncAllTransactions() {
    this.logger.log('Starting scheduled transaction sync...');

    // Get all active Plaid accounts
    const accounts = await this.prisma.plaidAccount.findMany({
      where: { isActive: true },
      select: { id: true },
    });

    this.logger.log(`Found ${accounts.length} accounts to sync`);

    let totalSynced = 0;
    let totalFailed = 0;

    for (const account of accounts) {
      try {
        const result = await this.syncAccountTransactions(account.id);
        totalSynced += result.stored;
        this.logger.log(
          `Synced ${result.stored} transactions for account ${account.id} (${result.skipped} skipped)`,
        );
      } catch (error: any) {
        totalFailed++;
        this.logger.error(
          `Failed to sync account ${account.id}: ${error.message}`,
        );
      }
    }

    this.logger.log(
      `Transaction sync complete: ${totalSynced} total synced, ${totalFailed} failed`,
    );
  }

  /**
   * Sync transactions for a specific account
   * Gets last transaction date and syncs from 1 week prior
   */
  private async syncAccountTransactions(
    plaidAccountId: string,
  ): Promise<{ stored: number; skipped: number }> {
    // Get last sync date for this account
    const lastTransaction = await this.prisma.plaidTransaction.findFirst({
      where: { plaidAccountId },
      orderBy: { date: 'desc' },
      select: { date: true },
    });

    // Sync from last sync date (or 2 years back if first sync)
    const startDate = lastTransaction?.date
      ? new Date(lastTransaction.date.getTime() - 7 * 24 * 60 * 60 * 1000) // 1 week overlap to catch pending transactions
      : new Date(Date.now() - 2 * 365 * 24 * 60 * 60 * 1000); // 2 years back

    const endDate = new Date();

    this.logger.log(
      `Syncing account ${plaidAccountId} from ${startDate.toISOString().split('T')[0]} to ${endDate.toISOString().split('T')[0]}`,
    );

    // Fetch and store transactions from Plaid
    return await this.plaidService.fetchAndStoreTransactions(
      plaidAccountId,
      startDate.toISOString().split('T')[0],
      endDate.toISOString().split('T')[0],
    );
  }
}
