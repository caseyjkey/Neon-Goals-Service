import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../config/prisma.service';
import { OpenAIService } from './openai.service';
import { ScraperService } from '../scraper/scraper.service';

interface GoalCreationSession {
  userId: string;
  threadId: string;
  goalData: any;
  awaitingConfirmation: boolean;
}

@Injectable()
export class AiGoalCreationService {
  private readonly logger = new Logger(AiGoalCreationService.name);
  private activeSessions = new Map<string, GoalCreationSession>();

  constructor(
    private configService: ConfigService,
    private prisma: PrismaService,
    private openaiService: OpenAIService,
    private scraperService: ScraperService,
  ) {}

  /**
   * Start a new goal creation session with OpenAI thread
   */
  async startSession(userId: string) {
    const { threadId } = await this.openaiService.createThread();

    const session: GoalCreationSession = {
      userId,
      threadId,
      goalData: {},
      awaitingConfirmation: false,
    };

    this.activeSessions.set(userId, session);
    this.logger.log(`Started goal creation session for user ${userId} with thread ${threadId}`);
  }

  /**
   * Process message in goal creation flow
   */
  async processMessage(userId: string, message: string) {
    const session = this.activeSessions.get(userId);

    if (!session) {
      throw new Error('No active goal creation session. Call startSession first.');
    }

    try {
      const response = await this.openaiService.sendMessage(
        session.threadId,
        userId,
        message,
        session.goalData,
      );

      // Update session with extracted goal data
      if (response.goalData) {
        session.goalData = { ...session.goalData, ...response.goalData };
      }

      // Check if awaiting confirmation
      if (response.awaitingConfirmation) {
        session.awaitingConfirmation = true;
      }

      return {
        content: response.content,
        goalCreated: false,
        goalPreview: response.goalPreview,
        awaitingConfirmation: response.awaitingConfirmation,
      };
    } catch (error) {
      this.logger.error('Error processing message:', error);
      throw error;
    }
  }

  /**
   * Confirm and create the goal
   */
  async confirmGoal(userId: string) {
    const session = this.activeSessions.get(userId);

    this.logger.log(`confirmGoal called for userId: ${userId}`);
    this.logger.log(`Active sessions: ${this.activeSessions.size}`);
    this.logger.log(`Session found: ${!!session}, awaitingConfirmation: ${session?.awaitingConfirmation}`);

    if (!session || !session.awaitingConfirmation) {
      throw new Error('No goal ready for confirmation');
    }

    const goal = await this.createGoal(userId, session.goalData, session.threadId);

    // Clear the session but don't delete the thread (it's attached to the goal)
    this.activeSessions.delete(userId);

    return {
      content: `🎉 Your goal "${goal.title}" has been created! Feel free to continue chatting about this goal anytime.`,
      goalCreated: true,
      goal,
    };
  }

  /**
   * Cancel goal creation and delete the thread
   */
  async cancelSession(userId: string) {
    const session = this.activeSessions.get(userId);

    if (session) {
      // Delete the OpenAI thread since no goal was created
      await this.openaiService.deleteThread(session.threadId);
      this.activeSessions.delete(userId);
      this.logger.log(`Cancelled goal creation session for user ${userId}, deleted thread ${session.threadId}`);
    }
  }

  /**
   * Clear session without deleting thread (for when user manually exits)
   */
  clearSession(userId: string) {
    const session = this.activeSessions.get(userId);

    if (session) {
      this.activeSessions.delete(userId);
      // Don't delete thread - it might be attached to a goal
    }
  }

  /**
   * Create the goal from collected data
   */
  private async createGoal(userId: string, goalData: any, threadId: string) {
    const { goalType, title, description } = goalData;
    this.logger.log(`Creating ${goalType} goal for user ${userId}`);

    try {
      let goal;

      if (goalType === 'item') {
        // Prepare item data with optional vehicle fields
        const itemData: any = {
          productImage: null,
          bestPrice: goalData.budget || 0,
          currency: 'USD',
          retailerUrl: 'https://amazon.com',
          retailerName: 'Amazon',
          statusBadge: 'pending_search',
          category: goalData.category,
          searchTerm: goalData.searchTerm,
        };

        // Add searchFilters if provided (JSONB field for flexible search preferences)
        if (goalData.searchFilters) {
          itemData.searchFilters = goalData.searchFilters;
        }

        goal = await this.prisma.goal.create({
          data: {
            type: 'item',
            title: title || 'New Item Goal',
            description: description || `Saving for ${title}`,
            status: 'active',
            threadId, // Attach the OpenAI thread to the goal
            userId,
            itemData: {
              create: itemData,
            },
          },
          include: {
            itemData: true,
          },
        });

        // Queue scraping job - scraper service will determine if scrapers exist for this category
        await this.scraperService.queueCandidateAcquisition(goal.id);
      } else if (goalType === 'finance') {
        const targetBalance = goalData.targetBalance || 1000;
        const currentBalance = goalData.currentBalance || 0;

        goal = await this.prisma.goal.create({
          data: {
            type: 'finance',
            title: title || 'New Finance Goal',
            description: description || `Saving ${targetBalance}`,
            status: 'active',
            threadId, // Attach the OpenAI thread to the goal
            userId,
            financeData: {
              create: {
                targetBalance,
                currentBalance,
                currency: 'USD',
                accountName: 'Savings',
                institutionIcon: '🏦',
                progressHistory: [currentBalance],
                lastSync: new Date(),
              },
            },
          },
          include: {
            financeData: true,
          },
        });
      } else if (goalType === 'action') {
        const tasks = goalData.tasks || [];

        goal = await this.prisma.goal.create({
          data: {
            type: 'action',
            title: title || 'New Action Goal',
            description: description || 'Building a new habit',
            status: 'active',
            threadId, // Attach the OpenAI thread to the goal
            userId,
            actionData: {
              create: {
                completionPercentage: 0,
                motivation: goalData.motivation || null,
                tasks: {
                  create: tasks,
                },
              },
            },
          },
          include: {
            actionData: {
              include: {
                tasks: true,
              },
            },
          },
        });
      }

      this.logger.log(`Created goal ${goal.id} with thread ${threadId}`);
      return goal;
    } catch (error) {
      this.logger.error('Error creating goal:', error);
      throw error;
    }
  }

  /**
   * Continue conversation for an existing goal
   */
  async continueGoalConversation(goalId: string, userId: string, message: string) {
    // Get the goal with its thread
    const goal = await this.prisma.goal.findFirst({
      where: {
        id: goalId,
        userId,
      },
    });

    if (!goal) {
      throw new Error('Goal not found');
    }

    if (!goal.threadId) {
      throw new Error('This goal does not have a conversation thread. Create a new goal to start a conversation.');
    }

    const goalContext = {
      type: goal.type,
      title: goal.title,
      description: goal.description,
    };

    const response = await this.openaiService.continueGoalConversation(
      goal.threadId,
      userId,
      message,
      goalContext,
    );

    return {
      content: response.content,
      commands: response.commands,
    };
  }
}
