import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { AgentAuthService } from '../auth/agent-auth.service';
import { firstValueFrom } from 'rxjs';

export interface RoutingResult {
  content: string;
  commands?: any[];
  routed: true;
  specialist: string;
  extraction?: {
    groupId: string;
    urls: string[];
    streamUrl: string;
  };
}

@Injectable()
export class AgentRoutingService {
  private readonly logger = new Logger(AgentRoutingService.name);
  private readonly baseUrl: string;

  constructor(
    private httpService: HttpService,
    private configService: ConfigService,
    private agentAuthService: AgentAuthService,
  ) {
    const port = this.configService.get<number>('PORT', 3001);
    this.baseUrl = `http://localhost:${port}/api`;
  }

  /**
   * Route a message to a category specialist via HTTP self-call.
   * The specialist runs in the real user's context via agent JWT.
   */
  async routeToSpecialist(
    userId: string,
    categoryId: string,
    message: string,
    conversationContext?: string,
  ): Promise<RoutingResult> {
    const token = this.agentAuthService.generateAgentToken(userId, 'overview');

    // Build context-enriched message for the specialist
    let enrichedMessage = message;
    if (conversationContext) {
      enrichedMessage = `[Context from Overview Agent]\n${conversationContext}\n\n[User's Question]\n${message}`;
    }

    const url = `${this.baseUrl}/ai/specialist/category/${categoryId}/chat`;

    try {
      const response = await firstValueFrom(
        this.httpService.post(
          url,
          { message: enrichedMessage },
          {
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
            timeout: 30000,
          },
        ),
      );

      return {
        content: response.data.content,
        commands: response.data.commands,
        routed: true,
        specialist: categoryId,
        extraction: response.data.extraction,
      };
    } catch (error) {
      this.logger.error(
        `Failed to route to ${categoryId} specialist: ${error.message}`,
      );
      throw error;
    }
  }
}
