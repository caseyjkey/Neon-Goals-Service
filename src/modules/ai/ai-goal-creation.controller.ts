import { Controller, Post, Body, UseGuards, Res, Param, HttpStatus } from '@nestjs/common';
import { Response } from 'express';
import { OpenAIService } from './openai.service';
import { PrismaService } from '../../config/prisma.service';
import { GoalCommandService } from './goal-command.service';
import { ChatsService } from '../chats/chats.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@Controller('ai/goal-chat')
@UseGuards(JwtAuthGuard)
export class AiGoalChatController {
  constructor(private openaiService: OpenAIService) {}

  /**
   * Continue conversation for an existing goal
   * Uses Goal.threadId for conversation persistence via database
   */
  @Post(':goalId')
  async chat(
    @Param('goalId') goalId: string,
    @CurrentUser('userId') userId: string,
    @Body() body: { message: string },
  ) {
    const result = await this.openaiService.continueGoalConversation(
      goalId,
      userId,
      body.message,
      {
        type: 'item', // Will be populated by service
        title: '',
        description: '',
      },
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
    private goalCommandService: GoalCommandService,
    private chatsService: ChatsService,
  ) {}

  /**
   * Overview agent - chat with automatic goal context
   * Uses overview_${userId} threadId for conversation persistence via database
   */
  @Post('chat')
  async chat(
    @CurrentUser('userId') userId: string,
    @Body() body: { message: string },
  ) {
    // Get or create the overview chat
    const chat = await this.chatsService.getOrCreateOverviewChat(userId);

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
   * Overview agent - streaming chat with automatic goal context
   * Uses overview_${userId} threadId for conversation persistence via database
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
      // Get or create the overview chat
      const chat = await this.chatsService.getOrCreateOverviewChat(userId);

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
        chat.id,
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
    const executedCommands = await this.goalCommandService.executeCommands(userId, body.commands);
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

  /**
   * Stop an active stream
   * Frontend calls this when user clicks stop button during streaming
   */
  @Post('chat/stop')
  async stopStream(
    @CurrentUser('userId') userId: string,
    @Res() res: Response,
  ) {
    // Abort all active streams for this user
    this.openaiService.abortUserStreams(userId);

    res.status(HttpStatus.OK).json({
      stopped: true,
      message: 'Stream stopped',
    });
  }
}
