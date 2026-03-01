import { Controller, Post, Body, UseGuards, Get, Param, Headers, Res, Req } from '@nestjs/common';
import { Observable, concat } from 'rxjs';
import { map } from 'rxjs/operators';
import { Request, Response } from 'express';
import { AiService, ChatRequest, StreamChunk } from './ai.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

interface ChatRequestBody {
  messages: Array<{ role: string; content: string }>;
  mode: 'creation' | 'goal';
  goalType?: 'item' | 'finance' | 'action';
  goalContext?: string;
}

@Controller('ai')
@UseGuards(JwtAuthGuard)
export class AiController {
  constructor(private aiService: AiService) {}

  /**
   * Chat endpoint for AI interactions
   */
  @Post('chat')
  async chat(@CurrentUser('userId') userId: string, @Body() body: ChatRequestBody) {
    const response = await this.aiService.chat({
      messages: body.messages as any,
      mode: body.mode,
      goalType: body.goalType,
      goalContext: body.goalContext,
      userId,
    } as ChatRequest);

    return response;
  }

  /**
   * Streaming chat endpoint for real-time AI responses
   * Uses Server-Sent Events (SSE) for streaming
   */
  @Post('chat/stream')
  async chatStream(
    @CurrentUser('userId') userId: string,
    @Body() body: ChatRequestBody,
    @Res() res: Response,
  ) {
    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    const request: ChatRequest = {
      messages: body.messages as any,
      mode: body.mode,
      goalType: body.goalType,
      goalContext: body.goalContext,
      userId,
    };

    try {
      // Stream each chunk as SSE data
      for await (const chunk of this.aiService.chatStream(request)) {
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);

        // If done, close the stream
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
   * Parse goal from natural language (future enhancement)
   */
  @Post('parse-goal')
  async parseGoal(@CurrentUser('userId') userId: string, @Body() body: {
    message: string;
    goalType: 'item' | 'finance' | 'action';
  }) {
    const parsed = await this.aiService.parseGoalFromMessage(body.message, body.goalType);
    return { parsed };
  }
}
