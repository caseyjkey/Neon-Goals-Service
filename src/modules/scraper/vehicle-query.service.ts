import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Vehicle Query Parser Service
 *
 * Wraps the parse_vehicle_query.py Python script to convert
 * natural language vehicle queries into structured format compatible
 * with all car scrapers.
 */
@Injectable()
export class VehicleQueryService {
  private readonly logger = new Logger(VehicleQueryService.name);
  private readonly scriptPath: string;

  constructor(private configService: ConfigService) {
    this.scriptPath = `${process.cwd()}/scripts/parse_vehicle_query.py`;
  }

  /**
   * Parse a natural language vehicle query into structured format
   *
   * @param query Natural language query like "GMC Sierra Denali under $50000"
   * @param useLlm Whether to use LLM parsing (default: false, uses pattern matching)
   * @returns Structured query with makes, models, trims, year range, price range, etc.
   */
  async parseQuery(query: string, useLlm: boolean = false): Promise<{
    query: string;
    structured: {
      makes: string[];
      models: string[];
      trims: string[];
      year: number | null;
      yearMin: number | null;
      yearMax: number | null;
      minPrice: number | null;
      maxPrice: number | null;
      drivetrain: string | null;
      fuelType: string | null;
      bodyType: string | null;
      transmission: string | null;
      doors: string | null;
      cylinders: string | null;
      exteriorColor: string | null;
      interiorColor: string | null;
      features: string[];
      location: {
        zip: string | null;
        distance: number | null;
        city: string | null;
        state: string | null;
      };
    };
  }> {
    try {
      const { exec } = require('child_process');
      const util = require('util');
      const execPromise = util.promisify(exec);

      const pythonPath = 'python3';
      const useLlmArg = useLlm ? 'true' : 'false';

      this.logger.log(`Parsing vehicle query: "${query}" (use_llm: ${useLlm})`);

      const { stdout, stderr } = await execPromise(
        `${pythonPath} ${this.scriptPath} '${query.replace(/'/g, "\\'")}' ${useLlmArg}`,
        {
          timeout: 30000,
          env: {
            ...process.env,
            OPENAI_API_KEY: this.configService.get<string>('OPENAI_API_KEY'),
          },
        },
      );

      if (stderr) {
        this.logger.warn(`Parser stderr: ${stderr}`);
      }

      const result = JSON.parse(stdout);

      if (result.error) {
        throw new Error(result.error);
      }

      this.logger.log(`✅ Parsed query: ${JSON.stringify(result.structured).substring(0, 200)}...`);

      return result;
    } catch (error) {
      this.logger.error(`❌ Failed to parse vehicle query: ${error.message}`);
      throw new Error(`Failed to parse vehicle query: ${error.message}`);
    }
  }

  /**
   * Convert structured format to scraper-specific parameters
   *
   * This is a TypeScript version of the Python adapter functions.
   * Each scraper has its own adapter that converts the universal
   * structured format to scraper-specific params.
   *
   * @param structured The structured query from parseQuery()
   * @param scraper The target scraper (carmax, cargurus, autotrader, truecar, carvana)
   * @returns Scraper-specific parameters
   */
  adaptToScraper(structured: any, scraper: string): any {
    switch (scraper) {
      case 'carmax':
        return this.adaptToCarMax(structured);
      case 'cargurus':
        return this.adaptToCarGurus(structured);
      case 'autotrader':
        return this.adaptToAutoTrader(structured);
      case 'truecar':
        return this.adaptToTrueCar(structured);
      case 'carvana':
        return this.adaptToCarvana(structured);
      default:
        throw new Error(`Unknown scraper: ${scraper}`);
    }
  }

  private adaptToCarMax(structured: any): any {
    const params: any = {};

    if (structured.makes?.length) params.makes = structured.makes;
    if (structured.models?.length) params.models = structured.models;
    if (structured.trims?.length) params.trims = structured.trims;
    if (structured.exteriorColor) params.colors = [structured.exteriorColor];
    if (structured.interiorColor) params.colors = [...(params.colors || []), structured.interiorColor];
    if (structured.bodyType) params.bodyType = structured.bodyType;
    if (structured.fuelType) params.fuelType = structured.fuelType;
    if (structured.drivetrain) params.drivetrain = structured.drivetrain;
    if (structured.transmission) params.transmission = structured.transmission;
    if (structured.minPrice != null) params.minPrice = structured.minPrice;
    if (structured.maxPrice != null) params.maxPrice = structured.maxPrice;
    if (structured.features?.length) params.features = structured.features;

    return params;
  }

  private adaptToCarGurus(structured: any): any {
    const params: any = {};

    if (structured.makes?.length) params.make = structured.makes[0];
    if (structured.models?.length) params.model = structured.models[0];
    if (structured.trims?.length) params.trim = structured.trims[0];

    // Drivetrain mapping
    const drivetrainMap: Record<string, string> = {
      'Four Wheel Drive': 'FOUR_WHEEL_DRIVE',
      'All Wheel Drive': 'ALL_WHEEL_DRIVE',
      'Rear Wheel Drive': 'REAR_WHEEL_DRIVE',
      'Front Wheel Drive': 'FRONT_WHEEL_DRIVE',
    };
    if (structured.drivetrain && drivetrainMap[structured.drivetrain]) {
      params.drivetrain = drivetrainMap[structured.drivetrain];
    }

    // Fuel type mapping
    const fuelMap: Record<string, string> = {
      'Gas': 'GASOLINE',
      'Electric': 'ELECTRIC',
      'Hybrid': 'HYBRID',
      'Plug-In Hybrid': 'PLUG_IN_HYBRID',
      'Diesel': 'DIESEL',
    };
    if (structured.fuelType && fuelMap[structured.fuelType]) {
      params.fuelType = fuelMap[structured.fuelType];
    }

    if (structured.exteriorColor) params.exteriorColor = structured.exteriorColor;

    // Year range
    if (structured.year) params.year = structured.year;
    if (structured.yearMin) params.yearMin = structured.yearMin;
    if (structured.yearMax) params.yearMax = structured.yearMax;

    // Price range
    if (structured.minPrice != null) params.minPrice = structured.minPrice;
    if (structured.maxPrice != null) params.maxPrice = structured.maxPrice;

    // Location
    if (structured.location?.zip) params.zip = structured.location.zip;
    if (structured.location?.distance) params.distance = structured.location.distance;

    return params;
  }

  private adaptToAutoTrader(structured: any): string {
    const parts: string[] = [];

    if (structured.makes?.length) parts.push(...structured.makes);
    if (structured.models?.length) parts.push(...structured.models);
    if (structured.trims?.length) parts.push(...structured.trims);
    if (structured.exteriorColor) parts.push(structured.exteriorColor);

    let query = parts.join(' ');

    if (structured.location?.zip) {
      query += ` near ${structured.location.zip}`;
    } else if (structured.location?.city) {
      query += ` near ${structured.location.city}`;
      if (structured.location.state) {
        query += `, ${structured.location.state}`;
      }
    }

    return query;
  }

  private adaptToTrueCar(structured: any): any {
    const params: any = {};

    if (structured.makes?.length) params.make = structured.makes[0];
    if (structured.models?.length) params.model = structured.models[0];
    if (structured.trims?.length) params.trims = [structured.trims[0]];

    if (structured.year) {
      params.year = structured.year;
    } else {
      if (structured.yearMin) params.startYear = structured.yearMin;
      if (structured.yearMax) params.endYear = structured.yearMax;
    }

    if (structured.maxPrice != null) params.budget = structured.maxPrice;
    if (structured.bodyType) params.bodyStyle = structured.bodyType;
    if (structured.drivetrain) params.drivetrain = structured.drivetrain;
    if (structured.fuelType) params.fuelType = structured.fuelType;

    return params;
  }

  private adaptToCarvana(structured: any): any {
    const params: any = {};

    if (structured.makes?.length) params.make = structured.makes[0];
    if (structured.models?.length) params.model = structured.models[0];
    if (structured.trims?.length) params.trims = structured.trims;
    if (structured.year) params.year = structured.year;

    return params;
  }
}
