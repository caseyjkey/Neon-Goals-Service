import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../config/prisma.service';
import { OpenAI } from 'openai';
import { ChatCompletionMessageParam } from 'openai/resources';

/**
 * Service for managing conversation summaries to handle context window limits
 *
 * When a chat grows too large, older messages are summarized and stored
 * in ConversationSummary table. The summaryCursor tracks how many messages
 * have been summarized, allowing us to build efficient LLM context.
 */
@Injectable()
export class ConversationSummaryService {
  private readonly logger = new Logger(ConversationSummaryService.name);

  // Default token threshold for summarization (100K context window)
  private readonly SUMMARY_THRESHOLD = 100000;
  private readonly SUMMARY_TRIGGER_RATIO = 0.8; // Trigger at 80% of threshold
  private readonly ESTIMATED_TOKENS_PER_MESSAGE = 100; // Rough estimate

  constructor(
    private prisma: PrismaService,
    private openai: OpenAI,
  ) {}

  /**
   * Check if a chat should be summarized based on message count
   * Triggered when estimated tokens reach 80% of threshold
   */
  async shouldSummarize(chatId: string): Promise<boolean> {
    const chat = await this.prisma.chatState.findUnique({
      where: { id: chatId },
      include: { messages: true },
    });

    if (!chat) {
      return false;
    }

    // Calculate active (unsummarized) message count
    const summaryCursor = chat.summaryCursor || 0;
    const activeMessageCount = chat.messages.length - summaryCursor;

    // Estimate token count
    const estimatedTokens = activeMessageCount * this.ESTIMATED_TOKENS_PER_MESSAGE;

    return estimatedTokens >= this.SUMMARY_THRESHOLD * this.SUMMARY_TRIGGER_RATIO;
  }

  /**
   * Summarize messages since the last summary and store the result
   * Updates ChatState.summaryCursor and lastSummaryId
   */
  async summarizeChat(chatId: string): Promise<void> {
    this.logger.log(`Starting summarization for chat ${chatId}`);

    const chat = await this.prisma.chatState.findUnique({
      where: { id: chatId },
      include: {
        messages: {
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    if (!chat || chat.messages.length === 0) {
      this.logger.warn(`Chat ${chatId} not found or has no messages`);
      return;
    }

    // Get messages since last summary (or all if no summary exists)
    const summaryCursor = chat.summaryCursor || 0;
    const messagesToSummarize = chat.messages.slice(summaryCursor);

    if (messagesToSummarize.length === 0) {
      this.logger.log(`No new messages to summarize for chat ${chatId}`);
      return;
    }

    // Build conversation text for summarization
    const conversationText = messagesToSummarize
      .map(msg => `${msg.role}: ${msg.content}`)
      .join('\n\n');

    // Generate summary using OpenAI
    const summary = await this.generateSummary(conversationText);

    // Store summary in database
    const savedSummary = await this.prisma.conversationSummary.create({
      data: {
        chatId,
        summary,
        messageCount: messagesToSummarize.length,
      },
    });

    // Update chat state with new summary cursor
    await this.prisma.chatState.update({
      where: { id: chatId },
      data: {
        lastSummaryId: savedSummary.id,
        summaryCursor: chat.messages.length,
      },
    });

    this.logger.log(
      `Summarized ${messagesToSummarize.length} messages for chat ${chatId} (summary ID: ${savedSummary.id})`,
    );
  }

  /**
   * Generate a summary of the conversation using OpenAI
   */
  private async generateSummary(conversationText: string): Promise<string> {
    const response = await this.openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'You are a conversation summarizer. Create a concise summary of the following conversation that captures the key points, decisions, and context. Keep it under 500 words.',
        },
        {
          role: 'user',
          content: `Please summarize this conversation:\n\n${conversationText}`,
        },
      ],
      temperature: 0.3, // Lower temperature for more focused summaries
      max_tokens: 1000,
    });

    return response.choices[0]?.message?.content || 'Summary generation failed';
  }

  /**
   * Build LLM context from summaries and recent messages
   * Returns an array of messages ready for OpenAI API
   */
  async buildContext(chatId: string): Promise<ChatCompletionMessageParam[]> {
    const chat = await this.prisma.chatState.findUnique({
      where: { id: chatId },
      include: {
        summaries: {
          orderBy: { createdAt: 'asc' },
        },
        messages: {
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    if (!chat) {
      return [];
    }

    const context: ChatCompletionMessageParam[] = [];

    // Add all summaries as system messages
    for (const summary of chat.summaries) {
      context.push({
        role: 'system',
        content: `[Previous conversation summary]\n${summary.summary}`,
      });
    }

    // Add messages after the last summary
    const summaryCursor = chat.summaryCursor || 0;
    const recentMessages = chat.messages.slice(summaryCursor);

    for (const message of recentMessages) {
      context.push({
        role: message.role as 'user' | 'assistant' | 'system',
        content: message.content,
      });
    }

    this.logger.log(
      `Built context for chat ${chatId}: ${chat.summaries.length} summaries, ${recentMessages.length} recent messages`,
    );

    return context;
  }

  /**
   * Get all summaries for a chat (for debugging/display)
   */
  async getSummaries(chatId: string) {
    return this.prisma.conversationSummary.findMany({
      where: { chatId },
      orderBy: { createdAt: 'desc' },
    });
  }
}
