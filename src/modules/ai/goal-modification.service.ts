import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../../config/prisma.service';
import { canModifyGoal, categoryIdToGoalType } from './goal-modification.tools';

/**
 * Service for handling goal modification commands from AI agents
 *
 * This service processes structured commands from OpenAI tool calls
 * and applies them to user goals with proper permission checks.
 */
@Injectable()
export class GoalModificationService {
  constructor(private prisma: PrismaService) {}

  /**
   * Update goal title
   */
  async updateGoalTitle(goalId: string, userId: string, title: string): Promise<string> {
    await this.verifyOwnership(goalId, userId);

    const updated = await this.prisma.goal.update({
      where: { id: goalId },
      data: { title },
    });

    return `✓ Updated "${updated.title}" title to "${title}"`;
  }

  /**
   * Update goal description
   */
  async updateGoalDescription(goalId: string, userId: string, description: string): Promise<string> {
    await this.verifyOwnership(goalId, userId);

    await this.prisma.goal.update({
      where: { id: goalId },
      data: { description },
    });

    return `✓ Updated goal description`;
  }

  /**
   * Update goal deadline
   */
  async updateGoalTargetDate(goalId: string, userId: string, targetDate: string): Promise<string> {
    await this.verifyOwnership(goalId, userId);

    const date = new Date(targetDate);
    await this.prisma.goal.update({
      where: { id: goalId },
      data: { deadline: date },
    });

    return `✓ Updated deadline to ${date.toLocaleDateString()}`;
  }

  /**
   * Update item goal search criteria (stored in searchTerm or searchResults)
   */
  async updateItemFilters(goalId: string, userId: string, filters: any): Promise<string> {
    const goal = await this.verifyOwnership(goalId, userId, 'item');

    // Update searchResults JSON field with new filters
    await this.prisma.itemGoalData.update({
      where: { goalId },
      data: {
        searchResults: filters,
      },
    });

    return `✓ Updated search filters for "${goal.title}"`;
  }

  /**
   * Update finance goal targets
   */
  async updateFinanceTargets(
    goalId: string,
    userId: string,
    targetBalance?: number,
    monthlyContribution?: number,
  ): Promise<string> {
    await this.verifyOwnership(goalId, userId, 'finance');

    // For now, we'll update the searchResults with the new targets
    // In a real implementation, you'd want dedicated fields for these
    const updateData: any = {};
    if (targetBalance !== undefined) {
      updateData.searchResults = { targetBalance };
    }
    if (monthlyContribution !== undefined) {
      updateData.searchResults = { ...(updateData.searchResults || {}), monthlyContribution };
    }

    await this.prisma.financeGoalData.update({
      where: { goalId },
      data: updateData,
    });

    const changes = [];
    if (targetBalance !== undefined) changes.push(`target balance to $${targetBalance}`);
    if (monthlyContribution !== undefined) changes.push(`monthly contribution to $${monthlyContribution}`);

    return `✓ Updated ${changes.join(' and ')} for "${(await this.prisma.goal.findUnique({ where: { id: goalId } }))?.title}"`;
  }

  /**
   * Add a task to an action goal
   */
  async addActionTask(goalId: string, userId: string, task: any): Promise<string> {
    const goal = await this.verifyOwnership(goalId, userId, 'action');

    // Create task in the separate Task table
    const newTask = await this.prisma.task.create({
      data: {
        title: task.title,
        actionGoalId: (await this.prisma.actionGoalData.findUnique({ where: { goalId } }))!.id,
      },
    });

    return `✓ Added task "${task.title}" to "${goal.title}"`;
  }

  /**
   * Complete a task in an action goal
   */
  async completeActionTask(taskId: string, userId: string): Promise<string> {
    // Find the task and verify ownership through the action goal
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      include: {
        actionGoal: {
          include: {
            goal: true,
          },
        },
      },
    });

    if (!task) {
      throw new NotFoundException('Task not found');
    }

    if (task.actionGoal.goal.userId !== userId) {
      throw new ForbiddenException('You can only modify your own goals');
    }

    await this.prisma.task.update({
      where: { id: taskId },
      data: { completed: true },
    });

    return `✓ Marked task "${task.title}" as completed in "${task.actionGoal.goal.title}"`;
  }

  /**
   * Remove a task from an action goal
   */
  async removeActionTask(taskId: string, userId: string): Promise<string> {
    // Find the task and verify ownership
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      include: {
        actionGoal: {
          include: {
            goal: true,
          },
        },
      },
    });

    if (!task) {
      throw new NotFoundException('Task not found');
    }

    if (task.actionGoal.goal.userId !== userId) {
      throw new ForbiddenException('You can only modify your own goals');
    }

    await this.prisma.task.delete({
      where: { id: taskId },
    });

    return `✓ Removed task "${task.title}" from "${task.actionGoal.goal.title}"`;
  }

  /**
   * Archive a goal (soft delete)
   */
  async archiveGoal(goalId: string, userId: string, reason?: string): Promise<string> {
    const goal = await this.verifyOwnership(goalId, userId);

    await this.prisma.goal.update({
      where: { id: goalId },
      data: { status: 'archived' },
    });

    let message = `✓ Archived "${goal.title}"`;
    if (reason) {
      message += ` (reason: ${reason})`;
    }
    return message;
  }

  /**
   * Reactivate an archived goal
   */
  async reactivateGoal(goalId: string, userId: string): Promise<string> {
    const goal = await this.prisma.goal.findUnique({
      where: { id: goalId },
    });

    if (!goal) {
      throw new NotFoundException('Goal not found');
    }

    if (goal.userId !== userId) {
      throw new ForbiddenException('You can only reactivate your own goals');
    }

    if (goal.status !== 'archived') {
      throw new ForbiddenException('Only archived goals can be reactivated');
    }

    await this.prisma.goal.update({
      where: { id: goalId },
      data: { status: 'active' },
    });

    return `✓ Reactivated "${goal.title}"`;
  }

  /**
   * Verify user owns the goal and optionally check type
   */
  private async verifyOwnership(goalId: string, userId: string, expectedType?: string) {
    const goal = await this.prisma.goal.findUnique({
      where: { id: goalId },
    });

    if (!goal) {
      throw new NotFoundException('Goal not found');
    }

    if (goal.userId !== userId) {
      throw new ForbiddenException('You can only modify your own goals');
    }

    if (expectedType && goal.type !== expectedType) {
      throw new ForbiddenException(`This operation is only valid for ${expectedType} goals`);
    }

    return goal;
  }

  /**
   * Check if a modification is allowed based on chat context
   */
  async checkPermission(
    goalId: string,
    userId: string,
    chatType: string,
    chatGoalId: string | undefined,
    chatCategoryId: string | undefined,
  ): Promise<{ allowed: boolean; reason?: string }> {
    // Verify ownership first
    const goal = await this.prisma.goal.findUnique({
      where: { id: goalId },
      select: { id: true, type: true, userId: true },
    });

    if (!goal) {
      return { allowed: false, reason: 'Goal not found' };
    }

    if (goal.userId !== userId) {
      return { allowed: false, reason: 'You can only modify your own goals' };
    }

    // Map goal type to category ID
    const goalTypeToCategory: Record<string, string> = {
      item: 'items',
      finance: 'finances',
      action: 'actions',
    };
    const goalCategoryId = goalTypeToCategory[goal.type] || 'items';

    // Check chat-based permissions
    return canModifyGoal(
      chatType as any,
      goalId,
      chatGoalId,
      chatCategoryId,
      goalCategoryId,
    );
  }
}
