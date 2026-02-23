import { Module, NestModule, MiddlewareConsumer } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule } from '@nestjs/throttler';
import { PrismaModule } from './config/prisma.module';
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { GoalsModule } from './modules/goals/goals.module';
import { ChatsModule } from './modules/chats/chats.module';
import { AiModule } from './modules/ai/ai.module';
import { BrowserUseModule } from './modules/browser-use/browser-use.module';
import { ScraperModule } from './modules/scraper/scraper.module';
import { PlaidModule } from './modules/plaid/plaid.module';
import { ExtractionModule } from './modules/extraction/extraction.module';
import { LoggerMiddleware } from './common/middleware/logger.middleware';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    ThrottlerModule.forRoot([{
      ttl: 60000, // Time-to-live in milliseconds (1 minute)
      limit: 10,  // Maximum number of requests within the TTL
    }]),
    ScheduleModule.forRoot(),
    PrismaModule,
    AuthModule,
    UsersModule,
    GoalsModule,
    ChatsModule,
    AiModule,
    BrowserUseModule,
    ScraperModule,
    PlaidModule,
    ExtractionModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(LoggerMiddleware)
      .forRoutes('*'); // Apply to all routes
  }
}
