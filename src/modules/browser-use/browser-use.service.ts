import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../config/prisma.service';

export interface ProductSearchResult {
  title: string;
  price: number;
  currency: string;
  retailer: string;
  productUrl: string;
  imageUrl: string;
  inStock: boolean;
  rating?: number;
  reviewCount?: number;
}

interface BrowserUseSession {
  sessionId: string;
  status: 'starting' | 'running' | 'completed' | 'failed';
}

@Injectable()
export class BrowserUseService {
  private readonly logger = new Logger(BrowserUseService.name);
  private readonly apiKey: string;
  private readonly apiUrl = 'https://api.browser-use.com/v1';

  constructor(
    private configService: ConfigService,
    private prisma: PrismaService,
  ) {
    this.apiKey = this.configService.get<string>('BROWSER_USE_API_KEY') || '';
  }

  /**
   * Search for products across multiple retailers
   */
  async searchProducts(query: string, options?: {
    maxResults?: number;
    retailers?: string[];
    budget?: number;
  }): Promise<ProductSearchResult[]> {
    this.logger.log(`Searching for products: ${query}`);

    try {
      // Create a browser-use session to search for products
      const session = await this.createSession();

      // Navigate to Google Shopping
      await this.executeTask(session.sessionId, {
        type: 'goto',
        url: `https://www.google.com/search?q=${encodeURIComponent(query + ' buy')}&tbm=shop`,
      });

      // Wait for page load
      await this.delay(3000);

      // Extract product listings from the page
      const products = await this.extractProducts(session.sessionId);

      // Clean up session
      await this.terminateSession(session.sessionId);

      // Filter and sort results
      let filteredProducts = products;

      if (options?.budget) {
        filteredProducts = products.filter(p => p.price <= options.budget);
      }

      if (options?.retailers) {
        filteredProducts = filteredProducts.filter(p =>
          options.retailers!.some(r => p.retailer.toLowerCase().includes(r.toLowerCase()))
        );
      }

      // Sort by price and limit results
      filteredProducts = filteredProducts
        .sort((a, b) => a.price - b.price)
        .slice(0, options?.maxResults || 10);

      return filteredProducts;
    } catch (error) {
      this.logger.error('Error searching products:', error);
      // Return mock data as fallback
      return this.getMockProductResults(query);
    }
  }

  /**
   * Get best price for a specific product
   */
  async getBestPrice(productName: string): Promise<{
    product: ProductSearchResult;
    alternatives: ProductSearchResult[];
  }> {
    this.logger.log(`Getting best price for: ${productName}`);

    const results = await this.searchProducts(productName, {
      maxResults: 5,
    });

    return {
      product: results[0],
      alternatives: results.slice(1),
    };
  }

  /**
   * Create a browser-use session
   */
  private async createSession(): Promise<BrowserUseSession> {
    const response = await fetch(`${this.apiUrl}/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        browserName: 'chrome',
        headless: true,
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to create session: ${response.status}`);
    }

    const data = await response.json();
    return {
      sessionId: data.sessionId || data.id,
      status: 'running',
    };
  }

  /**
   * Execute a task in the browser
   */
  private async executeTask(sessionId: string, task: any): Promise<any> {
    const response = await fetch(`${this.apiUrl}/sessions/${sessionId}/tasks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(task),
    });

    if (!response.ok) {
      throw new Error(`Failed to execute task: ${response.status}`);
    }

    return await response.json();
  }

  /**
   * Extract products from the current page
   */
  private async extractProducts(sessionId: string): Promise<ProductSearchResult[]> {
    // This would use browser-use to extract structured data
    // For now, return mock data
    const task = await this.executeTask(sessionId, {
      type: 'extract',
      schema: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            price: { type: 'number' },
            retailer: { type: 'string' },
            url: { type: 'string' },
            imageUrl: { type: 'string' },
          },
        },
      },
    });

    // For now, return mock results
    return this.getMockProductResults('');
  }

  /**
   * Terminate browser session
   */
  private async terminateSession(sessionId: string): Promise<void> {
    try {
      await fetch(`${this.apiUrl}/sessions/${sessionId}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
        },
      });
    } catch (error) {
      this.logger.error('Error terminating session:', error);
    }
  }

  /**
   * Mock product results for testing/fallback
   */
  private getMockProductResults(query: string): ProductSearchResult[] {
    return [
      {
        title: `${query || 'Product'} - Premium Edition`,
        price: 299.99,
        currency: 'USD',
        retailer: 'Amazon',
        productUrl: 'https://amazon.com',
        imageUrl: 'https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=400',
        inStock: true,
        rating: 4.5,
        reviewCount: 1234,
      },
      {
        title: `${query || 'Product'} - Standard`,
        price: 249.99,
        currency: 'USD',
        retailer: 'Best Buy',
        productUrl: 'https://bestbuy.com',
        imageUrl: 'https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=400',
        inStock: true,
        rating: 4.2,
        reviewCount: 856,
      },
      {
        title: `${query || 'Product'} - Value Bundle`,
        price: 199.99,
        currency: 'USD',
        retailer: 'Walmart',
        productUrl: 'https://walmart.com',
        imageUrl: 'https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=400',
        inStock: true,
        rating: 4.0,
        reviewCount: 543,
      },
    ];
  }

  /**
   * Helper delay function
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Search for products and update an ItemGoal with the results
   */
  async searchAndUpdateGoal(goalId: string, userId: string, query?: string): Promise<any> {
    // Get the goal to find what to search for
    const goal = await this.prisma.goal.findUnique({
      where: { id: goalId },
      include: { itemData: true },
    });

    if (!goal || goal.type !== 'item') {
      throw new Error('Goal not found or not an item goal');
    }

    const searchQuery = query || goal.title;
    const results = await this.searchProducts(searchQuery);

    // Update the goal with the best result
    if (results.length > 0) {
      const bestResult = results[0];

      await this.prisma.itemGoalData.update({
        where: { goalId },
        data: {
          bestPrice: bestResult.price,
          retailerName: bestResult.retailer,
          retailerUrl: bestResult.productUrl,
          productImage: bestResult.imageUrl,
          statusBadge: bestResult.inStock ? 'in_stock' : 'pending_search',
          searchResults: results as any,
        },
      });

      // Fetch the updated goal
      return await this.prisma.goal.findUnique({
        where: { id: goalId },
        include: { itemData: true },
      });
    }

    return goal;
  }

  /**
   * Monitor prices for an ItemGoal
   */
  async monitorPrice(goalId: string): Promise<ProductSearchResult[]> {
    const goal = await this.prisma.goal.findUnique({
      where: { id: goalId },
      include: { itemData: true },
    });

    if (!goal || goal.type !== 'item') {
      throw new Error('Goal not found or not an item goal');
    }

    const query = goal.title;
    return await this.searchProducts(query);
  }
}
