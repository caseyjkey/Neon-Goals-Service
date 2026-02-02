import {
  Controller,
  Get,
  Post,
  Put,
  Param,
  Body,
  UseGuards,
  ParseIntPipe,
} from '@nestjs/common';
import { ChatsService } from './chats.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { ApiKeyGuard } from '../../common/guards/api-key.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@Controller('chats')
@UseGuards(JwtAuthGuard, ApiKeyGuard)  // Allow both JWT and API key auth
export class ChatsController {
  constructor(private chatsService: ChatsService) {}

  @Get('creation')
  async getCreationChat(@CurrentUser('userId') userId: string) {
    return this.chatsService.getOrCreateCreationChat(userId);
  }

  @Get('overview')
  async getOverviewChat(@CurrentUser('userId') userId: string) {
    return this.chatsService.getOrCreateOverviewChat(userId);
  }

  @Get('category/:categoryId')
  async getCategoryChat(
    @Param('categoryId') categoryId: string,
    @CurrentUser('userId') userId: string,
  ) {
    return this.chatsService.getOrCreateCategoryChat(userId, categoryId);
  }

  @Get('goal/:goalId')
  async getGoalChat(
    @Param('goalId') goalId: string,
    @CurrentUser('userId') userId: string,
  ) {
    return this.chatsService.getGoalChat(userId, goalId);
  }

  @Post(':id/messages')
  async addMessage(
    @Param('id') chatId: string,
    @CurrentUser('userId') userId: string,
    @Body() data: { role: string; content: string },
  ) {
    const message = await this.chatsService.addMessage(
      chatId,
      userId,
      data.role,
      data.content,
    );

    // Update chat updatedAt
    await this.chatsService.setChatLoading(chatId, false);

    return message;
  }

  @Get()
  async getAllChats(@CurrentUser('userId') userId: string) {
    return this.chatsService.getChatsStructured(userId);
  }

  @Put(':chatId/messages/:messageId')
  async editMessage(
    @Param('chatId') chatId: string,
    @Param('messageId') messageId: string,
    @CurrentUser('userId') userId: string,
    @Body() data: { content: string },
  ) {
    // Note: chatId is validated in the service method
    const updatedMessage = await this.chatsService.editMessage(messageId, userId, data.content);
    return updatedMessage;
  }
}
