import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../config/prisma.service';
import { ScraperService } from '../scraper/scraper.service';
import { VehicleFilterService } from '../scraper/vehicle-filter.service';

export interface ExecutedCommand {
  type: string;
  success: boolean;
  goalId?: string;
  subgoalId?: string;
  taskId?: string;
  goal?: any;
  subgoal?: any;
  error?: string;
  proposalType?: 'accept_decline' | 'confirm_edit_cancel';
  awaitingConfirmation?: boolean;
}

// Mapping of command types to their proposal types
const COMMAND_PROPOSAL_TYPES: Record<string, 'accept_decline' | 'confirm_edit_cancel'> = {
  REFRESH_CANDIDATES: 'accept_decline',
  // All other commands default to confirm_edit_cancel
};

/**
 * Get the proposal type for a command
 */
function getProposalType(commandType: string): 'accept_decline' | 'confirm_edit_cancel' {
  return COMMAND_PROPOSAL_TYPES[commandType] || 'confirm_edit_cancel';
}

/**
 * Shared service for executing AI-generated goal commands.
 * Extracted from AiGoalCreationController and AiOverviewController to eliminate duplication.
 */
@Injectable()
export class GoalCommandService {
  private readonly logger = new Logger(GoalCommandService.name);

  constructor(
    private prisma: PrismaService,
    private scraperService: ScraperService,
    private vehicleFilterService: VehicleFilterService,
  ) {}

  /**
   * Execute parsed commands to create/update goals
   * Returns executed commands with their results
   */
  async executeCommands(userId: string, commands: any[]): Promise<ExecutedCommand[]> {
    const executedCommands: ExecutedCommand[] = [];

    for (const command of commands) {
      try {
        if (command.type === 'CREATE_GOAL') {
          const goal = await this.createGoal(userId, command.data);
          executedCommands.push({
            type: 'CREATE_GOAL',
            success: true,
            goalId: goal.id,
            goal,
            proposalType: getProposalType('CREATE_GOAL'),
            awaitingConfirmation: true,
          });
        } else if (command.type === 'CREATE_SUBGOAL') {
          const subgoal = await this.createSubgoal(userId, command.data);
          executedCommands.push({
            type: 'CREATE_SUBGOAL',
            success: true,
            subgoalId: subgoal.id,
            subgoal,
            proposalType: getProposalType('CREATE_SUBGOAL'),
            awaitingConfirmation: true,
          });
        } else if (command.type === 'UPDATE_PROGRESS') {
          await this.updateProgress(userId, command.data);
          executedCommands.push({
            type: 'UPDATE_PROGRESS',
            success: true,
            goalId: command.data.goalId,
            proposalType: getProposalType('UPDATE_PROGRESS'),
            awaitingConfirmation: true,
          });
        } else if (command.type === 'UPDATE_TITLE') {
          const goal = await this.updateTitle(userId, command.data);
          executedCommands.push({
            type: 'UPDATE_TITLE',
            success: true,
            goalId: goal.id,
            goal,
            proposalType: getProposalType('UPDATE_TITLE'),
            awaitingConfirmation: true,
          });
        } else if (command.type === 'UPDATE_SEARCHTERM') {
          const itemData = await this.updateSearchTerm(userId, command.data);
          executedCommands.push({
            type: 'UPDATE_SEARCHTERM',
            success: true,
            goalId: command.data.goalId,
            proposalType: getProposalType('UPDATE_SEARCHTERM'),
            awaitingConfirmation: true,
          });
        } else if (command.type === 'REFRESH_CANDIDATES') {
          const result = await this.refreshCandidates(userId, command.data);
          executedCommands.push({
            type: 'REFRESH_CANDIDATES',
            success: true,
            goalId: command.data.goalId,
            proposalType: getProposalType('REFRESH_CANDIDATES'),
            awaitingConfirmation: true,
          });
        } else if (command.type === 'UPDATE_FILTERS') {
          const goal = await this.updateFilters(userId, command.data);
          executedCommands.push({
            type: 'UPDATE_FILTERS',
            success: true,
            goalId: goal.id,
            goal,
            proposalType: getProposalType('UPDATE_FILTERS'),
            awaitingConfirmation: true,
          });
        } else if (command.type === 'ADD_TASK') {
          const goal = await this.addTask(userId, command.data);
          executedCommands.push({
            type: 'ADD_TASK',
            success: true,
            goalId: goal.id,
            goal,
            proposalType: getProposalType('ADD_TASK'),
            awaitingConfirmation: true,
          });
        } else if (command.type === 'REMOVE_TASK') {
          const goal = await this.removeTask(userId, command.data);
          executedCommands.push({
            type: 'REMOVE_TASK',
            success: true,
            taskId: goal.taskId,
            proposalType: getProposalType('REMOVE_TASK'),
            awaitingConfirmation: true,
          });
        } else if (command.type === 'ARCHIVE_GOAL') {
          const goal = await this.archiveGoal(userId, command.data);
          executedCommands.push({
            type: 'ARCHIVE_GOAL',
            success: true,
            goalId: goal.id,
            proposalType: getProposalType('ARCHIVE_GOAL'),
            awaitingConfirmation: true,
          });
        } else if (command.type === 'TOGGLE_TASK') {
          const goal = await this.toggleTask(userId, command.data);
          executedCommands.push({
            type: 'TOGGLE_TASK',
            success: true,
            goalId: goal.id,
            goal,
            proposalType: getProposalType('TOGGLE_TASK'),
            awaitingConfirmation: true,
          });
        }
      } catch (error) {
        this.logger.error(`Failed to execute command ${command.type}:`, error);
        executedCommands.push({
          type: command.type,
          success: false,
          error: error.message,
          proposalType: getProposalType(command.type),
        });
      }
    }

    return executedCommands;
  }

  /**
   * Create a new main goal from command data
   */
  async createGoal(userId: string, data: any) {
    const { type, title, description, tasks, deadline, targetDate } = data;

    // Convert deadline or targetDate string to Date object if provided
    // AI prompt uses targetDate, but we accept both for compatibility
    const deadlineDate = deadline ? new Date(deadline) : (targetDate ? new Date(targetDate) : null);

    if (type === 'action') {
      return this.prisma.goal.create({
        data: {
          type: 'action',
          title,
          description: description || `Working on: ${title}`,
          status: 'active',
          deadline: deadlineDate,
          userId,
          actionData: {
            create: {
              completionPercentage: 0,
              motivation: null,
              tasks: tasks ? {
                create: tasks.map((t: any) => ({
                  title: t.title || t,
                  completed: false,
                })),
              } : undefined,
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
    }

    // For item/finance goals, create with minimal defaults
    if (type === 'item') {
      // For vehicle goals, use LLM to generate retailer-specific filters
      let retailerFilters = null;
      const category = data.category || null;

      if (category === 'vehicle') {
        const searchQuery = data.searchTerm || title;
        this.logger.log(`Vehicle goal detected, parsing query: "${searchQuery}"`);

        retailerFilters = await this.vehicleFilterService.parseQuery(searchQuery);

        if (retailerFilters) {
          this.logger.log(`Generated retailer-specific filters for ${Object.keys(retailerFilters.retailers || {}).length} retailers`);
        } else {
          this.logger.warn(`Failed to generate retailer filters, will fall back to generic filters`);
        }
      }

      const goal = await this.prisma.goal.create({
        data: {
          type: 'item',
          title,
          description: description || `Saving for: ${title}`,
          status: 'active',
          deadline: deadlineDate,
          userId,
          itemData: {
            create: {
              productImage: null,
              bestPrice: data.budget || 0,
              currency: 'USD',
              retailerUrl: '',
              retailerName: 'TBD',
              statusBadge: 'pending_search',
              searchTerm: data.searchTerm || null,
              category: category,
              searchFilters: data.searchFilters || null,
              retailerFilters: retailerFilters,
            },
          },
        },
        include: {
          itemData: true,
        },
      });

      // Queue scraping job - scraper service will determine if scrapers exist for this category
      await this.scraperService.queueCandidateAcquisition(goal.id);

      return goal;
    }

    if (type === 'group') {
      return this.prisma.goal.create({
        data: {
          type: 'group',
          title,
          description: description || `Project: ${title}`,
          status: 'active',
          deadline: deadlineDate,
          userId,
          groupData: {
            create: {
              icon: data.icon || '📦',
              color: data.color || 'from-cyan-500 to-purple-500',
              layout: data.layout || 'grid',
              progressType: data.progressType || 'average',
              progress: 0,
            },
          },
        },
        include: {
          groupData: true,
          subgoals: true,
        },
      });
    }

    if (type === 'finance') {
      return this.prisma.goal.create({
        data: {
          type: 'finance',
          title,
          description: description || `Financial goal: ${title}`,
          status: 'active',
          deadline: deadlineDate,
          userId,
          financeData: {
            create: {
              institutionIcon: '🏦',
              accountName: 'Savings',
              currentBalance: data.currentBalance || 0,
              targetBalance: data.targetBalance || 1000,
              currency: 'USD',
              progressHistory: [data.currentBalance || 0],
            },
          },
        },
        include: {
          financeData: true,
        },
      });
    }

    throw new Error(`Unknown goal type: ${type}`);
  }

  /**
   * Create a subgoal under a parent goal
   * parentGoalId can be either an actual ID or a title (will be looked up)
   */
  async createSubgoal(userId: string, data: any) {
    const { parentGoalId, type, title, description, deadline, targetDate } = data;

    // Convert deadline or targetDate string to Date object if provided
    // AI prompt uses targetDate, but we accept both for compatibility
    const deadlineDate = deadline ? new Date(deadline) : (targetDate ? new Date(targetDate) : null);

    // Find parent goal - try by ID first, then by title (for recently created goals)
    let parentGoal = await this.prisma.goal.findFirst({
      where: {
        id: parentGoalId,
        userId,
      },
    });

    // If not found by ID, try by title (in case agent used title instead of ID)
    if (!parentGoal) {
      parentGoal = await this.prisma.goal.findFirst({
        where: {
          title: parentGoalId,
          userId,
          status: 'active',
        },
        orderBy: { createdAt: 'desc' },
      });
    }

    if (!parentGoal) {
      // Get available goals for better error message
      const availableGoals = await this.prisma.goal.findMany({
        where: {
          userId,
          status: 'active',
        },
        select: {
          id: true,
          title: true,
        },
      });

      const goalList = availableGoals.map(g => `- ${g.title} (ID: ${g.id})`).join('\n');

      throw new Error(
        `Parent goal not found: "${parentGoalId}"\n\n` +
        `Available goals:\n${goalList}\n\n` +
        `Tip: Use the goal's title or exact ID as parentGoalId`,
      );
    }

    // Create subgoal similar to createGoal but with parentGoalId
    if (type === 'action') {
      return this.prisma.goal.create({
        data: {
          type: 'action',
          title,
          description: description || `Step toward: ${parentGoal.title}`,
          status: 'active',
          deadline: deadlineDate,
          userId,
          parentGoalId: parentGoal.id,
          actionData: {
            create: {
              completionPercentage: 0,
            },
          },
        },
        include: {
          actionData: true,
        },
      });
    }

    // Handle item subgoals (e.g., vehicle as part of a larger goal)
    if (type === 'item') {
      // For vehicle goals, use LLM to generate retailer-specific filters
      let retailerFilters = null;
      const category = data.category || null;

      if (category === 'vehicle') {
        const searchQuery = data.searchTerm || title;
        this.logger.log(`Vehicle subgoal detected, parsing query: "${searchQuery}"`);

        retailerFilters = await this.vehicleFilterService.parseQuery(searchQuery);

        if (retailerFilters) {
          this.logger.log(`Generated retailer-specific filters for ${Object.keys(retailerFilters.retailers || {}).length} retailers`);
        } else {
          this.logger.warn(`Failed to generate retailer filters, will fall back to generic filters`);
        }
      }

      const subgoal = await this.prisma.goal.create({
        data: {
          type: 'item',
          title,
          description: description || `Item toward: ${parentGoal.title}`,
          status: 'active',
          deadline: deadlineDate,
          userId,
          parentGoalId: parentGoal.id,
          itemData: {
            create: {
              productImage: null,
              bestPrice: 0,
              currency: 'USD',
              retailerUrl: '',
              retailerName: 'TBD',
              statusBadge: 'pending_search',
              searchTerm: data.searchTerm || null,
              category: category,
              searchFilters: data.searchFilters || null,
              retailerFilters: retailerFilters,
            },
          },
        },
        include: {
          itemData: true,
        },
      });

      // Queue scraping job - scraper service will determine if scrapers exist for this category
      await this.scraperService.queueCandidateAcquisition(subgoal.id);

      return subgoal;
    }

    // Handle finance subgoals
    if (type === 'finance') {
      return this.prisma.goal.create({
        data: {
          type: 'finance',
          title,
          description: description || `Savings toward: ${parentGoal.title}`,
          status: 'active',
          deadline: deadlineDate,
          userId,
          parentGoalId: parentGoal.id,
          financeData: {
            create: {
              institutionIcon: '🏦',
              accountName: 'Savings',
              currentBalance: data.currentBalance || 0,
              targetBalance: data.targetBalance || 1000,
              currency: 'USD',
              progressHistory: [data.currentBalance || 0],
            },
          },
        },
        include: {
          financeData: true,
        },
      });
    }

    throw new Error(`Subgoal type ${type} not yet implemented`);
  }

  /**
   * Update goal progress
   */
  async updateProgress(userId: string, data: any) {
    const { goalId, currentBalance } = data;

    const goal = await this.prisma.goal.findFirst({
      where: {
        id: goalId,
        userId,
      },
      include: { financeData: true },
    });

    if (!goal) {
      throw new Error(`Goal not found: ${goalId}`);
    }

    if (goal.type === 'finance' && goal.financeData) {
      await this.prisma.financeGoalData.update({
        where: { goalId },
        data: { currentBalance },
      });
    }
  }

  /**
   * Update goal title (display name only)
   */
  async updateTitle(userId: string, data: { goalId: string; title: string }) {
    const { goalId, title } = data;

    const goal = await this.prisma.goal.findFirst({
      where: { id: goalId, userId },
    });

    if (!goal) {
      throw new Error(`Goal not found: ${goalId}`);
    }

    return this.prisma.goal.update({
      where: { id: goalId },
      data: { title },
    });
  }

  /**
   * Refresh candidates - queues a scrape job for an item goal
   */
  async refreshCandidates(userId: string, data: { goalId: string }) {
    const { goalId } = data;

    // Verify goal exists and belongs to user
    const goal = await this.prisma.goal.findFirst({
      where: { id: goalId, userId },
    });

    if (!goal) {
      throw new Error(`Goal not found: ${goalId}`);
    }

    if (goal.type !== 'item') {
      throw new Error('Can only refresh candidates for item goals');
    }

    // Queue scraping job
    await this.scraperService.queueCandidateAcquisition(goalId);

    return {
      message: 'Scraping job queued successfully',
      goalId,
      note: 'Candidates will be updated within 2 minutes',
    };
  }

  /**
   * Update search term and regenerate retailer filters
   * For vehicle goals, this triggers LLM-based filter generation
   */
  async updateSearchTerm(userId: string, data: { goalId: string; searchTerm: string }) {
    const { goalId, searchTerm } = data;

    const goal = await this.prisma.goal.findFirst({
      where: { id: goalId, userId },
      include: { itemData: true },
    });

    if (!goal) {
      throw new Error(`Goal not found: ${goalId}`);
    }

    if (goal.type !== 'item') {
      throw new Error(`Search term can only be updated for item goals`);
    }

    const category = goal.itemData?.category;

    // For vehicle goals, regenerate retailer-specific filters
    let retailerFilters = null;
    if (category === 'vehicle') {
      this.logger.log(`Vehicle goal searchTerm updated, regenerating retailer-specific filters from: "${searchTerm}"`);

      retailerFilters = await this.vehicleFilterService.parseQuery(searchTerm);

      if (retailerFilters) {
        this.logger.log(`Regenerated retailer-specific filters for ${Object.keys(retailerFilters.retailers || {}).length} retailers`);
      } else {
        this.logger.warn(`Failed to regenerate retailer filters, keeping existing ones`);
      }
    }

    return this.prisma.itemGoalData.update({
      where: { goalId },
      data: {
        searchTerm,
        retailerFilters,
      },
    });
  }

  /**
   * Update search filters for an item goal
   * For vehicle goals, also regenerates retailer-specific LLM filters
   */
  async updateFilters(userId: string, data: { goalId: string; filters: any }) {
    const { goalId, filters } = data;

    const goal = await this.prisma.goal.findFirst({
      where: { id: goalId, userId },
      include: { itemData: true },
    });

    if (!goal) {
      throw new Error(`Goal not found: ${goalId}`);
    }

    if (goal.type !== 'item') {
      throw new Error(`Filters can only be updated for item goals`);
    }

    // Merge new filters with existing
    const existingFilters = (goal.itemData?.searchFilters as Record<string, any> | undefined) || {};
    const mergedFilters: Record<string, any> = { ...existingFilters, ...(filters as Record<string, any>) };

    // For vehicle goals, regenerate retailer-specific LLM filters
    let retailerFilters = goal.itemData?.retailerFilters;
    const category = goal.itemData?.category;

    if (category === 'vehicle') {
      // Build a query from the updated filters to regenerate LLM filters
      // Start with the original searchTerm or title
      const searchQuery = goal.itemData?.searchTerm || goal.title;

      this.logger.log(`Vehicle goal filters updated, regenerating retailer-specific filters from: "${searchQuery}"`);

      retailerFilters = await this.vehicleFilterService.parseQuery(searchQuery);

      if (retailerFilters) {
        this.logger.log(`Regenerated retailer-specific filters for ${Object.keys(retailerFilters.retailers || {}).length} retailers`);
      } else {
        this.logger.warn(`Failed to regenerate retailer filters, keeping existing ones`);
        // Keep existing retailerFilters if regeneration fails
        retailerFilters = goal.itemData?.retailerFilters;
      }
    }

    return this.prisma.itemGoalData.update({
      where: { goalId },
      data: {
        searchFilters: mergedFilters,
        retailerFilters: retailerFilters,
      },
    });
  }

  /**
   * Add a task to an action goal
   */
  async addTask(userId: string, data: { goalId: string; task: { title: string; priority?: string } }) {
    const { goalId, task } = data;

    const goal = await this.prisma.goal.findFirst({
      where: { id: goalId, userId },
      include: { actionData: { include: { tasks: true } } },
    });

    if (!goal) {
      throw new Error(`Goal not found: ${goalId}`);
    }

    if (goal.type !== 'action') {
      throw new Error(`Tasks can only be added to action goals`);
    }

    // Create new task
    const newTask = await this.prisma.task.create({
      data: {
        title: task.title,
        completed: false,
        actionGoalId: goal.actionData?.id || goalId,
      },
    });

    return this.prisma.goal.findUnique({
      where: { id: goalId },
      include: { actionData: { include: { tasks: true } } },
    });
  }

  /**
   * Remove a task from an action goal
   */
  async removeTask(userId: string, data: { taskId: string }) {
    const { taskId } = data;

    // Find the task and verify ownership through the goal
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      include: { actionGoal: { include: { goal: true } } },
    });

    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    if (task.actionGoal.goal.userId !== userId) {
      throw new Error(`You can only remove tasks from your own goals`);
    }

    await this.prisma.task.delete({
      where: { id: taskId },
    });

    return { success: true, taskId };
  }

  /**
   * Toggle a task's completed status
   */
  async toggleTask(userId: string, data: { taskId: string }) {
    const { taskId } = data;

    // Find the task and verify ownership
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      include: { actionGoal: { include: { goal: true } } },
    });

    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    if (task.actionGoal.goal.userId !== userId) {
      throw new Error(`You can only toggle tasks from your own goals`);
    }

    const updatedTask = await this.prisma.task.update({
      where: { id: taskId },
      data: { completed: !task.completed },
    });

    return this.prisma.goal.findUnique({
      where: { id: task.actionGoal.goalId },
      include: { actionData: { include: { tasks: true } } },
    });
  }

  /**
   * Archive a goal (soft delete)
   */
  async archiveGoal(userId: string, data: { goalId: string }) {
    const { goalId } = data;

    const goal = await this.prisma.goal.findFirst({
      where: { id: goalId, userId },
    });

    if (!goal) {
      throw new Error(`Goal not found: ${goalId}`);
    }

    return this.prisma.goal.update({
      where: { id: goalId },
      data: { status: 'archived' },
    });
  }
}
