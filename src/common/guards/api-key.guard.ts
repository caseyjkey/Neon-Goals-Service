import { Injectable, CanActivate, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * API Key Authentication Guard
 *
 * Allows external agents to access API endpoints using an API key
 * instead of JWT authentication. This is used for agent-to-agent
 * communication and automated integrations.
 *
 * Usage:
 * @UseGuards(JwtAuthGuard, ApiKeyGuard)  // Allow either auth method
 * @UseGuards(new ApiKeyGuard({ requireJwt: false }))  // API key only
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  protected readonly apiKey: string;

  constructor(private configService: ConfigService) {
    this.apiKey = this.configService.get<string>('AGENT_API_KEY') || '';
    if (!this.apiKey) {
      console.warn('AGENT_API_KEY not configured - ApiKeyGuard will reject all requests');
    }
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const apiKey = request.headers['x-api-key'];

    // If no API key provided, check if request has user (from JWT)
    if (!apiKey) {
      // Allow if JWT auth already authenticated the user
      if (request.user) {
        return true;
      }
      throw new UnauthorizedException('API key missing');
    }

    // Validate API key
    if (apiKey !== this.apiKey) {
      throw new UnauthorizedException('Invalid API key');
    }

    // Set a fake user object for consistent downstream handling
    // In production, you might want to track which agent is making the request
    request.user = {
      id: 'agent',
      userId: 'agent',
      isAgent: true,
    };

    return true;
  }
}

/**
 * API Key Only Guard
 *
 * Requires API key authentication, does NOT accept JWT
 * Use for endpoints that should only be accessible to agents
 */
@Injectable()
export class ApiKeyOnlyGuard extends ApiKeyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const apiKey = request.headers['x-api-key'];

    if (!apiKey) {
      throw new UnauthorizedException('API key required (not JWT accepted)');
    }

    if (apiKey !== this.apiKey) {
      throw new UnauthorizedException('Invalid API key');
    }

    request.user = {
      id: 'agent',
      userId: 'agent',
      isAgent: true,
    };

    return true;
  }
}
