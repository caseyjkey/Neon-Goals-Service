/**
 * OpenAI Tool Definitions for Goal Modification
 *
 * These tools allow AI agents to modify user goals through structured commands.
 * Tools are designed with proper validation and permission checks.
 */

export const GOAL_MODIFICATION_TOOLS = [
  {
    name: 'update_goal_title',
    description: 'Update the title of an existing goal. Use this when the user wants to rename a goal.',
    parameters: {
      type: 'object',
      properties: {
        goalId: {
          type: 'string',
          description: 'The ID of the goal to update',
        },
        title: {
          type: 'string',
          minLength: 1,
          maxLength: 100,
          description: 'The new title for the goal (1-100 characters)',
        },
      },
      required: ['goalId', 'title'],
    },
  },
  {
    name: 'update_goal_description',
    description: 'Update the description of an existing goal. Use this when the user wants to add or change details about their goal.',
    parameters: {
      type: 'object',
      properties: {
        goalId: {
          type: 'string',
          description: 'The ID of the goal to update',
        },
        description: {
          type: 'string',
          maxLength: 1000,
          description: 'The new description for the goal (max 1000 characters)',
        },
      },
      required: ['goalId', 'description'],
    },
  },
  {
    name: 'update_goal_target_date',
    description: 'Update the target date for achieving a goal. Use this when the user wants to change their deadline.',
    parameters: {
      type: 'object',
      properties: {
        goalId: {
          type: 'string',
          description: 'The ID of the goal to update',
        },
        targetDate: {
          type: 'string',
          format: 'date',
          description: 'The new target date in ISO 8601 format (YYYY-MM-DD)',
        },
      },
      required: ['goalId', 'targetDate'],
    },
  },
  {
    name: 'update_item_filters',
    description: 'Update search filters for an item goal. Use this when the user wants to change product criteria like brand, features, or price range.',
    parameters: {
      type: 'object',
      properties: {
        goalId: {
          type: 'string',
          description: 'The ID of the item goal to update',
        },
        filters: {
          type: 'object',
          description: 'The new search filters (can include brand, category, priceRange, features, etc.)',
          properties: {
            brand: { type: 'string', description: 'Preferred brand' },
            category: { type: 'string', description: 'Product category' },
            minPrice: { type: 'number', description: 'Minimum price' },
            maxPrice: { type: 'number', description: 'Maximum price' },
            features: {
              type: 'array',
              items: { type: 'string' },
              description: 'Required features',
            },
          },
        },
      },
      required: ['goalId', 'filters'],
    },
  },
  {
    name: 'update_finance_targets',
    description: 'Update financial targets for a finance goal. Use this when the user wants to change their savings target or monthly contribution.',
    parameters: {
      type: 'object',
      properties: {
        goalId: {
          type: 'string',
          description: 'The ID of the finance goal to update',
        },
        targetBalance: {
          type: 'number',
          minimum: 0,
          description: 'The new target balance amount',
        },
        monthlyContribution: {
          type: 'number',
          minimum: 0,
          description: 'The new monthly contribution amount',
        },
      },
      required: ['goalId'],
      // At least one of targetBalance or monthlyContribution must be provided
    },
  },
  {
    name: 'add_action_task',
    description: 'Add a task to an action goal. Use this when the user wants to add a new step or milestone to their skill/habit goal.',
    parameters: {
      type: 'object',
      properties: {
        goalId: {
          type: 'string',
          description: 'The ID of the action goal to update',
        },
        task: {
          type: 'object',
          properties: {
            title: {
              type: 'string',
              minLength: 1,
              maxLength: 200,
              description: 'Task title',
            },
            priority: {
              type: 'string',
              enum: ['low', 'medium', 'high'],
              description: 'Task priority level',
            },
          },
          required: ['title'],
        },
      },
      required: ['goalId', 'task'],
    },
  },
  {
    name: 'complete_action_task',
    description: 'Mark a task as completed in an action goal. Use this when the user has finished a step in their skill/habit goal.',
    parameters: {
      type: 'object',
      properties: {
        taskId: {
          type: 'string',
          description: 'The ID of the task to mark as completed',
        },
      },
      required: ['taskId'],
    },
  },
  {
    name: 'remove_action_task',
    description: 'Remove a task from an action goal. Use this when the user wants to delete a step from their skill/habit goal.',
    parameters: {
      type: 'object',
      properties: {
        taskId: {
          type: 'string',
          description: 'The ID of the task to remove',
        },
      },
      required: ['taskId'],
    },
  },
  {
    name: 'archive_goal',
    description: 'Archive a goal (soft delete). Use this when the user wants to hide a goal without permanently deleting it.',
    parameters: {
      type: 'object',
      properties: {
        goalId: {
          type: 'string',
          description: 'The ID of the goal to archive',
        },
        reason: {
          type: 'string',
          description: 'Optional reason for archiving',
        },
      },
      required: ['goalId'],
    },
  },
  {
    name: 'reactivate_goal',
    description: 'Reactivate an archived goal. Use this when the user wants to restore a previously archived goal.',
    parameters: {
      type: 'object',
      properties: {
        goalId: {
          type: 'string',
          description: 'The ID of the goal to reactivate',
        },
      },
      required: ['goalId'],
    },
  },
];

/**
 * Permission check result
 */
export interface PermissionCheckResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Chat type for permission context
 */
export type ChatType = 'overview' | 'category' | 'goal';

/**
 * Check if a goal modification is allowed based on chat context
 *
 * Rules:
 * - Overview chat: Can modify any goal (has full visibility)
 * - Goal chat: Can only modify the specific goal being discussed
 * - Category chat: Can only modify goals in that category
 */
export function canModifyGoal(
  chatType: ChatType,
  goalId: string,
  chatGoalId: string | undefined,
  chatCategoryId: string | undefined,
  goalCategoryId: string,
): PermissionCheckResult {
  // Overview chat can modify any goal
  if (chatType === 'overview') {
    return { allowed: true };
  }

  // Goal chat can only modify its own goal
  if (chatType === 'goal') {
    if (goalId === chatGoalId) {
      return { allowed: true };
    }
    return {
      allowed: false,
      reason: `This chat can only modify the goal it's discussing (ID: ${chatGoalId})`,
    };
  }

  // Category chat can only modify goals in its category
  if (chatType === 'category') {
    if (goalCategoryId === chatCategoryId) {
      return { allowed: true };
    }
    return {
      allowed: false,
      reason: `This ${chatCategoryId} specialist can only modify ${chatCategoryId} goals`,
    };
  }

  return {
    allowed: false,
    reason: 'Unknown chat type',
  };
}

/**
 * Map category ID to goal type
 */
export function categoryIdToGoalType(categoryId: string): string {
  const map: Record<string, string> = {
    items: 'item',
    finances: 'finance',
    actions: 'action',
  };
  return map[categoryId] || 'item';
}
