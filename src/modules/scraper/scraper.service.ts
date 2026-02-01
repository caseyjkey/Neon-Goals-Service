import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../config/prisma.service';
import { GoalType } from '@prisma/client';

const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

// Add stealth plugin
chromium.use(StealthPlugin());

interface ProductCandidate {
  id: string;
  name: string;
  price: number;
  retailer: string;
  url: string;
  image: string;
  condition?: 'new' | 'used' | 'refurbished';
  rating?: number;
  reviewCount?: number;
  inStock?: boolean;
  estimatedDelivery?: string;
  features?: string[];
  savings?: number;
}

@Injectable()
export class ScraperService {
  private readonly logger = new Logger(ScraperService.name);

  constructor(private prisma: PrismaService) {}

  /**
   * Queue a scraping job for a goal
   */
  async queueCandidateAcquisition(goalId: string): Promise<void> {
    await this.prisma.scrapeJob.create({
      data: {
        goalId,
        status: 'pending',
      },
    });
    this.logger.log(`Queued scraping job for goal: ${goalId}`);
  }

  /**
   * Background job processor - runs every 2 minutes
   */
  @Cron('*/2 * * * *')
  async processPendingJobs() {
    const jobs = await this.prisma.scrapeJob.findMany({
      where: {
        status: 'pending',
        attempts: { lt: 3 },
      },
      take: 5, // Process 5 at a time
      include: {
        goal: {
          include: {
            itemData: true,
          },
        },
      },
    });

    if (jobs.length === 0) {
      return;
    }

    this.logger.log(`Processing ${jobs.length} pending scrape jobs...`);

    for (const job of jobs) {
      try {
        // Mark as running
        await this.prisma.scrapeJob.update({
          where: { id: job.id },
          data: { status: 'running' },
        });

        // Check if category is supported
        const category = job.goal.itemData?.category || 'general';
        const supportedCategories = ['vehicle']; // Currently only vehicles have scrapers

        // TODO: Implement category-specific scrapers:
        //   - technology: Amazon, Best Buy, Newegg
        //   - furniture: Wayfair, IKEA, Article
        //   - sporting_goods: Dick's, REI, Academy
        //   - clothing: Nike, Zappos, ASOS
        //   - pets: Chewy, Petco, PetSmart
        //   - vehicle_parts: AutoZone, Advance Auto Parts, Rock Auto

        if (!supportedCategories.includes(category)) {
          this.logger.log(`⏭️ Skipping goal "${job.goal.title}" - category "${category}" not yet supported`);

          // Update statusBadge to not_supported for unsupported categories
          await this.prisma.itemGoalData.update({
            where: { goalId: job.goal.id },
            data: { statusBadge: 'not_supported' },
          });

          // Mark job as completed with error message
          await this.prisma.scrapeJob.update({
            where: { id: job.id },
            data: {
              status: 'completed',
              error: `Category "${category}" not yet supported. Supported: ${supportedCategories.join(', ')}`,
            },
          });
          continue;
        }

        // Acquire candidates
        const candidates = await this.acquireCandidatesForGoal(job.goal);

        // Determine statusBadge based on results
        const statusBadge = candidates.length > 0 ? 'in_stock' : 'not_found';

        // Update goal with candidates
        await this.prisma.itemGoalData.update({
          where: { goalId: job.goal.id },
          data: {
            candidates: candidates as any,
            statusBadge: statusBadge,
            productImage: candidates[0]?.image || job.goal.itemData?.productImage,
            category: job.goal.itemData?.category || 'vehicle',
            searchTerm: job.goal.itemData?.searchTerm || job.goal.title,
          },
        });

        // Mark job as complete
        await this.prisma.scrapeJob.update({
          where: { id: job.id },
          data: {
            status: 'completed',
            error: candidates.length === 0 ? 'No candidates found' : null,
          },
        });

        if (candidates.length === 0) {
          this.logger.warn(`⚠️ No candidates found for goal: ${job.goal.title} (marked as not_found)`);
        } else {
          this.logger.log(`✅ Populated ${candidates.length} candidates for goal: ${job.goal.title}`);
        }
      } catch (error) {
        // Mark as failed, increment attempts
        await this.prisma.scrapeJob.update({
          where: { id: job.id },
          data: {
            status: 'failed',
            attempts: job.attempts + 1,
            error: error.message,
          },
        });
        this.logger.error(`❌ Failed to scrape for job ${job.id}:`, error);
      }
    }
  }

  /**
   * Daily re-scrape all active item goals
   */
  @Cron('0 0 * * *') // Every day at midnight
  async refreshAllActiveCandidates() {
    const activeGoals = await this.prisma.goal.findMany({
      where: {
        type: GoalType.item,
        status: 'active',
      },
    });

    for (const goal of activeGoals) {
      await this.queueCandidateAcquisition(goal.id);
    }

    this.logger.log(
      `✅ Queued ${activeGoals.length} goals for daily re-scraping`,
    );
  }

  /**
   * Main method to acquire candidates for a goal
   */
  async acquireCandidatesForGoal(goal: any): Promise<ProductCandidate[]> {
    this.logger.log(`Acquiring candidates for: ${goal.title}`);

    // For vehicles, try to build structured URLs from searchFilters
    const isVehicle = goal.itemData?.category === 'vehicle';
    const searchFilters = (goal.itemData?.searchFilters as any) || null;

    // Determine search query - use searchTerm for vehicle goals, fallback to title
    const searchQuery = isVehicle && goal.itemData?.searchTerm
      ? goal.itemData.searchTerm
      : goal.title;

    this.logger.log(`Search query: ${searchQuery} (category: ${goal.itemData?.category || 'general'})`);

    if (isVehicle && searchFilters) {
      this.logger.log(`Search filters: ${JSON.stringify(searchFilters)}`);
    }

    // Try to scrape real data - throw error if both scrapers fail (no mock data)
    let candidates: ProductCandidate[];

    try {
      candidates = await this.scrapeFromWeb(searchQuery, isVehicle ? searchFilters : null);
      this.logger.log(`✅ Successfully scraped ${candidates.length} candidates`);
    } catch (error) {
      this.logger.error(`❌ All scraping methods failed for "${searchQuery}": ${error.message}`);
      throw new Error(`Failed to scrape candidates for "${goal.title}". Both camoufox and browser-use scrapers failed. Please try again later or contact support.`);
    }

    // Get denied and shortlisted candidate URLs to filter out
    const deniedCandidates = (goal.itemData?.deniedCandidates as any[]) || [];
    const shortlistedCandidates = (goal.itemData?.shortlistedCandidates as any[]) || [];
    const existingCandidates = (goal.itemData?.candidates as any[]) || [];

    const deniedUrls = new Set(deniedCandidates.map((c) => c.url));
    const shortlistedUrls = new Set(shortlistedCandidates.map((c) => c.url));
    const existingUrls = new Set(existingCandidates.map((c) => c.url));

    // Combine all URLs to exclude
    const excludedUrls = new Set([...deniedUrls, ...shortlistedUrls, ...existingUrls]);

    // Filter out candidates that are already in denied, shortlisted, or existing lists
    const filteredCandidates = candidates.filter(
      (candidate) => !excludedUrls.has(candidate.url),
    );

    this.logger.log(`Filtered out ${excludedUrls.size} existing candidates (${deniedUrls.size} denied, ${shortlistedUrls.size} shortlisted, ${existingUrls.size} existing)`);
    this.logger.log(`Returning ${filteredCandidates.length} new candidates`);

    return filteredCandidates;
  }

  /**
   * Scrape candidates from web - tries camoufox first (free), falls back to browser-use ($1.60)
   */
  private async scrapeFromWeb(query: string, vehicleData?: { make?: string; model?: string; year?: number; trim?: string; color?: string } | null): Promise<ProductCandidate[]> {
    // Try camoufox first (free, stealth Firefox)
    try {
      this.logger.log(`🦊 Trying camoufox (free) for: ${query}`);
      return await this.scrapeWithCamoufox(query, vehicleData);
    } catch (error) {
      this.logger.warn(`⚠️ Camoufox failed: ${error.message}`);
      this.logger.log(`🤖 Falling back to browser-use (cost: $1.60)`);
      return await this.scrapeWithBrowserUse(query);
    }
  }

  /**
   * Build structured URL for CarMax based on vehicle filters
   * CarMax URL format: /cars/{make}/{model}-{series}/{trim}/{color}
   * Examples:
   *   - /cars/gmc/sierra-1500
   *   - /cars/gmc/sierra-1500/denali
   *   - /cars/gmc/sierra-3500/denali/gray
   *   - /cars/ford/f-150/platinum/white
   *
   * Note: Series suffix "HD" is stripped (3500HD -> 3500)
   * Uses searchFilters JSONB structure with extracted series, trims array, and colors array
   */
  private buildCarMaxUrl(filters: any): string {
    const { make, model, series, trims, colors, bodyStyle } = filters || {};

    if (!make || !model) {
      return null; // Fall back to text search
    }

    const makeSlug = make.toLowerCase().replace(/\s+/g, '-');
    const modelSlug = model.toLowerCase().replace(/\s+/g, '-');

    // Build path segments
    const pathSegments: string[] = [];

    // Determine series - prefer explicit series, otherwise map from bodyStyle
    let determinedSeries = series;
    if (!determinedSeries && bodyStyle) {
      const bodyStyleLower = bodyStyle.toLowerCase();
      // Map body styles to series
      if (bodyStyleLower.includes('dual') || bodyStyleLower.includes('dually')) {
        determinedSeries = '3500HD'; // Dually = 1-ton = 3500HD
      } else if (bodyStyleLower.includes('3/4 ton') || bodyStyleLower.includes('three quarter')) {
        determinedSeries = '2500HD';
      } else if (bodyStyleLower.includes('1/2 ton') || bodyStyleLower.includes('half ton')) {
        determinedSeries = '1500';
      }
    }

    // Base path: model-series (strip "HD" suffix from series for URL)
    let basePath = modelSlug;
    if (determinedSeries) {
      // Strip "HD" suffix if present (3500HD -> 3500, 2500HD -> 2500)
      const seriesSlug = determinedSeries.toLowerCase().replace('hd', '');
      basePath = `${modelSlug}-${seriesSlug}`;
    }
    pathSegments.push(basePath);

    // Add trim level if provided (as separate path segment)
    const trimPatterns = ['denali', 'at4', 'elevation', 'slt', 'sle', 'titanium', 'platinum', 'lariat', 'limited', 'king ranch', 'xlt'];

    if (trims && Array.isArray(trims) && trims.length > 0) {
      const foundTrim = trims.find((t: string) => {
        const cleanTrim = t.toLowerCase().replace(/\s+/g, '');
        return trimPatterns.some(pattern => cleanTrim.includes(pattern));
      });

      if (foundTrim) {
        pathSegments.push(foundTrim.toLowerCase().replace(/\s+/g, '-'));
      }
    }

    // Add color if provided (as separate path segment)
    if (colors && Array.isArray(colors) && colors.length > 0) {
      const color = colors[0].toLowerCase();
      // Common color names CarMax uses
      const colorMap: { [key: string]: string } = {
        'black': 'black',
        'white': 'white',
        'gray': 'gray',
        'grey': 'gray',
        'silver': 'silver',
        'red': 'red',
        'blue': 'blue',
        'green': 'green',
        'brown': 'brown',
        'beige': 'beige',
        'gold': 'gold',
        'charcoal': 'charcoal',
      };
      if (colorMap[color]) {
        pathSegments.push(colorMap[color]);
      }
    }

    return `https://www.carmax.com/cars/${makeSlug}/${pathSegments.join('/')}`;
  }

  /**
   * Build structured URL for AutoTrader based on vehicle filters
   * AutoTrader URL format: /cars-for-sale/{make}/{model}-{series}/{location}?trimCode={code}|{trim}
   * Examples:
   *   - /cars-for-sale/gmc/sierra-3500/san-mateo-ca?trimCode=GMC3500PU|Denali
   *   - /cars-for-sale/ford/f-150/dallas-tx?trimCode=F150|Lariat
   *
   * Note: Series "HD" suffix is kept (3500HD -> 3500)
   * trimCode format: {seriesCode}|{trimName} (e.g., GMC3500PU|Denali Ultimate)
   */
  private buildAutoTraderUrl(filters: any): string {
    const { make, model, series, trims, year } = filters || {};

    if (!make || !model) {
      return null; // Fall back to text search
    }

    const makeSlug = make.toLowerCase().replace(/\s+/g, '-');
    const modelSlug = model.toLowerCase().replace(/\s+/g, '-');

    // Build path: /cars-for-sale/{make}/{model}-{series}/
    let path = `https://www.autotrader.com/cars-for-sale/${makeSlug}/${modelSlug}`;

    if (series) {
      // Strip "HD" suffix for AutoTrader (3500HD -> 3500)
      const seriesSlug = series.toLowerCase().replace('hd', '');
      path = `${path}-${seriesSlug}`;
    }

    // Add default location (required for AutoTrader)
    path += '/san-mateo-ca';

    // Build query parameters
    const params: string[] = ['searchRadius=500'];

    // Add trimCode if trims provided
    // Format: trimCode={seriesCode}|{trimName}
    // Common series codes: GMC1500P, GMC2500P, GMC3500PU, F150, etc.
    if (trims && Array.isArray(trims) && trims.length > 0) {
      // Map series to series code
      const seriesCodeMap: { [key: string]: string } = {
        '1500': 'GMC1500P',
        '2500hd': 'GMC2500P',
        '3500hd': 'GMC3500PU',
        '1500hd': 'GMC1500P',
      };

      // Get series code (default to make+model series if not found)
      let seriesCode = seriesCodeMap[series?.toLowerCase()] || `${makeSlug}${modelSlug}`.toUpperCase();

      // Add trim codes for each trim
      for (const trim of trims.slice(0, 3)) { // Max 3 trim codes
        const trimSlug = trim.replace(/\s+/g, ' ');
        params.push(`trimCode=${encodeURIComponent(`${seriesCode}|${trimSlug}`)}`);
      }
    }

    // Add year filter if provided
    if (year) {
      params.push(`year=${year}`);
    }

    return params.length > 1 ? `${path}?${params.join('&')}` : path;
  }

  /**
   * Build structured URL for KBB based on vehicle filters
   * KBB URL format: /{make}/{model}-{series}-{bodyStyle}/{year}/{trim}/
   * Examples:
   *   - /gmc/sierra-3500-hd-crew-cab/2026/denali-ultimate/
   *   - /ford/f-150/2025/xlt/
   *
   * Note: KBB keeps "HD" suffix (3500-hd, not 3500) unlike CarMax
   */
  private buildKBBUrl(filters: any): string {
    const { make, model, year, series, trims, bodyStyle } = filters || {};

    if (!make || !model || !year) {
      return null; // KBB requires year
    }

    const makeSlug = make.toLowerCase().replace(/\s+/g, '-');
    const modelSlug = model.toLowerCase().replace(/\s+/g, '-');

    // Build the model-series-bodyStyle path segment
    let basePath = modelSlug;

    if (series) {
      // KBB keeps "HD" suffix (3500HD -> 3500-hd)
      const seriesSlug = series.toLowerCase().replace(/\s+/g, '-');
      basePath = `${basePath}-${seriesSlug}`;
    }

    // Add body style if provided (crew-cab, extended-cab, etc.)
    if (bodyStyle) {
      const bodyStyleSlug = bodyStyle.toLowerCase().replace(/\s+/g, '-');
      // Map common body styles to KBB format
      const bodyStyleMap: { [key: string]: string } = {
        'crew-cab': 'crew-cab',
        'extended-cab': 'extended-cab',
        'regular-cab': 'regular-cab',
        'crew cab': 'crew-cab',
        'extended cab': 'extended-cab',
        'regular cab': 'regular-cab',
        'double-cab': 'double-cab',
        'access-cab': 'access-cab',
      };
      if (bodyStyleMap[bodyStyleSlug]) {
        basePath = `${basePath}-${bodyStyleMap[bodyStyleSlug]}`;
      }
    }

    // Build trim path segment
    let trimSegment = '';
    if (trims && Array.isArray(trims) && trims.length > 0) {
      trimSegment = trims[0].toLowerCase().replace(/\s+/g, '-');
    }

    // Assemble URL: /{make}/{model-series-bodyStyle}/{year}/{trim}/
    const url = `https://www.kbb.com/${makeSlug}/${basePath}/${year}/`;
    return trimSegment ? `${url}${trimSegment}/` : url;
  }

  /**
   * Build structured URL for TrueCar based on vehicle filters
   * TrueCar URL format: /{make}/{model}/{year}/
   */
  private buildTrueCarUrl(filters: any): string {
    const { make, model, year } = filters || {};

    if (!make || !model || !year) {
      return null; // TrueCar requires year
    }

    const makeSlug = make.toLowerCase().replace(/\s+/g, '-');
    const modelSlug = model.toLowerCase().replace(/\s+/g, '-');

    return `https://www.truecar.com/${makeSlug}/${modelSlug}/${year}/`;
  }

  /**
   * Scrape using camoufox (free, stealth Firefox browser)
   * Runs all 5 scrapers in parallel: CarGurus, CarMax, KBB, TrueCar, Carvana
   * Uses structured URLs if vehicle filters are available
   */
  private async scrapeWithCamoufox(query: string, vehicleData?: any): Promise<ProductCandidate[]> {
    try {
      const { exec } = require('child_process');
      const util = require('util');
      const execPromise = util.promisify(exec);

      const pythonPath = 'python3';
      const baseDir = '/home/trill/Development/neon-goals-service/scripts';

      // Build structured URLs for scrapers that support it
      const carMaxUrl = vehicleData?.make && vehicleData?.model ? this.buildCarMaxUrl(vehicleData) : null;
      const autoTraderUrl = vehicleData?.make && vehicleData?.model ? this.buildAutoTraderUrl(vehicleData) : null;
      const kbbUrl = vehicleData?.make && vehicleData?.model && vehicleData?.year ? this.buildKBBUrl(vehicleData) : null;
      const trueCarUrl = vehicleData?.make && vehicleData?.model && vehicleData?.year ? this.buildTrueCarUrl(vehicleData) : null;

      // Build scraper configs with custom URLs where available
      const scrapers = [
        { name: 'CarGurus', script: `${baseDir}/scrape-cars-camoufox.py`, url: null },
        { name: 'CarMax', script: `${baseDir}/scrape-carmax.py`, url: carMaxUrl },
        { name: 'AutoTrader', script: `${baseDir}/scrape-autotrader.py`, url: autoTraderUrl },
        { name: 'KBB', script: `${baseDir}/scrape-kbb.py`, url: kbbUrl },
        { name: 'TrueCar', script: `${baseDir}/scrape-truecar.py`, url: trueCarUrl },
        { name: 'Carvana', script: `${baseDir}/scrape-carvana-interactive.py`, url: null, useJsonFilters: true },
      ];

      this.logger.log(`🦊 Running all 6 camoufox scrapers for: ${query}`);
      if (carMaxUrl) this.logger.log(`📍 CarMax: ${carMaxUrl}`);
      if (autoTraderUrl) this.logger.log(`📍 AutoTrader: ${autoTraderUrl}`);
      if (kbbUrl) this.logger.log(`📍 KBB: ${kbbUrl}`);
      if (trueCarUrl) this.logger.log(`📍 TrueCar: ${trueCarUrl}`);
      if (vehicleData?.make) this.logger.log(`📍 Carvana: Interactive filter selection for ${vehicleData.make} ${vehicleData.model || ''}`);

      // Run all scrapers in parallel
      const results = await Promise.allSettled(
        scrapers.map(async (scraper) => {
          try {
            let searchArg;
            let cmdArgs = '5';

            // Build search argument based on scraper type
            if (scraper.name === 'TrueCar' && vehicleData) {
              // TrueCar: pass JSON filters for mmt[] parameter format
              searchArg = JSON.stringify(vehicleData);
            } else if (scraper.name === 'CarMax' && scraper.url) {
              // CarMax: use the structured URL we built
              searchArg = scraper.url;
            } else if (scraper.name === 'AutoTrader' && scraper.url) {
              // AutoTrader: use the structured URL we built with trimCode
              searchArg = scraper.url;
            } else if (scraper.name === 'KBB' && scraper.url) {
              // KBB: use the structured URL we built
              searchArg = scraper.url;
            } else if (scraper.name === 'Carvana' && scraper.useJsonFilters) {
              // Carvana: use interactive filter selection with JSON
              searchArg = JSON.stringify({
                make: vehicleData?.make,
                model: vehicleData?.model,
                series: vehicleData?.series,
                trims: vehicleData?.trims || [],
                year: vehicleData?.year
              });
            } else {
              // Use structured URL if available, otherwise fall back to query
              searchArg = scraper.url || query;
            }

            const { stdout, stderr } = await execPromise(
              `${pythonPath} ${scraper.script} '${searchArg}' ${cmdArgs}`,
              { timeout: 120000 }
            );

            if (stderr && !stderr.includes('[') && !stderr.includes('Launching')) {
              this.logger.warn(`${scraper.name} stderr: ${stderr.substring(0, 200)}`);
            }

            const result = JSON.parse(stdout);

            if (result.error) {
              throw new Error(`${scraper.name}: ${result.error}`);
            }

            this.logger.log(`✅ ${scraper.name}: ${result.length} listings`);
            return result;
          } catch (error) {
            this.logger.warn(`⚠️ ${scraper.name} failed: ${error.message}`);
            return [];
          }
        })
      );

      // Combine all successful results
      const allListings = results
        .filter((r) => r.status === 'fulfilled')
        .flatMap((r: any) => r.value)
        .filter((item: any) => item && item.price > 0);

      this.logger.log(`🦊 Total listings from all sources: ${allListings.length}`);

      // Convert to ProductCandidate format
      const candidates: ProductCandidate[] = allListings.map((item: any, index: number) => {
        const features = [];
        if (item.mileage && item.mileage > 0) {
          features.push(`${item.mileage.toLocaleString()} mi`);
        }

        return {
          id: `${item.retailer?.toLowerCase() || 'scraper'}-${Date.now()}-${index}`,
          name: item.name,
          price: Math.round(item.price),
          retailer: item.retailer || 'Unknown',
          url: item.url,
          image: item.image || this.getRandomTruckImage(),
          condition: 'used',
          rating: 4.5 + Math.random() * 0.5,
          reviewCount: Math.floor(Math.random() * 150) + 50,
          inStock: true,
          estimatedDelivery: item.location || 'Contact seller',
          features: features,
        };
      });

      if (candidates.length === 0) {
        throw new Error('No listings found across all 5 sources');
      }

      this.logger.log(`✅ Returning ${candidates.length} total candidates (FREE)`);
      return candidates;

    } catch (error) {
      this.logger.error(`❌ Multi-site camoufox scraping failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Scrape using browser-use (AI agent, costs $1.60 per scrape)
   */
  private async scrapeWithBrowserUse(query: string): Promise<ProductCandidate[]> {
    try {
      const { exec } = require('child_process');
      const util = require('util');
      const execPromise = util.promisify(exec);

      // Call the Python browser-use script
      const scriptPath = '/home/trill/Development/neon-goals-service/scripts/scrape-cars.py';
      const pythonPath = '/home/trill/Development/browser-use/.venv/bin/python';

      this.logger.log(`🤖 Running browser-use agent...`);

      const { stdout, stderr } = await execPromise(
        `${pythonPath} ${scriptPath} "${query}" 3`,
        { timeout: 120000 } // 2 minute timeout - ChatBrowserUse is fast (68s avg)
      );

      if (stderr) {
        this.logger.warn(`Browser-use stderr: ${stderr}`);
      }

      // Parse the JSON output
      const result = JSON.parse(stdout);

      if (result.error) {
        throw new Error(`Browser-use error: ${result.error}`);
      }

      // Convert browser-use results to ProductCandidate format
      const candidates: ProductCandidate[] = result.map((item: any, index: number) => {
        const features = [];

        // Add mileage as primary feature if available
        if (item.mileage && item.mileage > 0) {
          features.push(`${item.mileage.toLocaleString()} mi`);
        }

        // Add any other features from the scraper
        if (item.features && Array.isArray(item.features)) {
          features.push(...item.features);
        }

        return {
          id: `cargurus-${Date.now()}-${index}`,
          name: item.name,
          price: Math.round(item.price),
          retailer: item.retailer || 'CarGurus',
          url: item.url,
          image: item.image || this.getRandomTruckImage(), // Use real image from scraper
          condition: 'used',
          rating: 4.5 + Math.random() * 0.5,
          reviewCount: Math.floor(Math.random() * 150) + 50,
          inStock: true,
          estimatedDelivery: item.location || 'Contact seller',
          features: features,
        };
      });

      this.logger.log(`✅ Browser-use found ${candidates.length} candidates`);

      if (candidates.length === 0) {
        throw new Error('No listings found. Browser-use agent could not find any results.');
      }

      return candidates;

    } catch (error) {
      this.logger.error(`❌ Browser-use scraping failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Scrape AutoTrader listings
   */
  private async scrapeAutoTrader(page: any, query: string): Promise<ProductCandidate[]> {
    const candidates: ProductCandidate[] = [];

    // Build AutoTrader search URL
    const searchUrl = `https://www.autotrader.com/cars-for-sale/all-cars/cars-under-50000/${encodeURIComponent(query.replace(/\s+/g, '-').toLowerCase())}`;

    this.logger.log(`Navigating to: ${searchUrl}`);
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(5000);

    // Debug: Check page title and URL
    const pageTitle = await page.title();
    const pageUrl = page.url();
    this.logger.log(`Page loaded: ${pageTitle} at ${pageUrl}`);

    // Wait for listings to load - AutoTrader uses h2 for vehicle titles
    try {
      await page.waitForSelector('h2', { timeout: 10000 });
    } catch (error) {
      this.logger.warn(`No listings found on AutoTrader`);

      // Debug: Take screenshot to see what's on the page
      const screenshotPath = `/tmp/autotrader-error-${Date.now()}.png`;
      await page.screenshot({ path: screenshotPath });
      this.logger.warn(`Screenshot saved to: ${screenshotPath}`);

      throw new Error('No listings found on AutoTrader. The page may have loaded incorrectly or there are no results for this search.');
    }

    // Get all listing cards
    const listings = await page.evaluate(() => {
      const results: any[] = [];

      // Find all h2 headings (vehicle titles)
      const headings = Array.from(document.querySelectorAll('h2'));

      headings.forEach((heading, index) => {
        if (index >= 10) return; // Limit to 10

        // Get the container - typically a parent div with listing data
        const container = heading.closest('[data-cmp="inventoryListing"]') ||
                         heading.closest('article') ||
                         heading.parentElement?.parentElement?.parentElement;

        if (!container) return;

        // Find the link (usually the h2 is wrapped in an anchor)
        const link = heading.closest('a') || container.querySelector('a[href*="/cars-for-sale/vehicledetails"]');

        // Get all text from container
        const text = container.textContent || '';

        // Extract price - look for $ followed by numbers
        const priceMatch = text.match(/\$\s*([\d,]+)/);

        // Extract mileage - look for numbers followed by "mi"
        const mileageMatch = text.match(/([\d,]+)\s*mi/);

        // Get image
        const img = container.querySelector('img');

        // Only add if we have minimum required data
        if (heading.textContent && link && priceMatch) {
          results.push({
            title: heading.textContent.trim(),
            price: priceMatch[1], // Get the number part without $
            mileage: mileageMatch ? mileageMatch[0] : null,
            url: link.href,
            image: img?.src || null,
          });
        }
      });

      return results;
    });

    this.logger.log(`Found ${listings.length} AutoTrader listings`);

    if (listings.length === 0) {
      throw new Error('AutoTrader returned no listings. The search may not have found any vehicles matching the criteria.');
    }

    for (let i = 0; i < Math.min(listings.length, 10); i++) {
      try {
        const listing = listings[i];

        if (listing.title && listing.price && listing.url) {
          const priceNum = parseFloat(listing.price.replace(/,/g, '')) || 20000;

          candidates.push({
            id: `autotrader-${Date.now()}-${i}`,
            name: listing.title,
            price: Math.round(priceNum),
            retailer: 'AutoTrader',
            url: listing.url,
            image: listing.image || this.getRandomTruckImage(),
            condition: 'used',
            rating: 4.5 + Math.random() * 0.5,
            reviewCount: Math.floor(Math.random() * 150) + 50,
            inStock: true,
            estimatedDelivery: 'Contact seller',
            features: listing.mileage ? [listing.mileage] : [],
          });
        }
      } catch (error) {
        this.logger.warn(`Failed to parse AutoTrader listing ${i}: ${error.message}`);
      }
    }

    return candidates;
  }


  private getRandomTruckImage(): string {
    const images = [
      'https://images.unsplash.com/photo-1533473359331-0135ef1b58bf?w=800',
      'https://images.unsplash.com/photo-1519641471654-76ce0107ad1b?w=800',
      'https://images.unsplash.com/photo-1552519507-da3b142c6e3d?w=800',
      'https://images.unsplash.com/photo-1533473359331-0135ef1b58bf?w=800',
    ];
    return images[Math.floor(Math.random() * images.length)];
  }

  private getRandomDelivery(): string {
    const options = [
      'Available now',
      'Same day pickup',
      '2-3 days',
      '5-7 days',
      'Home delivery available',
      'In-store pickup only',
    ];
    return options[Math.floor(Math.random() * options.length)];
  }

  private getRandomFeatures(): string[] {
    const allFeatures = [
      '4WD',
      'V6 Engine',
      'Low mileage',
      'Crew Cab',
      'Tow package',
      'Certified',
      'Single owner',
      'Clean title',
      'Leather seats',
      'Navigation',
      'Backup camera',
      'Bluetooth',
    ];

    const count = 3 + Math.floor(Math.random() * 3);
    const shuffled = allFeatures.sort(() => Math.random() - 0.5);
    return shuffled.slice(0, count);
  }

  /**
   * Generate mock candidates for testing
   */
  private getMockCandidates(title: string): ProductCandidate[] {
    return [
      {
        id: `mock-${Date.now()}-1`,
        name: `${title} - Option 1`,
        price: 25000 + Math.random() * 10000,
        retailer: 'AutoTrader',
        url: `https://www.autotrader.com/mock-${Date.now()}-1`,
        image: 'https://images.unsplash.com/photo-1533473359331-0135ef1b58bf?w=800',
        condition: 'used',
        rating: 4.5,
        reviewCount: 120,
        inStock: true,
        estimatedDelivery: 'Available now',
        features: ['4WD', 'V6 Engine', 'Low mileage'],
      },
      {
        id: `mock-${Date.now()}-2`,
        name: `${title} - Option 2`,
        price: 27000 + Math.random() * 10000,
        retailer: 'Cars.com',
        url: `https://www.cars.com/mock-${Date.now()}-2`,
        image: 'https://images.unsplash.com/photo-1519641471654-76ce0107ad1b?w=800',
        condition: 'used',
        rating: 4.7,
        reviewCount: 85,
        inStock: true,
        estimatedDelivery: 'Available now',
        features: ['Crew Cab', 'Tow package', 'Certified'],
      },
      {
        id: `mock-${Date.now()}-3`,
        name: `${title} - Option 3`,
        price: 23000 + Math.random() * 10000,
        retailer: 'Carvana',
        url: `https://www.carvana.com/mock-${Date.now()}-3`,
        image: 'https://images.unsplash.com/photo-1552519507-da3b142c6e3d?w=800',
        condition: 'used',
        rating: 4.3,
        reviewCount: 200,
        inStock: true,
        estimatedDelivery: '7-day delivery',
        features: ['Single owner', 'Clean title', '60k miles'],
      },
    ];
  }

  /**
   * Deduplicate candidates by URL
   */
  private deduplicateByUrl(
    candidates: ProductCandidate[],
  ): ProductCandidate[] {
    const seen = new Set<string>();
    return candidates.filter((c) => {
      if (seen.has(c.url)) return false;
      seen.add(c.url);
      return true;
    });
  }
}
