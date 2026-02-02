import { Module } from '@nestjs/common';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';
import { AiGoalChatController, AiOverviewController } from './ai-goal-creation.controller';
import { GoalCommandService } from './goal-command.service';
import { OpenAIService } from './openai.service';
import { ConversationSummaryService } from './conversation-summary.service';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../../config/prisma.module';
import { ScraperModule } from '../scraper/scraper.module';
import { ChatsModule } from '../chats/chats.module';

@Module({
  imports: [ConfigModule, PrismaModule, ScraperModule, ChatsModule],
  controllers: [AiController, AiGoalChatController, AiOverviewController],
  providers: [AiService, GoalCommandService, OpenAIService, ConversationSummaryService],
  exports: [AiService, GoalCommandService, OpenAIService, ConversationSummaryService],
})
export class AiModule {}
