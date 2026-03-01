import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Observable } from 'rxjs';
import { fromEvent } from 'rxjs';
import { EventEmitter } from 'events';
import { ProductExtractionService } from '../extraction/product-extraction.service';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  mode: 'creation' | 'goal';
  goalType?: 'item' | 'finance' | 'action';
  goalContext?: string;
  userId?: string;
}

export interface ChatResponse {
  content: string;
  shouldEnterGoalCreation?: boolean;
  extraction?: {
    groupId: string;
    urls: string[];
    streamUrl: string;
  };
}

export interface StreamChunk {
  content: string;
  done: boolean;
  shouldEnterGoalCreation?: boolean;
}

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  private readonly apiKey: string;
  private readonly apiUrl = 'https://api.z.ai/api/coding/paas/v4/chat/completions';

  constructor(
    private configService: ConfigService,
    @Inject(forwardRef(() => ProductExtractionService))
    private extractionService: ProductExtractionService,
  ) {
    this.apiKey = this.configService.get<string>('GLM_API_KEY') || '';
  }

  /**
   * Extract URLs from text
   */
  private extractUrls(text: string): string[] {
    const urlRegex = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/g;
    const matches = text.match(urlRegex) || [];
    // Clean up URLs (remove trailing punctuation)
    return matches.map(url => url.replace(/[.,;:!?\)\]]+$/, ''));
  }

  /**
   * Get system prompt based on chat mode and goal type
   */
  private getSystemPrompt(mode: string, goalType?: string): string {
    if (mode === 'creation') {
      return `You are Goals-AF, a friendly Miami Vice-themed AI assistant helping users create and manage their goals. Your personality is:
- Upbeat and encouraging (use emojis like 🌴, 💪, ✨)
- Professional but casual (80s neon aesthetic)
- Helpful in guiding users to create specific, actionable goals

When a user wants to create a goal:
1. Detect if the user's message indicates they want to create a goal
2. If yes, include [ENTER_GOAL_CREATION] at the end of your response
3. Ask clarifying questions to understand their goal type (item/product, financial, or action/skill)
4. Extract key details (title, description, specific metrics, deadlines, etc.)
5. Suggest breaking large goals into smaller steps
6. Be encouraging and positive!

Goal creation indicators:
- "create a goal", "new goal", "add goal", "track a goal"
- "I want to", "I need to", "help me create/set"
- "buy a", "purchase", "save for", "saving for"
- "build a", "learn to", "goal to"

Goal types:
- Item/Product: Things they want to buy (budget, product specs, timeline)
- Finance: Savings, investments, debt payoff (target amount, current amount, timeline)
- Action/Skill: Habits to build, skills to learn (specific steps, practice frequency, milestones)
- Group: Collection of related goals (for projects with multiple components like "Build a gaming setup", "Plan a vacation", "Home renovation")

Keep responses concise (2-4 sentences typically) but thorough enough to be helpful.`;
    }

    // Goal-specific prompts
    const goalPrompts = {
      item: `You are a Product Expert 🛍️ helping the user track and find the best deals on products they want to buy.

Your role:
- Help them find the best prices across retailers
- Suggest when to buy (price tracking, sales timing)
- Recommend alternatives if budget is tight
- Keep them motivated to reach their purchase goal!`,

      finance: `You are a Wealth Advisor 💰 helping the user achieve their financial goals.

Your role:
- Celebrate their progress and milestones
- Suggest strategies to save/invest more efficiently
- Provide perspective on their financial journey
- Keep them accountable but positive

Remember: This is about building wealth habits, not giving investment advice.`,

      action: `You are a Personal Coach 💪 helping the user build skills and habits.

Your role:
- Celebrate completed tasks and progress
- Help them break down big tasks into smaller steps
- Suggest ways to stay consistent and accountable
- Provide encouragement when they're stuck
- Help them adjust their approach if needed

Focus on progress, not perfection!`,

      group: `You are a Project Organizer 📦 helping the user manage collections of related goals.

Your role:
- Help them organize multiple related goals into cohesive groups
- Suggest what items/goals should be included in the group
- Track overall progress across all components
- Celebrate milestones when sections of the project are complete
- Recommend which items to prioritize within the group

Examples of group goals:
- "Custom longboard build" (deck, trucks, wheels, bearings)
- "Gaming setup" (PC, monitor, keyboard, mouse, desk, chair)
- "Home office" (equipment, furniture, savings fund, organization tasks)
- "Japan trip" (travel fund, prep tasks, photography gear)

Help them build their vision step by step!`,
    };

    return goalPrompts[goalType as keyof typeof goalPrompts] || goalPrompts.action;
  }

  /**
   * Send chat message to GLM 4.7 API
   */
  async chat(request: ChatRequest): Promise<ChatResponse> {
    // Check for URLs in the last message
    const lastMessage = request.messages[request.messages.length - 1]?.content || '';
    const urls = this.extractUrls(lastMessage);

    // If URLs found and userId provided, trigger extraction
    if (urls.length > 0 && request.userId) {
      this.logger.log(`Detected ${urls.length} URLs in message, starting extraction`);

      try {
        const groupId = await this.extractionService.extractFromUrls(urls, request.userId);

        return {
          content: `I found ${urls.length} product link${urls.length > 1 ? 's' : ''}! I'm extracting the product info now... 📦`,
          shouldEnterGoalCreation: false,
          extraction: {
            groupId,
            urls,
            streamUrl: `/api/extraction/stream/${groupId}`,
          },
        };
      } catch (error) {
        this.logger.error('Failed to start extraction:', error);
        // Fall through to normal chat
      }
    }

    const systemPrompt = this.getSystemPrompt(request.mode, request.goalType);

    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      ...request.messages,
    ];

    try {
      this.logger.debug(`Sending chat request to GLM API: ${request.messages.length} messages`);

      const response = await fetch(this.apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: 'glm-4.7',
          messages: messages.map(m => ({
            role: m.role,
            content: m.content,
          })),
          temperature: 0.7,
          max_tokens: 500,
          stream: false,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error(`GLM API error: ${response.status} - ${errorText}`);
        throw new Error(`AI service error: ${response.status}`);
      }

      const data = await response.json();

      let content = data.choices?.[0]?.message?.content || this.getFallbackResponse(request);
      let shouldEnterGoalCreation = false;

      // Check for [ENTER_GOAL_CREATION] marker
      if (content.includes('[ENTER_GOAL_CREATION]')) {
        shouldEnterGoalCreation = true;
        content = content.replace('[ENTER_GOAL_CREATION]', '').trim();
      }

      return { content, shouldEnterGoalCreation };
    } catch (error) {
      this.logger.error('Error calling GLM API:', error);
      // Return a fallback response instead of throwing
      const fallbackContent = this.getFallbackResponse(request);
      let shouldEnterGoalCreation = false;

      // Also check fallback for goal creation intent
      if (fallbackContent.includes('[ENTER_GOAL_CREATION]')) {
        shouldEnterGoalCreation = true;
      }

      return {
        content: fallbackContent.replace('[ENTER_GOAL_CREATION]', '').trim(),
        shouldEnterGoalCreation,
      };
    }
  }

  /**
   * Stream chat message to GLM 4.7 API using Server-Sent Events
   */
  async *chatStream(request: ChatRequest): AsyncGenerator<StreamChunk, void, unknown> {
    const systemPrompt = this.getSystemPrompt(request.mode, request.goalType);

    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      ...request.messages,
    ];

    // Get fallback response immediately (simpler, more reliable)
    const fallback = this.getFallbackResponse(request);

    // Check for goal creation intent marker
    const shouldEnterGoalCreation = fallback.includes('[ENTER_GOAL_CREATION]');
    const cleanFallback = fallback.replace('[ENTER_GOAL_CREATION]', '').trim();

    // Stream the fallback response character by character for typing effect
    for (const char of cleanFallback) {
      yield { content: char, done: false };
      // Small delay for typing effect
      await new Promise(resolve => setTimeout(resolve, 10));
    }

    // Include the flag in the final chunk
    yield { content: '', done: true, shouldEnterGoalCreation };
  }

  /**
   * Fallback response when API is unavailable
   */
  private getFallbackResponse(request: ChatRequest): string {
    if (request.mode === 'creation') {
      const lastMessage = request.messages[request.messages.length - 1]?.content.toLowerCase() || '';

      // Check for explicit goal creation requests FIRST (before other keywords)
      const goalCreationPhrases = [
        'create a goal', 'create goal', 'create finance goal', 'create item goal', 'create action goal',
        'make this a goal', 'make it a goal', 'add this as a goal', 'set a goal',
        'track this as a goal', 'start a goal', 'new goal', 'add goal',
        'want to create', 'want to save', 'want to buy', 'want to learn',
        'i want to buy', 'i want to purchase', 'looking for a', 'interested in'
      ];

      const isGoalCreationRequest = goalCreationPhrases.some(phrase => lastMessage.includes(phrase));

      if (isGoalCreationRequest) {
        return "Perfect! Let me help you create a goal for that. [ENTER_GOAL_CREATION]";
      }

      // Vehicle-related phrases should trigger goal creation immediately
      const vehiclePhrases = [
        'gmc', 'chevy', 'chevrolet', 'ford', 'toyota', 'honda', 'truck', 'car', 'suv', 'denali',
        'sierra', 'yukon', 'silverado', 'tahoe', 'suburban', 'camry', 'rav4', 'cr-v',
        'f-150', 'f-150 lightning', 'electric vehicle', 'ev'
      ];

      const hasVehicleIntent = vehiclePhrases.some(phrase => lastMessage.includes(phrase));

      if (hasVehicleIntent || (lastMessage.includes('buy') || lastMessage.includes('purchase'))) {
        return "That sounds like an exciting purchase! 🛍️ Let me help you create a goal for that. [ENTER_GOAL_CREATION]";
      }

      if (lastMessage.includes('save') || lastMessage.includes('money') || lastMessage.includes('invest')) {
        return "Let's get your finances right! 💰 Tell me more about your financial goal:\n\n• What are you saving for?\n• What's your target amount?\n• How much do you have saved already?\n\nI'll help you create a savings plan!";
      }

      if (lastMessage.includes('learn') || lastMessage.includes('skill') || lastMessage.includes('habit')) {
        return "Love the growth mindset! 🚀 What skill or habit are you working on? I can help you break it down into actionable steps and create a goal to track your progress.";
      }

      return "Hey there! 🌴 I'm here to help you crush your goals! What would you like to work on today? I can help you with:\n\n• **Items** - Products you want to purchase\n• **Finances** - Money goals and tracking\n• **Actions** - Skills to learn or habits to build\n\nJust tell me what you're thinking about!";
    }

    // Goal-specific fallbacks
    if (request.goalType === 'item') {
      return "I'm here to help you find the best deals! 🔍 What product are we tracking today? I can search for prices and help you save money.";
    }
    if (request.goalType === 'finance') {
      return "Your financial journey is looking great! 📈 How can I help you stay on track with your savings goals?";
    }
    if (request.goalType === 'action') {
      return "Let's keep this momentum going! 💪 What step are you working on? I can help you break it down into smaller tasks.";
    }

    return "I'm here to help! How can I assist you with your goals today? ✨";
  }

  /**
   * Parse goal creation from user message
   * This extracts structured goal data from natural language
   */
  async parseGoalFromMessage(userMessage: string, goalType: 'item' | 'finance' | 'action'): Promise<{
    title: string;
    description: string;
    [key: string]: any;
  } | null> {
    // For now, return null - the AI will guide the user through a conversation
    // In the future, this could use the AI to extract structured data
    return null;
  }
}
