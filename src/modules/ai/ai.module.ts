import { Module, forwardRef } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';
import { AiGoalChatController, AiOverviewController } from './ai-goal-creation.controller';
import { SpecialistController } from './specialist.controller';
import { GoalCommandService } from './goal-command.service';
import { GoalModificationService } from './goal-modification.service';
import { OpenAIService } from './openai.service';
import { ConversationSummaryService } from './conversation-summary.service';
import { AgentRoutingService } from './agent-routing.service';
import { GreetingSummaryService } from './greeting-summary.service';
import { AiToolsService } from './ai-tools.service';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../../config/prisma.module';
import { ScraperModule } from '../scraper/scraper.module';
import { ChatsModule } from '../chats/chats.module';
import { AuthModule } from '../auth/auth.module';
import { PlaidModule } from '../plaid/plaid.module';
import { ExtractionModule } from '../extraction/extraction.module';

@Module({
  imports: [ConfigModule, PrismaModule, ScraperModule, forwardRef(() => ChatsModule), AuthModule, PlaidModule, HttpModule, ExtractionModule],
  controllers: [AiController, AiGoalChatController, AiOverviewController, SpecialistController],
  providers: [AiService, GoalCommandService, GoalModificationService, OpenAIService, ConversationSummaryService, AgentRoutingService, GreetingSummaryService, AiToolsService],
  exports: [AiService, GoalCommandService, GoalModificationService, OpenAIService, ConversationSummaryService, AgentRoutingService, GreetingSummaryService, AiToolsService],
})
export class AiModule {}
