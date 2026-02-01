import { Controller, Post, Body, UseGuards, Delete, Put, Param, Get, Res } from '@nestjs/common';
import { Response } from 'express';
import { AiGoalCreationService } from './ai-goal-creation.service';
import { OpenAIService } from './openai.service';
import { PrismaService } from '../../config/prisma.service';
import { ScraperService } from '../scraper/scraper.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@Controller('ai/goal-creation')
@UseGuards(JwtAuthGuard)
export class AiGoalCreationController {
  constructor(
    private aiGoalCreationService: AiGoalCreationService,
    private prisma: PrismaService,
    private scraperService: ScraperService,
  ) {}

  /**
   * Start a goal creation session with OpenAI thread
   */
  @Post('start')
  async startSession(@CurrentUser('userId') userId: string) {
    await this.aiGoalCreationService.startSession(userId);
    return { message: 'Session started with OpenAI thread' };
  }

  /**
   * Send a message in the goal creation flow
   */
  @Post('chat')
  async chat(
    @CurrentUser('userId') userId: string,
    @Body() body: { message: string },
  ) {
    const result = await this.aiGoalCreationService.processMessage(
      userId,
      body.message,
    );
    return result;
  }

  /**
   * Cancel goal creation and delete the thread
   */
  @Delete('cancel')
  async cancelSession(@CurrentUser('userId') userId: string) {
    await this.aiGoalCreationService.cancelSession(userId);
    return { message: 'Session cancelled and thread deleted' };
  }

  /**
   * Clear/reset the goal creation session (keeps thread)
   */
  @Delete('session')
  async clearSession(@CurrentUser('userId') userId: string) {
    this.aiGoalCreationService.clearSession(userId);
    return { message: 'Session cleared' };
  }

  /**
   * Confirm and create the goal (user clicked "Looks good!")
   * Also supports direct command execution from overview chat
   */
  @Put('confirm')
  async confirmGoal(
    @CurrentUser('userId') userId: string,
    @Body() body?: { commands?: any[] },
  ) {
    // If commands are provided, execute them directly (overview chat flow)
    if (body?.commands && body.commands.length > 0) {
      const executedCommands = await this.executeCommands(userId, body.commands);
      return {
        executedCommands,
        message: 'Commands executed successfully',
      };
    }

    // Otherwise use the original goal creation flow
    return this.aiGoalCreationService.confirmGoal(userId);
  }

  /**
   * Execute parsed commands to create/update goals
   * Returns executed commands with their results
   */
  private async executeCommands(userId: string, commands: any[]) {
    const executedCommands: any[] = [];

    for (const command of commands) {
      try {
        if (command.type === 'CREATE_GOAL') {
          const goal = await this.createGoal(userId, command.data);
          executedCommands.push({
            type: 'CREATE_GOAL',
            success: true,
            goalId: goal.id,
            goal,
          });
        } else if (command.type === 'CREATE_SUBGOAL') {
          const subgoal = await this.createSubgoal(userId, command.data);
          executedCommands.push({
            type: 'CREATE_SUBGOAL',
            success: true,
            subgoalId: subgoal.id,
            subgoal,
          });
        } else if (command.type === 'UPDATE_PROGRESS') {
          await this.updateProgress(userId, command.data);
          executedCommands.push({
            type: 'UPDATE_PROGRESS',
            success: true,
            goalId: command.data.goalId,
          });
        }
      } catch (error) {
        console.error(`Failed to execute command ${command.type}:`, error);
        executedCommands.push({
          type: command.type,
          success: false,
          error: error.message,
        });
      }
    }

    return executedCommands;
  }

  /**
   * Create a new main goal from command data
   */
  private async createGoal(userId: string, data: any) {
    const { type, title, description, tasks, deadline } = data;

    // Convert deadline string to Date object if provided
    const deadlineDate = deadline ? new Date(deadline) : null;

    if (type === 'action') {
      return this.prisma.goal.create({
        data: {
          type: 'action',
          title,
          description: description || `Working on: ${title}`,
          status: 'active',
          deadline: deadlineDate,
          userId,
          actionData: {
            create: {
              completionPercentage: 0,
              motivation: null,
              tasks: tasks ? {
                create: tasks.map((t: any) => ({
                  title: t.title || t,
                  completed: false,
                })),
              } : undefined,
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

    // For item/finance goals, create with minimal defaults
    if (type === 'item') {
      const goal = await this.prisma.goal.create({
        data: {
          type: 'item',
          title,
          description: description || `Saving for: ${title}`,
          status: 'active',
          deadline: deadlineDate,
          userId,
          itemData: {
            create: {
              productImage: null,
              bestPrice: data.budget || 0,
              currency: 'USD',
              retailerUrl: '',
              retailerName: 'TBD',
              statusBadge: 'pending_search',
              searchTerm: data.searchTerm || null,
              category: data.category || null,
            },
          },
        },
        include: {
          itemData: true,
        },
      });

      // Queue scraping job - scraper service will determine if scrapers exist for this category
      await this.scraperService.queueCandidateAcquisition(goal.id);

      return goal;
    }

    if (type === 'finance') {
      return this.prisma.goal.create({
        data: {
          type: 'finance',
          title,
          description: description || `Financial goal: ${title}`,
          status: 'active',
          deadline: deadlineDate,
          userId,
          financeData: {
            create: {
              institutionIcon: '🏦',
              accountName: 'Savings',
              currentBalance: 0,
              targetBalance: data.targetBalance || 1000,
              currency: 'USD',
              progressHistory: [0],
            },
          },
        },
        include: {
          financeData: true,
        },
      });
    }

    throw new Error(`Unknown goal type: ${type}`);
  }

  /**
   * Create a subgoal under a parent goal
   * parentGoalId can be either an actual ID or a title (will be looked up)
   */
  private async createSubgoal(userId: string, data: any) {
    const { parentGoalId, type, title, description, deadline } = data;

    // Convert deadline string to Date object if provided
    const deadlineDate = deadline ? new Date(deadline) : null;

    // Find parent goal - try by ID first, then by title (for recently created goals)
    let parentGoal = await this.prisma.goal.findFirst({
      where: {
        id: parentGoalId,
        userId,
      },
    });

    // If not found by ID, try by title (in case agent used title instead of ID)
    if (!parentGoal) {
      parentGoal = await this.prisma.goal.findFirst({
        where: {
          title: parentGoalId,
          userId,
          status: 'active',
          // Remove parentGoalId: null filter to allow subgoals as parents
        },
        orderBy: { createdAt: 'desc' },
      });
    }

    if (!parentGoal) {
      // Get available goals for better error message
      const availableGoals = await this.prisma.goal.findMany({
        where: {
          userId,
          status: 'active',
          // Show all active goals, not just top-level
        },
        select: {
          id: true,
          title: true,
        },
      });

      const goalList = availableGoals.map(g => `- ${g.title} (ID: ${g.id})`).join('\n');

      throw new Error(
        `Parent goal not found: "${parentGoalId}"\n\n` +
        `Available goals:\n${goalList}\n\n` +
        `Tip: Use the goal's title or exact ID as parentGoalId`
      );
    }

    // Create subgoal similar to createGoal but with parentGoalId
    if (type === 'action') {
      return this.prisma.goal.create({
        data: {
          type: 'action',
          title,
          description: description || `Step toward: ${parentGoal.title}`,
          status: 'active',
          deadline: deadlineDate,
          userId,
          parentGoalId: parentGoal.id,
          actionData: {
            create: {
              completionPercentage: 0,
            },
          },
        },
        include: {
          actionData: true,
        },
      });
    }

    // Handle item subgoals (e.g., vehicle as part of a larger goal)
    if (type === 'item') {
      const subgoal = await this.prisma.goal.create({
        data: {
          type: 'item',
          title,
          description: description || `Item toward: ${parentGoal.title}`,
          status: 'active',
          deadline: deadlineDate,
          userId,
          parentGoalId: parentGoal.id,
          itemData: {
            create: {
              productImage: null,
              bestPrice: 0,
              currency: 'USD',
              retailerUrl: '',
              retailerName: 'TBD',
              statusBadge: 'pending_search',
              searchTerm: data.searchTerm || null,
              category: data.category || null,
            },
          },
        },
        include: {
          itemData: true,
        },
      });

      // Queue scraping job - scraper service will determine if scrapers exist for this category
      await this.scraperService.queueCandidateAcquisition(subgoal.id);

      return subgoal;
    }

    // Handle finance subgoals
    if (type === 'finance') {
      return this.prisma.goal.create({
        data: {
          type: 'finance',
          title,
          description: description || `Savings toward: ${parentGoal.title}`,
          status: 'active',
          deadline: deadlineDate,
          userId,
          parentGoalId: parentGoal.id,
          financeData: {
            create: {
              institutionIcon: '🏦',
              accountName: 'Savings',
              currentBalance: 0,
              targetBalance: data.targetBalance || 1000,
              currency: 'USD',
              progressHistory: [0],
            },
          },
        },
        include: {
          financeData: true,
        },
      });
    }

    throw new Error(`Subgoal type ${type} not yet implemented`);
  }

  /**
   * Update goal progress
   */
  private async updateProgress(userId: string, data: any) {
    const { goalId, completionPercentage } = data;

    const goal = await this.prisma.goal.findFirst({
      where: {
        id: goalId,
        userId,
      },
    });

    if (!goal) {
      throw new Error(`Goal not found: ${goalId}`);
    }

    if (goal.type === 'action') {
      await this.prisma.actionGoalData.update({
        where: { goalId },
        data: { completionPercentage },
      });
    }

    // For other types, implement as needed
  }
}

@Controller('ai/goal-chat')
@UseGuards(JwtAuthGuard)
export class AiGoalChatController {
  constructor(private aiGoalCreationService: AiGoalCreationService) {}

  /**
   * Continue conversation for an existing goal
   */
  @Post(':goalId')
  async chat(
    @Param('goalId') goalId: string,
    @CurrentUser('userId') userId: string,
    @Body() body: { message: string },
  ) {
    const result = await this.aiGoalCreationService.continueGoalConversation(
      goalId,
      userId,
      body.message,
    );

    // Return both content and commands
    // Frontend will execute CREATE_SUBGOAL commands
    return {
      content: result.content,
      commands: result.commands,
    };
  }
}

@Controller('ai/overview')
@UseGuards(JwtAuthGuard)
export class AiOverviewController {
  constructor(
    private openaiService: OpenAIService,
    private prisma: PrismaService,
    private scraperService: ScraperService,
  ) {}

  /**
   * Execute parsed commands to create/update goals
   * Returns executed commands with their results
   */
  private async executeCommands(userId: string, commands: any[]) {
    const executedCommands: any[] = [];

    for (const command of commands) {
      try {
        if (command.type === 'CREATE_GOAL') {
          const goal = await this.createGoal(userId, command.data);
          executedCommands.push({
            type: 'CREATE_GOAL',
            success: true,
            goalId: goal.id,
            goal,
          });
        } else if (command.type === 'CREATE_SUBGOAL') {
          const subgoal = await this.createSubgoal(userId, command.data);
          executedCommands.push({
            type: 'CREATE_SUBGOAL',
            success: true,
            subgoalId: subgoal.id,
            subgoal,
          });
        } else if (command.type === 'UPDATE_PROGRESS') {
          await this.updateProgress(userId, command.data);
          executedCommands.push({
            type: 'UPDATE_PROGRESS',
            success: true,
            goalId: command.data.goalId,
          });
        }
      } catch (error) {
        console.error(`Failed to execute command ${command.type}:`, error);
        executedCommands.push({
          type: command.type,
          success: false,
          error: error.message,
        });
      }
    }

    return executedCommands;
  }

  /**
   * Create a new main goal from command data
   */
  private async createGoal(userId: string, data: any) {
    const { type, title, description, tasks, deadline } = data;

    // Convert deadline string to Date object if provided
    const deadlineDate = deadline ? new Date(deadline) : null;

    if (type === 'action') {
      return this.prisma.goal.create({
        data: {
          type: 'action',
          title,
          description: description || `Working on: ${title}`,
          status: 'active',
          deadline: deadlineDate,
          userId,
          actionData: {
            create: {
              completionPercentage: 0,
              motivation: null,
              tasks: tasks ? {
                create: tasks.map((t: any) => ({
                  title: t.title || t,
                  completed: false,
                })),
              } : undefined,
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

    // For item/finance goals, create with minimal defaults
    if (type === 'item') {
      const goal = await this.prisma.goal.create({
        data: {
          type: 'item',
          title,
          description: description || `Saving for: ${title}`,
          status: 'active',
          deadline: deadlineDate,
          userId,
          itemData: {
            create: {
              productImage: null,
              bestPrice: data.budget || 0,
              currency: 'USD',
              retailerUrl: '',
              retailerName: 'TBD',
              statusBadge: 'pending_search',
              searchTerm: data.searchTerm || null,
              category: data.category || null,
            },
          },
        },
        include: {
          itemData: true,
        },
      });

      // Queue scraping job - scraper service will determine if scrapers exist for this category
      await this.scraperService.queueCandidateAcquisition(goal.id);

      return goal;
    }

    if (type === 'finance') {
      return this.prisma.goal.create({
        data: {
          type: 'finance',
          title,
          description: description || `Financial goal: ${title}`,
          status: 'active',
          deadline: deadlineDate,
          userId,
          financeData: {
            create: {
              institutionIcon: '🏦',
              accountName: 'Savings',
              currentBalance: 0,
              targetBalance: data.targetBalance || 1000,
              currency: 'USD',
              progressHistory: [0],
            },
          },
        },
        include: {
          financeData: true,
        },
      });
    }

    throw new Error(`Unknown goal type: ${type}`);
  }

  /**
   * Create a subgoal under a parent goal
   * parentGoalId can be either an actual ID or a title (will be looked up)
   */
  private async createSubgoal(userId: string, data: any) {
    const { parentGoalId, type, title, description, deadline } = data;

    // Convert deadline string to Date object if provided
    const deadlineDate = deadline ? new Date(deadline) : null;

    // Find parent goal - try by ID first, then by title (for recently created goals)
    let parentGoal = await this.prisma.goal.findFirst({
      where: {
        id: parentGoalId,
        userId,
      },
    });

    // If not found by ID, try by title (in case agent used title instead of ID)
    if (!parentGoal) {
      parentGoal = await this.prisma.goal.findFirst({
        where: {
          title: parentGoalId,
          userId,
          status: 'active',
          // Remove parentGoalId: null filter to allow subgoals as parents
        },
        orderBy: { createdAt: 'desc' },
      });
    }

    if (!parentGoal) {
      // Get available goals for better error message
      const availableGoals = await this.prisma.goal.findMany({
        where: {
          userId,
          status: 'active',
          // Show all active goals, not just top-level
        },
        select: {
          id: true,
          title: true,
        },
      });

      const goalList = availableGoals.map(g => `- ${g.title} (ID: ${g.id})`).join('\n');

      throw new Error(
        `Parent goal not found: "${parentGoalId}"\n\n` +
        `Available goals:\n${goalList}\n\n` +
        `Tip: Use the goal's title or exact ID as parentGoalId`
      );
    }

    // Create subgoal similar to createGoal but with parentGoalId
    if (type === 'action') {
      return this.prisma.goal.create({
        data: {
          type: 'action',
          title,
          description: description || `Step toward: ${parentGoal.title}`,
          status: 'active',
          deadline: deadlineDate,
          userId,
          parentGoalId: parentGoal.id,
          actionData: {
            create: {
              completionPercentage: 0,
            },
          },
        },
        include: {
          actionData: true,
        },
      });
    }

    // Handle item subgoals (e.g., vehicle as part of a larger goal)
    if (type === 'item') {
      const subgoal = await this.prisma.goal.create({
        data: {
          type: 'item',
          title,
          description: description || `Item toward: ${parentGoal.title}`,
          status: 'active',
          deadline: deadlineDate,
          userId,
          parentGoalId: parentGoal.id,
          itemData: {
            create: {
              productImage: null,
              bestPrice: 0,
              currency: 'USD',
              retailerUrl: '',
              retailerName: 'TBD',
              statusBadge: 'pending_search',
              searchTerm: data.searchTerm || null,
              category: data.category || null,
            },
          },
        },
        include: {
          itemData: true,
        },
      });

      // Queue scraping job - scraper service will determine if scrapers exist for this category
      await this.scraperService.queueCandidateAcquisition(subgoal.id);

      return subgoal;
    }

    // Handle finance subgoals
    if (type === 'finance') {
      return this.prisma.goal.create({
        data: {
          type: 'finance',
          title,
          description: description || `Savings toward: ${parentGoal.title}`,
          status: 'active',
          deadline: deadlineDate,
          userId,
          parentGoalId: parentGoal.id,
          financeData: {
            create: {
              institutionIcon: '🏦',
              accountName: 'Savings',
              currentBalance: 0,
              targetBalance: data.targetBalance || 1000,
              currency: 'USD',
              progressHistory: [0],
            },
          },
        },
        include: {
          financeData: true,
        },
      });
    }

    throw new Error(`Subgoal type ${type} not yet implemented`);
  }

  /**
   * Update goal progress
   */
  private async updateProgress(userId: string, data: any) {
    const { goalId, completionPercentage } = data;

    const goal = await this.prisma.goal.findFirst({
      where: {
        id: goalId,
        userId,
      },
    });

    if (!goal) {
      throw new Error(`Goal not found: ${goalId}`);
    }

    if (goal.type === 'action') {
      await this.prisma.actionGoalData.update({
        where: { goalId },
        data: { completionPercentage },
      });
    }

    // For other types, implement as needed
  }

  /**
   * Overview agent - chat with automatic goal context
   */
  @Post('chat')
  async chat(
    @CurrentUser('userId') userId: string,
    @Body() body: { message: string },
  ) {
    // Fetch user's active goals with subgoals
    const goals = await this.prisma.goal.findMany({
      where: {
        userId,
        status: 'active',
        parentGoalId: null, // Only top-level goals
      },
      include: {
        subgoals: {
          where: { status: 'active' },
        },
        itemData: true,
        financeData: true,
        actionData: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    // Send to overview agent
    const result = await this.openaiService.overviewChat(
      userId,
      body.message,
      goals,
    );

    // Execute commands if any were returned
    const executedCommands = result.commands && result.commands.length > 0
      ? await this.executeCommands(userId, result.commands)
      : [];

    return {
      content: result.content,
      commands: result.commands,
      executedCommands,
    };
  }

  /**
   * Overview agent - streaming chat with automatic goal context
   */
  @Post('chat/stream')
  async chatStream(
    @CurrentUser('userId') userId: string,
    @Body() body: { message: string },
    @Res() res: Response,
  ) {
    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    try {
      // Fetch user's active goals
      const goals = await this.prisma.goal.findMany({
        where: {
          userId,
          status: 'active',
          parentGoalId: null,
        },
        include: {
          subgoals: { where: { status: 'active' } },
          itemData: true,
          financeData: true,
          actionData: true,
        },
        orderBy: { createdAt: 'desc' },
      });

      // Stream response - pass through chunks from service
      for await (const chunk of this.openaiService.overviewChatStream(
        userId,
        body.message,
        goals,
      )) {
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);

        if (chunk.done) {
          res.end();
          return;
        }
      }
    } catch (error) {
      console.error('Stream error:', error);
      res.write(`data: ${JSON.stringify({ content: '', done: true, error: 'Stream error' })}\n\n`);
      res.end();
    }
  }

  /**
   * Confirm and execute parsed commands
   * Frontend calls this after user confirms the goal preview
   */
  @Post('chat/confirm-commands')
  async confirmCommands(
    @CurrentUser('userId') userId: string,
    @Body() body: { commands: any[] },
  ) {
    const executedCommands = await this.executeCommands(userId, body.commands);
    return {
      executedCommands,
      message: 'Commands executed successfully',
    };
  }

  /**
   * Cancel pending goal commands
   * Frontend calls this when user clicks "Cancel" on the goal preview
   */
  @Post('chat/cancel-commands')
  async cancelCommands(
    @CurrentUser('userId') userId: string,
    @Body() body?: { reason?: string },
  ) {
    const reason = body?.reason || 'User cancelled';
    return {
      cancelled: true,
      message: `Goal creation cancelled: ${reason}`,
    };
  }
}
