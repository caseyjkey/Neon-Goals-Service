import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../config/prisma.service';
import { GoalType, GoalStatus } from '@prisma/client';
import { ScraperService } from '../scraper/scraper.service';

@Injectable()
export class GoalsService {
  constructor(
    private prisma: PrismaService,
    private scraperService: ScraperService,
  ) {}

  async findAll(userId: string, filters?: { type?: GoalType; status?: GoalStatus }) {
    const where: any = { userId };

    if (filters?.type) where.type = filters.type;
    if (filters?.status) where.status = filters.status;

    return this.prisma.goal.findMany({
      where,
      include: {
        itemData: true,
        financeData: true,
        actionData: {
          include: {
            tasks: true,
          },
        },
      },
      orderBy: {
        updatedAt: 'desc',
      },
    });
  }

  async findOne(id: string, userId: string) {
    const goal = await this.prisma.goal.findFirst({
      where: { id, userId },
      include: {
        itemData: true,
        financeData: true,
        actionData: {
          include: {
            tasks: {
              orderBy: { createdAt: 'asc' },
            },
          },
        },
      },
    });

    if (!goal) {
      throw new NotFoundException(`Goal with ID ${id} not found`);
    }

    return goal;
  }

  async createItemGoal(userId: string, data: any) {
    const goal = await this.prisma.goal.create({
      data: {
        type: GoalType.item,
        title: data.title,
        description: data.description || `Looking for: ${data.title}`,
        status: data.status || GoalStatus.active,
        userId,
        itemData: {
          create: {
            productImage: data.productImage || 'https://images.unsplash.com/photo-1549317661-bd32c8ce0db2?w=400',
            bestPrice: data.bestPrice || data.targetAmount || 0,
            currency: data.currency || 'USD',
            retailerUrl: data.retailerUrl || 'https://www.autotrader.com',
            retailerName: data.retailerName || 'AutoTrader',
            statusBadge: data.statusBadge || 'pending_search',
            searchResults: data.searchResults || null,
            candidates: data.candidates || null,
            deniedCandidates: data.deniedCandidates || null,
            selectedCandidateId: data.selectedCandidateId || null,
            stackId: data.stackId || null,
            stackOrder: data.stackOrder ?? null,
          },
        },
      },
      include: {
        itemData: true,
      },
    });

    // Queue candidate acquisition in background
    await this.scraperService.queueCandidateAcquisition(goal.id);

    return this.findOne(goal.id, userId);
  }

  async createFinanceGoal(userId: string, data: any) {
    const goal = await this.prisma.goal.create({
      data: {
        type: GoalType.finance,
        title: data.title,
        description: data.description,
        status: data.status || GoalStatus.active,
        userId,
        financeData: {
          create: {
            institutionIcon: data.institutionIcon,
            accountName: data.accountName,
            currentBalance: data.currentBalance,
            targetBalance: data.targetBalance,
            currency: data.currency || 'USD',
            progressHistory: data.progressHistory || [],
          },
        },
      },
      include: {
        financeData: true,
      },
    });

    return this.findOne(goal.id, userId);
  }

  async createActionGoal(userId: string, data: any) {
    const goal = await this.prisma.goal.create({
      data: {
        type: GoalType.action,
        title: data.title,
        description: data.description,
        status: data.status || GoalStatus.active,
        userId,
        actionData: {
          create: {
            completionPercentage: data.completionPercentage || 0,
            tasks: {
              create: data.tasks || [],
            },
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

    return this.findOne(goal.id, userId);
  }

  async update(id: string, userId: string, data: any) {
    // Check if goal exists and belongs to user
    await this.findOne(id, userId);

    const updated = await this.prisma.goal.update({
      where: { id },
      data: {
        title: data.title,
        description: data.description,
        status: data.status,
      },
    });

    return this.findOne(id, userId);
  }

  async updateItemGoal(id: string, userId: string, data: any) {
    await this.findOne(id, userId);

    await this.prisma.itemGoalData.update({
      where: { goalId: id },
      data: {
        productImage: data.productImage,
        bestPrice: data.bestPrice,
        retailerUrl: data.retailerUrl,
        retailerName: data.retailerName,
        statusBadge: data.statusBadge,
        searchResults: data.searchResults,
        candidates: data.candidates !== undefined ? data.candidates : undefined,
        selectedCandidateId: data.selectedCandidateId !== undefined ? data.selectedCandidateId : undefined,
        shortlistedCandidates: data.shortlistedCandidates !== undefined ? data.shortlistedCandidates : undefined,
        deniedCandidates: data.deniedCandidates !== undefined ? data.deniedCandidates : undefined,
        stackId: data.stackId !== undefined ? data.stackId : undefined,
        stackOrder: data.stackOrder !== undefined ? data.stackOrder : undefined,
      },
    });

    return this.findOne(id, userId);
  }

  async updateFinanceGoal(id: string, userId: string, data: any) {
    await this.findOne(id, userId);

    await this.prisma.financeGoalData.update({
      where: { goalId: id },
      data: {
        currentBalance: data.currentBalance,
        targetBalance: data.targetBalance,
        progressHistory: data.progressHistory,
        lastSync: data.lastSync ? new Date(data.lastSync) : undefined,
      },
    });

    return this.findOne(id, userId);
  }

  async updateActionGoal(id: string, userId: string, data: any) {
    await this.findOne(id, userId);

    if (data.completionPercentage !== undefined) {
      await this.prisma.actionGoalData.update({
        where: { goalId: id },
        data: {
          completionPercentage: data.completionPercentage,
        },
      });
    }

    return this.findOne(id, userId);
  }

  async delete(id: string, userId: string) {
    await this.findOne(id, userId);

    await this.prisma.goal.delete({
      where: { id },
    });

    return { message: 'Goal deleted successfully' };
  }

  async archive(id: string, userId: string) {
    await this.findOne(id, userId);

    const goal = await this.prisma.goal.update({
      where: { id },
      data: { status: GoalStatus.archived },
    });

    return this.findOne(id, userId);
  }

  // Task operations for action goals
  async createTask(goalId: string, userId: string, data: { title: string }) {
    const goal = await this.findOne(goalId, userId);
    if (goal.type !== GoalType.action) {
      throw new NotFoundException('Goal is not an action goal');
    }

    const task = await this.prisma.task.create({
      data: {
        title: data.title,
        actionGoalId: goal.actionData?.id || '',
      },
    });

    // Recalculate completion percentage
    const allTasks = await this.prisma.task.findMany({
      where: { actionGoalId: goal.actionData?.id },
    });

    const completedCount = allTasks.filter(t => t.completed).length;
    const percentage = Math.round((completedCount / allTasks.length) * 100);

    await this.prisma.actionGoalData.update({
      where: { id: goal.actionData?.id },
      data: { completionPercentage: percentage },
    });

    return task;
  }

  async toggleTask(goalId: string, taskId: string, userId: string) {
    const goal = await this.findOne(goalId, userId);
    if (goal.type !== GoalType.action) {
      throw new NotFoundException('Goal is not an action goal');
    }

    const task = await this.prisma.task.findUnique({ where: { id: taskId } });
    if (!task || task.actionGoalId !== goal.actionData?.id) {
      throw new NotFoundException('Task not found');
    }

    const updated = await this.prisma.task.update({
      where: { id: taskId },
      data: { completed: !task.completed },
    });

    // Recalculate completion percentage
    const allTasks = await this.prisma.task.findMany({
      where: { actionGoalId: goal.actionData?.id },
    });

    const completedCount = allTasks.filter(t => t.completed).length;
    const percentage = Math.round((completedCount / allTasks.length) * 100);

    await this.prisma.actionGoalData.update({
      where: { id: goal.actionData?.id },
      data: { completionPercentage: percentage },
    });

    return updated;
  }

  async deleteTask(goalId: string, taskId: string, userId: string) {
    const goal = await this.findOne(goalId, userId);
    if (goal.type !== GoalType.action) {
      throw new NotFoundException('Goal is not an action goal');
    }

    const task = await this.prisma.task.findUnique({ where: { id: taskId } });
    if (!task || task.actionGoalId !== goal.actionData?.id) {
      throw new NotFoundException('Task not found');
    }

    await this.prisma.task.delete({ where: { id: taskId } });

    return { message: 'Task deleted successfully' };
  }

  // Candidate management methods
  async denyCandidate(goalId: string, userId: string, candidateUrl: string) {
    const goal = await this.findOne(goalId, userId);

    if (goal.type !== GoalType.item) {
      throw new BadRequestException('Not an item goal');
    }

    if (!goal.itemData) {
      throw new BadRequestException('Item data not found');
    }

    const candidates = (goal.itemData.candidates as any[]) || [];
    const deniedCandidates = (goal.itemData.deniedCandidates as any[]) || [];

    // Find the candidate being denied
    const candidateToMove = candidates.find((c) => c.url === candidateUrl);

    if (!candidateToMove) {
      throw new NotFoundException('Candidate not found');
    }

    // Add timestamp when denied
    const deniedCandidate = {
      ...candidateToMove,
      deniedAt: new Date().toISOString(),
    };

    // Move from candidates to deniedCandidates
    const updatedCandidates = candidates.filter((c) => c.url !== candidateUrl);
    const updatedDenied = [...deniedCandidates, deniedCandidate];

    await this.prisma.itemGoalData.update({
      where: { goalId },
      data: {
        candidates: updatedCandidates as any,
        deniedCandidates: updatedDenied as any,
      },
    });

    return this.findOne(goalId, userId);
  }

  async restoreCandidate(goalId: string, userId: string, candidateUrl: string) {
    const goal = await this.findOne(goalId, userId);

    if (goal.type !== GoalType.item) {
      throw new BadRequestException('Not an item goal');
    }

    if (!goal.itemData) {
      throw new BadRequestException('Item data not found');
    }

    const candidates = (goal.itemData.candidates as any[]) || [];
    const deniedCandidates = (goal.itemData.deniedCandidates as any[]) || [];

    // Find the denied candidate
    const candidateToRestore = deniedCandidates.find(
      (c) => c.url === candidateUrl,
    );

    if (!candidateToRestore) {
      throw new NotFoundException('Denied candidate not found');
    }

    // Remove deniedAt timestamp
    const { deniedAt, ...restoredCandidate } = candidateToRestore;

    // Move from deniedCandidates back to candidates
    const updatedCandidates = [...candidates, restoredCandidate];
    const updatedDenied = deniedCandidates.filter(
      (c) => c.url !== candidateUrl,
    );

    await this.prisma.itemGoalData.update({
      where: { goalId },
      data: {
        candidates: updatedCandidates as any,
        deniedCandidates: updatedDenied as any,
      },
    });

    return this.findOne(goalId, userId);
  }

  async getDeniedCandidates(goalId: string, userId: string) {
    const goal = await this.findOne(goalId, userId);

    if (goal.type !== GoalType.item) {
      throw new BadRequestException('Not an item goal');
    }

    return goal.itemData?.deniedCandidates || [];
  }

  async getScrapeJobs(goalId: string, userId: string) {
    // Verify goal belongs to user
    await this.findOne(goalId, userId);

    return this.prisma.scrapeJob.findMany({
      where: { goalId },
      orderBy: { createdAt: 'desc' },
      take: 10,
    });
  }
}
