import { Controller, Post, Body, Logger } from '@nestjs/common';
import { ScraperService } from './scraper.service';

interface CallbackData {
  jobId: number;
  scraper: string;
  status: 'success' | 'error';
  error?: string;
  data: any;
}

@Controller('scrapers')
export class ScraperController {
  private readonly logger = new Logger(ScraperController.name);

  constructor(private scraperService: ScraperService) {}

  @Post('callback')
  async handleCallback(@Body() callbackData: CallbackData) {
    this.logger.log(`Received callback for job ${callbackData.jobId}: ${callbackData.status}`);

    if (callbackData.status === 'error') {
      this.logger.error(`Job ${callbackData.jobId} failed: ${callbackData.error}`);
      await this.scraperService.handleJobError(callbackData.jobId, callbackData.error);
      return { acknowledged: true, status: 'error' };
    }

    // DEBUG: Log detailed breakdown by retailer
    if (callbackData.data && Array.isArray(callbackData.data)) {
      const retailerCounts: Record<string, number> = {};
      callbackData.data.forEach((item: any) => {
        const retailer = item.retailer || item.source || 'Unknown';
        retailerCounts[retailer] = (retailerCounts[retailer] || 0) + 1;
      });
      this.logger.log(`Job ${callbackData.jobId} results by retailer: ${JSON.stringify(retailerCounts)}`);

      // Log AutoTrader listings specifically
      const autoTraderListings = callbackData.data.filter((item: any) =>
        item.retailer === 'AutoTrader' || item.source === 'autotrader'
      );
      if (autoTraderListings.length > 0) {
        this.logger.log(`AutoTrader listings received (${autoTraderListings.length}):`);
        autoTraderListings.forEach((listing: any, idx: number) => {
          this.logger.log(`  [${idx + 1}] ${listing.name} - $${listing.price} - ${listing.url}`);
        });
      } else {
        this.logger.warn(`⚠️ NO AutoTrader listings found in callback data!`);
      }
    }

    this.logger.log(`Job ${callbackData.jobId} succeeded with ${callbackData.data?.length || 0} results`);
    await this.scraperService.handleJobSuccess(callbackData.jobId, callbackData.data);

    return { acknowledged: true, status: 'success' };
  }
}
