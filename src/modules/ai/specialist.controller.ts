import { Controller, Post, Get, Body, UseGuards, Param, Res, HttpStatus } from '@nestjs/common';
import { Response } from 'express';
import { OpenAIService } from './openai.service';
import { PrismaService } from '../../config/prisma.service';
import { GoalCommandService } from './goal-command.service';
import { ChatsService } from '../chats/chats.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { ApiKeyGuard } from '../../common/guards/api-key.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

/**
 * Category Specialist Chat Controller
 *
 * Provides endpoints for chatting with category specialists:
 * - Items Specialist: Products, purchases, pricing
 * - Finances Specialist: Budgeting, saving, financial planning
 * - Actions Specialist: Skills, habits, personal development
 */
@Controller('ai/specialist')
@UseGuards(JwtAuthGuard, ApiKeyGuard)  // Allow both JWT and API key auth
export class SpecialistController {
  constructor(
    private openaiService: OpenAIService,
    private prisma: PrismaService,
    private goalCommandService: GoalCommandService,
    private chatsService: ChatsService,
  ) {}

  /**
   * Non-streaming chat with a category specialist
   * POST /ai/specialist/category/:categoryId/chat
   */
  @Post('category/:categoryId/chat')
  async chat(
    @Param('categoryId') categoryId: string,
    @CurrentUser('userId') userId: string,
    @Body() body: { message: string },
  ) {
    // Validate categoryId
    const validCategories = ['items', 'finances', 'actions'];
    if (!validCategories.includes(categoryId)) {
      return {
        error: `Invalid category. Must be one of: ${validCategories.join(', ')}`,
      };
    }

    // Get or create the category chat
    const chat = await this.chatsService.getOrCreateCategoryChat(userId, categoryId);

    // Map category to goal type
    const categoryTypeMap: Record<string, 'item' | 'finance' | 'action'> = {
      items: 'item',
      finances: 'finance',
      actions: 'action',
    };
    const goalType = categoryTypeMap[categoryId];

    // Fetch category goals
    const goals = await this.prisma.goal.findMany({
      where: {
        userId,
        type: goalType,
        status: 'active',
      },
      include: {
        itemData: true,
        financeData: true,
        actionData: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    // Send to category specialist
    const result = await this.openaiService.categoryChat(
      userId,
      categoryId,
      body.message,
      goals,
      chat.id,
    );

    // Execute commands if any were returned
    const executedCommands = result.commands && result.commands.length > 0
      ? await this.goalCommandService.executeCommands(userId, result.commands)
      : [];

    return {
      content: result.content,
      commands: result.commands,
      executedCommands,
    };
  }

  /**
   * Streaming chat with a category specialist
   * POST /ai/specialist/category/:categoryId/chat/stream
   */
  @Post('category/:categoryId/chat/stream')
  async chatStream(
    @Param('categoryId') categoryId: string,
    @CurrentUser('userId') userId: string,
    @Body() body: { message: string },
    @Res() res: Response,
  ) {
    // Validate categoryId
    const validCategories = ['items', 'finances', 'actions'];
    if (!validCategories.includes(categoryId)) {
      res.status(HttpStatus.BAD_REQUEST).json({
        error: `Invalid category. Must be one of: ${validCategories.join(', ')}`,
      });
      return;
    }

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    try {
      // Get or create the category chat
      const chat = await this.chatsService.getOrCreateCategoryChat(userId, categoryId);

      // Map category to goal type
      const categoryTypeMap: Record<string, 'item' | 'finance' | 'action'> = {
        items: 'item',
        finances: 'finance',
        actions: 'action',
      };
      const goalType = categoryTypeMap[categoryId];

      // Fetch category goals
      const goals = await this.prisma.goal.findMany({
        where: {
          userId,
          type: goalType,
          status: 'active',
        },
        include: {
          itemData: true,
          financeData: true,
          actionData: true,
        },
        orderBy: { createdAt: 'desc' },
      });

      // Stream response - pass through chunks from service
      for await (const chunk of this.openaiService.categoryChatStream(
        userId,
        categoryId,
        body.message,
        goals,
        chat.id,
      )) {
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);

        if (chunk.done) {
          res.end();
          return;
        }
      }
    } catch (error) {
      console.error('Specialist stream error:', error);
      res.write(`data: ${JSON.stringify({ content: '', done: true, error: 'Stream error' })}\n\n`);
      res.end();
    }
  }

  /**
   * Stop an active category specialist stream
   * POST /ai/specialist/category/:categoryId/chat/stop
   */
  @Post('category/:categoryId/chat/stop')
  async stopStream(
    @Param('categoryId') categoryId: string,
    @CurrentUser('userId') userId: string,
    @Res() res: Response,
  ) {
    // Abort all active streams for this user (includes category streams)
    this.openaiService.abortUserStreams(userId);

    res.status(HttpStatus.OK).json({
      stopped: true,
      message: 'Stream stopped',
    });
  }

  /**
   * Confirm and execute parsed commands from specialist chat
   * POST /ai/specialist/category/:categoryId/chat/confirm-commands
   */
  @Post('category/:categoryId/chat/confirm-commands')
  async confirmCommands(
    @Param('categoryId') categoryId: string,
    @CurrentUser('userId') userId: string,
    @Body() body: { commands: any[] },
  ) {
    const executedCommands = await this.goalCommandService.executeCommands(userId, body.commands);
    return {
      executedCommands,
      message: 'Commands executed successfully',
    };
  }

  /**
   * Cancel pending goal commands from specialist chat
   * POST /ai/specialist/category/:categoryId/chat/cancel-commands
   */
  @Post('category/:categoryId/chat/cancel-commands')
  async cancelCommands(
    @Param('categoryId') categoryId: string,
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
