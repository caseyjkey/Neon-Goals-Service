import { Controller, Post, Body, Logger, UseGuards } from '@nestjs/common';
import { VehicleQueryService } from './vehicle-query.service';
import { JwtOrApiKeyGuard } from '../../common/guards/jwt-or-api-key.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

interface ParseQueryDto {
  query: string;
  useLlm?: boolean;
  scraper?: 'carmax' | 'cargurus' | 'autotrader' | 'truecar' | 'carvana';
}

@Controller('scrapers/vehicle-query')
@UseGuards(JwtOrApiKeyGuard)
export class VehicleQueryController {
  private readonly logger = new Logger(VehicleQueryController.name);

  constructor(private vehicleQueryService: VehicleQueryService) {}

  /**
   * Parse a natural language vehicle query into structured format
   * POST /scrapers/vehicle-query/parse
   *
   * This endpoint wraps parse_vehicle_query.py to convert natural language
   * queries into a structured format compatible with all car scrapers.
   *
   * Body:
   *   {
   *     "query": "GMC Sierra Denali under $50000",
   *     "useLlm": false,
   *     "scraper": "carmax" // Optional: converts to scraper-specific params
   *   }
   *
   * Returns:
   *   - Without scraper: Universal structured format
   *   - With scraper: Scraper-specific parameters
   */
  @Post('parse')
  async parseQuery(
    @Body() dto: ParseQueryDto,
    @CurrentUser('userId') userId: string,
  ) {
    this.logger.log(`User ${userId} parsing query: "${dto.query}"`);

    try {
      // Parse the query into universal structured format
      const result = await this.vehicleQueryService.parseQuery(
        dto.query,
        dto.useLlm || false,
      );

      // If a specific scraper is requested, adapt the parameters
      if (dto.scraper) {
        const scraperParams = this.vehicleQueryService.adaptToScraper(
          result.structured,
          dto.scraper,
        );

        return {
          originalQuery: result.query,
          structured: result.structured,
          scraper: dto.scraper,
          scraperParams,
        };
      }

      // Return universal structured format
      return {
        originalQuery: result.query,
        structured: result.structured,
      };
    } catch (error) {
      this.logger.error(`Parse error: ${error.message}`);
      return {
        error: error.message,
        query: dto.query,
      };
    }
  }

  /**
   * Parse and adapt to multiple scrapers at once
   * POST /scrapers/vehicle-query/parse-all
   *
   * Returns the structured format plus scraper-specific params
   * for all supported scrapers.
   */
  @Post('parse-all')
  async parseForAllScrapers(
    @Body() dto: { query: string; useLlm?: boolean },
    @CurrentUser('userId') userId: string,
  ) {
    this.logger.log(`User ${userId} parsing for all scrapers: "${dto.query}"`);

    try {
      const result = await this.vehicleQueryService.parseQuery(
        dto.query,
        dto.useLlm || false,
      );

      const scrapers = ['carmax', 'cargurus', 'autotrader', 'truecar', 'carvana'] as const;
      const scraperParams: Record<string, any> = {};

      for (const scraper of scrapers) {
        try {
          scraperParams[scraper] = this.vehicleQueryService.adaptToScraper(
            result.structured,
            scraper,
          );
        } catch (error) {
          this.logger.warn(`Failed to adapt for ${scraper}: ${error.message}`);
          scraperParams[scraper] = { error: error.message };
        }
      }

      return {
        originalQuery: result.query,
        structured: result.structured,
        scraperParams,
      };
    } catch (error) {
      this.logger.error(`Parse error: ${error.message}`);
      return {
        error: error.message,
        query: dto.query,
      };
    }
  }
}
