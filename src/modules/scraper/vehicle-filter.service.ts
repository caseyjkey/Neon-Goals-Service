import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { exec } from 'child_process';
import { promisify } from 'util';

const execPromise = promisify(exec);

/**
 * Vehicle Filter Service - Parses natural language queries into retailer-specific filters
 * Uses Python script with LLM to generate filter mappings for all 5 retailers
 */
@Injectable()
export class VehicleFilterService {
  private readonly logger = new Logger(VehicleFilterService.name);
  private readonly pythonPath = 'python3';
  private readonly scriptPath = `${process.cwd()}/scripts/parse_vehicle_query.py`;

  constructor(private configService: ConfigService) {}

  /**
   * Parse a natural language vehicle query into retailer-specific filters
   * @param query Natural language query (e.g., "2023-2024 GMC Sierra 3500HD Denali Ultimate black color")
   * @returns Retailer-specific filter mappings for all 5 retailers
   */
  async parseQuery(query: string): Promise<{
    query: string;
    retailers: {
      autotrader?: { url: string; filters: any };
      cargurus?: { url: string; filters: any };
      carmax?: { url: string; filters: any };
      carvana?: { url: string; filters: any };
      truecar?: { url: string; filters: any };
    };
    error?: string;
  } | null> {
    try {
      this.logger.log(`Parsing vehicle query: "${query}"`);

      const { stdout, stderr } = await execPromise(
        `${this.pythonPath} ${this.scriptPath} '${query.replace(/'/g, "'\\''")}'`,
        {
          timeout: 60000, // 1 minute timeout
          env: {
            ...process.env,
            // Pass API keys to Python script
            OPENAI_API_KEY: this.configService.get<string>('OPENAI_API_KEY') || '',
            GLM_API_KEY: this.configService.get<string>('GLM_API_KEY') || '',
            ZHIPU_API_KEY: this.configService.get<string>('ZHIPU_API_KEY') || '',
            DEEPSEEK_API_KEY: this.configService.get<string>('DEEPSEEK_API_KEY') || '',
          },
        }
      );

      if (stderr) {
        this.logger.warn(`LLM parse stderr: ${stderr.substring(0, 200)}`);
      }

      const result = JSON.parse(stdout);

      if (result.error) {
        this.logger.error(`LLM parse error: ${result.error}`);
        return null;
      }

      this.logger.log(`Successfully parsed query for ${Object.keys(result.retailers || {}).length} retailers`);

      return result;
    } catch (error) {
      this.logger.error(`Failed to parse vehicle query: ${error.message}`);
      return null;
    }
  }

  /**
   * Extract filters for a specific retailer
   * @param retailerFilters The full retailer filters object
   * @param retailer Name of the retailer (autotrader, cargurus, carmax, carvana, truecar)
   * @returns Filter object for the specified retailer or null if not found
   */
  getFiltersForRetailer(retailerFilters: any, retailer: string): { url: string; filters: any } | null {
    if (!retailerFilters || !retailerFilters.retailers) {
      return null;
    }

    return retailerFilters.retailers[retailer] || null;
  }
}
