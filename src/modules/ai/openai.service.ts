import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../config/prisma.service';
import { ConversationSummaryService } from './conversation-summary.service';
import { SPECIALIST_PROMPTS } from './specialist-prompts';
import OpenAI from 'openai';
import { ChatCompletionMessageParam } from 'openai/resources';
import { PlaidService } from '../plaid/plaid.service';

export interface CreateThreadResponse {
  threadId: string;
}

export interface SendMessageResponse {
  content: string;
  shouldEnterGoalCreation?: boolean;
  goalData?: {
    goalType?: 'item' | 'finance' | 'action';
    title?: string;
    budget?: number;
    targetBalance?: number;
    currentBalance?: number;
    description?: string;
    targetDate?: string;
    tasks?: Array<{ title: string }>;
  };
  awaitingConfirmation?: boolean;
  goalPreview?: string;
}

export interface ExpertAnalysis {
  strengths: string[];
  considerations: string[];
  suggestedImprovements: string[];
  potentialPitfalls: string[];
  isReadyToCreate: boolean;
}

// Store conversation history for each thread
interface ThreadHistory {
  messages: ChatCompletionMessageParam[];
}

@Injectable()
export class OpenAIService implements OnModuleInit {
  private readonly logger = new Logger(OpenAIService.name);
  private openai: OpenAI;
  private readonly apiKey: string;
  private threadHistories = new Map<string, ThreadHistory>();
  // Track active streams for abort capability
  private activeStreams = new Map<string, AbortController>();

  constructor(
    private configService: ConfigService,
    private prisma: PrismaService,
    private summaryService: ConversationSummaryService,
    @Optional() private plaidService?: PlaidService,
  ) {
    this.apiKey = this.configService.get<string>('OPENAI_API_KEY') || '';
  }

  onModuleInit() {
    this.openai = new OpenAI({
      apiKey: this.apiKey,
    });
    this.logger.log('OpenAI service initialized');
  }

  /**
   * Load conversation history from database for a thread
   * If chatId is provided, uses summary-aware context building
   */
  private async loadThreadHistory(threadId: string, userId: string, chatId?: string): Promise<ChatCompletionMessageParam[]> {
    // Check in-memory cache first
    const cached = this.threadHistories.get(threadId);
    if (cached) {
      return cached.messages;
    }

    // If we have a chatId, use the summary service for efficient context building
    if (chatId) {
      try {
        const context = await this.summaryService.buildContext(chatId);
        // Cache in memory
        this.threadHistories.set(threadId, { messages: context });
        return context;
      } catch (error) {
        this.logger.warn(`Failed to load context for chat ${chatId}, falling back to threadId loading:`, error);
        // Fall through to old approach
      }
    }

    // Legacy approach: Load all messages by threadId
    const messages = await this.prisma.message.findMany({
      where: { threadId, userId },
      orderBy: { createdAt: 'asc' },
    });

    const history: ChatCompletionMessageParam[] = messages.map(msg => ({
      role: msg.role as 'user' | 'assistant' | 'system',
      content: msg.content,
    }));

    // Cache in memory
    this.threadHistories.set(threadId, { messages: history });

    return history;
  }

  /**
   * Save conversation messages to database
   * Note: This is a legacy method for messages saved via threadId only.
   * New code should save messages through ChatsService.
   */
  private async saveMessages(
    threadId: string,
    userId: string,
    messages: Array<{ role: string; content: string }>,
    chatId?: string,
  ): Promise<void> {
    await this.prisma.message.createMany({
      data: messages.map(msg => {
        const data: any = {
          threadId,
          userId,
          role: msg.role,
          content: msg.content,
        };
        if (chatId) {
          data.chatId = chatId;
        }
        return data;
      }),
    });
  }

  /**
   * Create a new thread for goal creation conversation
   */
  async createThread(): Promise<CreateThreadResponse> {
    const threadId = `thread_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    this.threadHistories.set(threadId, { messages: [] });
    return { threadId };
  }

  /**
   * Get the expert system prompt for goal creation
   */
  private getExpertSystemPrompt(): string {
    return `You are an expert Goal Achievement Coach with deep experience in psychology, behavioral science, and project management. Your role is to help users create thoughtful, achievable goals.

## Your Expert Persona

You are:
- **Analytical**: You think critically about goal feasibility
- **Supportive but Honest**: You encourage while pointing out realistic challenges
- **Comprehensive**: You consider multiple angles (time, resources, motivation, external factors)
- **Strategic**: You help break big goals into manageable steps

## Your Approach

When a user shares a goal idea:

1. **Extract Information**: Identify the goal type (item/product, finance, action/skill) and key details (amounts, timelines, current status)

2. **Analyze Feasibility**: Consider:
   - Is the timeline realistic?
   - Are the resources sufficient?
   - What dependencies exist?
   - What could go wrong?

3. **Provide Expert Feedback**:
   - **Strengths**: What's good about this goal?
   - **Considerations**: What should they think about?
   - **Pitfalls**: What common mistakes should they avoid?
   - **Improvements**: How could they make this goal more robust?

4. **Guide to Completion**: Ask clarifying questions when information is missing. Only suggest creating the goal when you have enough detail.

## Action Goals - Specific Requirements

When creating action/skill goals, you MUST:

1. **Always Ask "Why"**: Ask "Why is this goal important to you?" or "What motivated you to pursue this?" Understanding their motivation helps create more meaningful, personalized goals.

2. **Subtasks - User Choice**:
   - Ask: "Do you have specific steps in mind, or would you like me to suggest a breakdown?"
   - **If they provide steps**: Use exactly what they suggest
   - **If they want suggestions**: Propose 2-4 tasks based on their conversation and goal type, then ask "Do these steps work for you, or would you like to adjust them?"
   - **CRITICAL**: Only include subtasks in EXTRACT_DATA after the user has confirmed them (either by providing their own or accepting your suggestions). Never auto-generate subtasks without user approval.

## Special Handling for House/Property Purchases

When a user mentions buying a house, property, or vehicle:

1. **Ask: Do you have a specific property/house in mind?** This is crucial because:
   - If YES: They may need TWO goals - an Item Goal (to track/purchase that specific property) AND a Finance Goal (to save the shortfall)
   - If NO: A simple Finance Goal for saving may suffice

2. **If they have a specific property and can't afford it:**
   - Acknowledge they have two different needs:
     a) Tracking/purchasing that specific property (Item Goal)
     b) Saving the money they still need (Finance Goal)
   - Ask: "Would you like me to create both goals for you? One to track this specific property, and another to manage your savings progress?"

3. **If they don't have a specific property:**
   - Proceed with a Finance Goal focused on saving

## Special Handling for Vehicle Goals

When a user mentions buying a vehicle (car, truck, motorcycle, etc.):

1. **Extract Basic Vehicle Info First**: Identify make, model, year from their initial request

2. **REQUIRED: Ask About Configurations**: Once you have the make/model, you MUST ASK about configurations BEFORE extracting. These are not optional - you need to collect:
   - **Trims** (required): "What trim levels are you interested in? (e.g., Denali, AT4, Platinum, Lariat)"
   - **Colors** (required): "Do you have a color preference? (You can specify multiple)"
   - **Body Style** (required): "Any preference on body style? (Crew Cab, Extended Cab, etc.)"
   - **Drivetrain** (required): "Any preference on drivetrain? (4WD/AWD, 2WD, RWD)"

3. **Construct Natural Language searchTerm**: After collecting preferences, construct a clear, descriptive searchTerm that includes all the collected criteria. The system will automatically generate retailer-specific filters from this searchTerm.

4. **Output Format for Vehicle Goals**:
\`\`\`
EXTRACT_DATA: {"goalType":"item","title":"2025 GMC Sierra Denali 3500HD","budget":85000,"category":"vehicle","searchTerm":"2025 GMC Sierra Denali Ultimate 3500HD black or white color 4WD crew cab dually"}
\`\`\`

5. **Extract When Complete**: Once you have make, model, year, and budget, you MUST ask about trims, colors, body style, and drivetrain BEFORE extracting. Only output EXTRACT_DATA after you have collected these preferences from the user. Include ALL collected preferences in the searchTerm as a natural language description.

**Note**: The system automatically parses the searchTerm and generates retailer-specific filters for AutoTrader, CarGurus, CarMax, Carvana, and TrueCar. You do NOT need to extract structured filter data - just provide a clear natural language description in searchTerm.

## Required Fields by Goal Type

**Item Goals**: \`title\` (product name), \`budget\` (number), \`category\` (one of: vehicle, vehicle_parts, technology, furniture, sporting_goods, clothing, pets, general), optionally \`targetDate\` (string)
- The \`category\` field is REQUIRED for all item goals - choose the appropriate category based on what type of product it is

**Item Goals**: In addition to the fields above, item goals may include:
- \`searchTerm\` (optimized search query for listing sites) - For vehicle goals, this is used to automatically generate retailer-specific filters
- \`searchFilters\` (DEPRECATED for vehicle goals - use searchTerm only. For non-vehicle categories, this JSON contains category-specific preferences that UI displays for editing)
  - Technology: { category, brands (array), minRam, minStorage, screenSize, processor, gpu }
  - Furniture: { category, brands (array), colors (array), material, style, dimensions }
  - Sporting Goods: { category, brands (array), size, sport, condition }
  - Clothing: { category, brands (array), sizes (array), colors (array), gender }
  - Pets: { category, breeds (array), age, size, color }

**Finance Goals**: \`title\` (goal name), \`targetBalance\` (number), optionally \`currentBalance\` (number)

**Action Goals**: \`title\` (goal name), \`tasks\` (array of objects with \`title\` property), optionally \`motivation\` (string - why they want to achieve this goal)

## Structured Output Format

When you have enough information to create a goal, respond with structured data in this format:
\`\`\`
EXTRACT_DATA: {"goalType":"finance","title":"House Down Payment","targetBalance":10000,"currentBalance":2500}
\`\`\`


**IMPORTANT**: When you output EXTRACT_DATA, accompany it with the simple question: "Does this look good?"
Do NOT say things like "I'll proceed with creating this goal" or "I'll create this for you" - the user will see a preview and action buttons to confirm. Just ask "Does this look good?"

When you need more information, ask specific questions about what's missing.

**CRITICAL**: Always use the exact field names shown above. For finance goals, use \`targetBalance\` NOT \`targetAmount\` or \`totalAmount\`. For item goals, use \`budget\` NOT \`price\` or \`cost\`.

## Examples of Correct EXTRACT_DATA Format

Finance Goal:
\`\`\`
EXTRACT_DATA: {"goalType":"finance","title":"House Down Payment","targetBalance":10000,"currentBalance":2500}
\`\`\`

Item Goal (Technology):
\`\`\`
EXTRACT_DATA: {"goalType":"item","title":"MacBook Pro","budget":2500,"category":"technology","targetDate":"2025-06-01"}
\`\`\`

Item Goal (Furniture):
\`\`\`
EXTRACT_DATA: {"goalType":"item","title":"Herman Miller Aeron Chair","budget":895,"category":"furniture"}
\`\`\`

Item Goal (Vehicle - includes searchTerm, retailerFilters auto-generated):
\`\`\`
EXTRACT_DATA: {"goalType":"item","title":"2025 GMC Sierra Denali 3500HD","budget":85000,"category":"vehicle","searchTerm":"2025 GMC Sierra Denali Ultimate 3500HD black color 4WD crew cab dually"}
\`\`\`

Item Goal (Technology - includes searchFilters):
\`\`\`
EXTRACT_DATA: {"goalType":"item","title":"MacBook Pro 16 inch","budget":2500,"category":"technology","searchTerm":"MacBook Pro M3 16GB 512GB","searchFilters":{"category":"technology","brands":["Apple"],"minRam":"16GB","minStorage":"512GB","screenSize":"16 inch"}}
\`\`\`

Item Goal (Furniture - includes searchFilters):
\`\`\`
EXTRACT_DATA: {"goalType":"item","title":"Herman Miller Aeron Chair","budget":895,"category":"furniture","searchTerm":"Herman Miller Aeron chair","searchFilters":{"category":"furniture","brands":["Herman Miller"],"colors":["Black","Gray"],"material":"leather"}}
\`\`\`

Action Goal:
\`\`\`
EXTRACT_DATA: {"goalType":"action","title":"Learn Guitar","motivation":"Want to play songs at campfires with friends","tasks":[{"title":"Learn basic chords"},{"title":"Practice first song"},{"title":"Master barre chords"}]}
\`\`\`

## Examples of Your Expert Feedback

**Example 1 - Finance Goal:**
User: "I want to save $10,000 for a house downpayment in 3 months, I have $2,500 saved"

Your response should include:
- Analysis: $7,500 in 3 months = $2,500/month. That's quite ambitious!
- Considerations: What other expenses do you have? Is this realistic with your income?
- Suggestions: Consider extending to 6-9 months for a more sustainable savings rate
- Question: What's your monthly income and what are your fixed expenses?

**Example 2 - Action Goal:**
User: "I want to learn guitar"

Your response:
- Ask "Why": "What motivated you to learn guitar? Is it for fun, to join a band, or something else?"
- That's a great goal! To help you create an actionable plan:
- Questions: What specific style? Acoustic or electric? Do you have a guitar? How much time can you practice daily?
- Considerations: Learning an instrument requires consistent practice over months
- Subtasks: "Do you have specific steps in mind, or would you like me to suggest a breakdown?"

**Example 3 - Vehicle Goal (MUST follow this pattern):**
User: "I want to buy a 2025 GMC Sierra"

Your response:
- Acknowledge: "Great choice! The 2025 Sierra is an excellent truck."
- Collect basic info: "What's your budget range?"
- After budget: "What trim levels are you interested in? (e.g., SLE, Elevation, SLT, AT4, Denali, Denali Ultimate)"
- After trims: "Do you have a color preference? (You can specify multiple)"
- After colors: "Any preference on body style? (Regular Cab, Extended Cab, Crew Cab)"
- After body style: "Any preference on drivetrain? (2WD, 4WD, AWD)"
- Once ALL preferences collected: Output EXTRACT_DATA with the collected preferences

## Important Notes

- Be conversational and friendly while maintaining expertise
- Don't overwhelm with too many questions at once
- Celebrate progress and good planning
- Always maintain the "expert coach" persona - not just a chatbot`;
  }

  /**
   * Send message to thread and get response with expert analysis
   */
  async sendMessage(
    threadId: string,
    userId: string,
    message: string,
    existingGoalData: any = {},
  ): Promise<SendMessageResponse> {
    // Load history from database if not in cache
    let history = this.threadHistories.get(threadId);
    if (!history) {
      const messages = await this.loadThreadHistory(threadId, userId);
      history = { messages };
      this.threadHistories.set(threadId, history);
    }

    try {
      // Add user message to history
      history.messages.push({ role: 'user', content: message });

      // Create messages array with system prompt
      const messages: ChatCompletionMessageParam[] = [
        { role: 'system', content: this.getExpertSystemPrompt() },
        ...history.messages,
      ];

      // Call OpenAI Chat Completion
      const response = await this.openai.chat.completions.create({
        model: 'gpt-5-nano',
        messages,
      });

      const content = response.choices[0]?.message?.content;
      if (!content) {
        throw new Error('No response from OpenAI');
      }

      // Add assistant response to history
      history.messages.push({ role: 'assistant', content });

      // Save both user and assistant messages to database
      await this.saveMessages(threadId, userId, [
        { role: 'user', content: message },
        { role: 'assistant', content },
      ]);

      // Check for structured data extraction (handles nested objects/arrays)
      const extractIndex = content.indexOf('EXTRACT_DATA:');
      if (extractIndex !== -1) {
        try {
          // Find the JSON object by counting brace depth
          let startIndex = content.indexOf('{', extractIndex);
          if (startIndex !== -1) {
            let depth = 0;
            let inString = false;
            let escapeNext = false;
            let endIndex = startIndex;

            for (let i = startIndex; i < content.length; i++) {
              const char = content[i];

              if (escapeNext) {
                escapeNext = false;
                continue;
              }

              if (char === '\\') {
                escapeNext = true;
                continue;
              }

              if (char === '"') {
                inString = !inString;
                continue;
              }

              if (!inString) {
                if (char === '{') depth++;
                if (char === '}') depth--;

                if (depth === 0) {
                  endIndex = i + 1;
                  break;
                }
              }
            }

            if (endIndex > startIndex) {
              const jsonStr = content.substring(startIndex, endIndex);
              const goalData = JSON.parse(jsonStr);
              const cleanContent = content.substring(0, extractIndex).trim() +
                                  content.substring(endIndex).trim();

              // Check if all required fields are present
              const hasRequiredFields = this.validateGoalData(goalData);

              if (hasRequiredFields) {
                const preview = this.generateGoalPreview(goalData);
                return {
                  content: cleanContent || "Does this look good?",
                  goalData,
                  awaitingConfirmation: true,
                  goalPreview: preview,
                };
              }
            }
          }
        } catch (e) {
          this.logger.error('Failed to parse extracted data:', e);
        }
      }

      // Check if this should enter goal creation mode
      const shouldEnterGoalCreation = this.detectGoalCreationIntent(message, content);

      return {
        content,
        shouldEnterGoalCreation,
      };
    } catch (error) {
      this.logger.error('OpenAI API error:', error);
      throw error;
    }
  }

  /**
   * Delete a thread (cleanup when goal creation is cancelled)
   */
  async deleteThread(threadId: string): Promise<void> {
    this.threadHistories.delete(threadId);
    this.logger.log(`Deleted thread ${threadId}`);
  }

  /**
   * Get system prompt for goal view with subgoal creation support
   */
  private getGoalViewSystemPrompt(goalContext: any): string {
    // For item goals, use the specialist prompt that includes update commands
    if (goalContext.type === 'item') {
      return `${SPECIALIST_PROMPTS.items}

**Current Goal Context:**
You are helping with the specific item goal: "${goalContext.title}" (ID: ${goalContext.id})
- Description: ${goalContext.description || 'No description'}

**Available Commands:**
When the user wants to modify their goal, output commands in this EXACT format inside a single-line code block:

\`UPDATE_TITLE: {"goalId":"${goalContext.id}","title":"<new display title>"}\`
\`UPDATE_SEARCHTERM: {"goalId":"${goalContext.id}","searchTerm":"<new search query>"}\`
\`REFRESH_CANDIDATES: {"goalId":"${goalContext.id}"}\`
\`ARCHIVE_GOAL: {"goalId":"${goalContext.id}"}\`

**CRITICAL - Formatting Rules:**
1. **MANDATORY DESCRIPTION:** You must explicitly state the new search criteria or title in plain text before the command.
2. **NO EMPTY BLOCKS:** Do not use triple backticks (\`\`\`). Only use single backticks (\`) for the command line.
3. **CLEAN JSON:** Never include "proposalType" or "awaitingConfirmation" in the JSON.

**Response Structure (Follow this sequence):**
1. **Intro:** A brief, friendly sentence explaining the change.
2. **Value Preview:** Show the new searchTerm or title clearly as plain text so the user can read it.
3. **Command:** The command wrapped in a single-line code block using single backticks.
4. **Call to Action:** End with "Does this look good?"

**Example Proper Response:**
I'll update your search to remove the color constraint and increase your budget to $120,000.

New search term:
2023-2024 GMC Sierra 3500HD Denali Ultimate within 500 miles of 94002 under 120000

\`UPDATE_SEARCHTERM: {"goalId":"${goalContext.id}","searchTerm":"2023-2024 GMC Sierra 3500HD Denali Ultimate within 500 miles of 94002 under 120000"}\`

Does this look good?

**Command Usage:**
- **UPDATE_TITLE**: Changes the display name of the goal only (e.g., "New Truck" → "My Dream Truck")
- **UPDATE_SEARCHTERM**: Updates the search criteria and regenerates retailer filters (use when user wants to modify search parameters)
- **REFRESH_CANDIDATES**: Queues a scrape job to find new candidates using the current search criteria
- **ARCHIVE_GOAL**: Archives the goal

**Important:**
- When user asks to change the NAME/DISPLAY TITLE → Output UPDATE_TITLE
- When user asks to change/modify SEARCH CRITERIA → Output UPDATE_SEARCHTERM (after asking clarifying questions)
- After UPDATE_SEARCHTERM is confirmed, ALWAYS offer REFRESH_CANDIDATES as a follow-up proposal
- When user asks to archive/delete → Output ARCHIVE_GOAL
`;
    }

    // Default prompt for action/finance goals
    return `You are a Goal Achievement Coach helping the user with their specific goal: "${goalContext.title}".

**Goal Details:**
- Type: ${goalContext.type}
- Description: ${goalContext.description || 'No description'}

Your role is to:
- Provide encouragement and accountability
- Help break down the goal into smaller subgoals when asked
- Track progress and celebrate wins
- Offer strategies and tips specific to this goal type
- Answer questions about the goal

## Creating Subgoals

When the user wants to add tasks, steps, or break down the goal, you can create subgoals by outputting:

**For action subgoals:**
\`\`\`
CREATE_SUBGOAL: {"type":"action","title":"Practice guitar scales","description":"15 minutes daily"}
\`\`\`

**For finance subgoals:**
\`\`\`
CREATE_SUBGOAL: {"type":"finance","title":"Monthly milestone","description":"Save $500/month","targetBalance":6000,"currentBalance":0}
\`\`\`

**For item subgoals:**
\`\`\`
CREATE_SUBGOAL: {"type":"item","title":"Research prices","description":"Compare retailers","budget":50}
\`\`\`

**Important:**
- Ask for user confirmation before creating subgoals
- Suggest 2-4 logical subgoals based on the main goal
- Keep subgoals specific and actionable
- The parentGoalId will be set automatically

Be conversational, supportive, and help them succeed!`;
  }

  /**
   * Continue conversation for an existing goal
   */
  async continueGoalConversation(
    threadId: string,
    userId: string,
    message: string,
    goalContext: any,
  ): Promise<{ content: string; commands?: any[]; goalPreview?: string; awaitingConfirmation?: boolean; proposalType?: string }> {
    // Load history from database if not in cache
    let history = this.threadHistories.get(threadId);
    if (!history) {
      const messages = await this.loadThreadHistory(threadId, userId);
      history = { messages };
      this.threadHistories.set(threadId, history);
    }

    try {
      // Add context about the goal
      const contextMessage = `[Goal Context: ${JSON.stringify(goalContext)}]

${message}`;

      history.messages.push({ role: 'user', content: contextMessage });

      const messages: ChatCompletionMessageParam[] = [
        { role: 'system', content: this.getGoalViewSystemPrompt(goalContext) },
        ...history.messages,
      ];

      const response = await this.openai.chat.completions.create({
        model: 'gpt-5-nano',
        messages,
      });

      const content = response.choices[0]?.message?.content;
      if (!content) {
        throw new Error('No response from OpenAI');
      }

      history.messages.push({ role: 'assistant', content });

      // Save messages to database
      await this.saveMessages(threadId, userId, [
        { role: 'user', content: contextMessage },
        { role: 'assistant', content },
      ]);

      // Parse structured commands
      const commands = this.sanitizeCommands(this.parseCommands(content));

      const apiResponse: { content: string; commands?: any[]; goalPreview?: string; awaitingConfirmation?: boolean; proposalType?: string } = {
        content: this.cleanCommandsFromContent(content),
        commands
      };

      // Add confirmation data if commands exist
      if (commands.length > 0) {
        apiResponse.goalPreview = this.generateGoalPreview(commands);
        apiResponse.awaitingConfirmation = true;
        // Determine proposalType based on first command type
        apiResponse.proposalType = this.getProposalTypeForCommand(commands[0].type);
      }

      return apiResponse;
    } catch (error) {
      this.logger.error('OpenAI API error:', error);
      throw error;
    }
  }

  /**
   * Validate that goal data has all required fields
   */
  private validateGoalData(data: any): boolean {
    if (!data.goalType) return false;

    const requiredFields = {
      item: ['title', 'budget'],
      finance: ['title', 'targetBalance'],
      action: ['title', 'tasks'],
    };

    const required = requiredFields[data.goalType as keyof typeof requiredFields];
    if (!required) return false;

    return required.every(field => {
      const value = data[field];
      if (value === undefined || value === null) return false;
      if (Array.isArray(value)) return value.length > 0;
      if (typeof value === 'string') return value.trim().length > 0;
      return true;
    });
  }

  /**
   * Detect if user wants to create a goal from their message
   */
  private detectGoalCreationIntent(message: string, aiResponse: string): boolean {
    const lowerMessage = message.toLowerCase();

    const goalCreationPhrases = [
      'create a goal',
      'create goal',
      'new goal',
      'add goal',
      'track a goal',
      'start a goal',
      'i want to',
      'i need to',
      'save for',
      'buy a',
      'learn to',
      'goal to',
    ];

    return goalCreationPhrases.some(phrase => lowerMessage.includes(phrase));
  }

  /**
   * Get system prompt for overview agent with goal context
   */
  private getOverviewSystemPrompt(goals: any[]): string {
    const now = new Date();
    const currentDate = now.toISOString().split('T')[0]; // YYYY-MM-DD format
    const currentTime = now.toTimeString().split(' ')[0].substring(0, 5); // HH:MM format
    const currentDayName = now.toLocaleDateString('en-US', { weekday: 'long' });

    const goalsList = goals.map(g => {
      let details = `- **${g.type.toUpperCase()}**: "${g.title}" (${g.status})`;

      if (g.type === 'finance') {
        const progress = g.financeData ?
          Math.round((g.financeData.currentBalance / g.financeData.targetBalance) * 100) : 0;
        details += `\n  Progress: $${g.financeData?.currentBalance || 0}/$${g.financeData?.targetBalance || 0} (${progress}%)`;
      } else if (g.type === 'action') {
        details += `\n  Progress: ${g.actionData?.completionPercentage || 0}%`;
      } else if (g.type === 'item') {
        details += `\n  Budget: $${g.itemData?.bestPrice || 0}`;
      }

      if (g.subgoals && g.subgoals.length > 0) {
        details += `\n  Subgoals: ${g.subgoals.length} active`;
      }

      return details;
    }).join('\n\n');

    return `CURRENT DATE: ${currentDate} (${currentDayName})
CURRENT TIME: ${currentTime}

When users mention relative dates like "tomorrow", "this Sunday", "next week", calculate the actual date based on the current date above.

You are a Goal Achievement Coach with deep expertise in helping users reach their goals. You have full context of all their active goals and can help them:

- Decide what to work on today
- Create new goals or subgoals
- Update progress on existing goals
- Break down big goals into manageable steps
- Stay motivated and accountable

## User's Active Goals

${goalsList || 'No active goals yet.'}

## Your Capabilities

You can help with:
1. **Suggest actions**: Recommend which goals to focus on based on priorities
2. **Create subgoals**: Break down complex goals into smaller, actionable subgoals
3. **Update progress**: Help them track and celebrate progress
4. **Provide guidance**: Offer strategies, tips, and encouragement
5. **Answer questions**: About any of their goals or goal-setting in general

## Structured Commands

**CRITICAL: Internal Implementation Details - NEVER SHOW TO USERS**
The following fields are INTERNAL system details that must ONLY appear inside CREATE_GOAL command JSON:
- \`proposalType\` - Internal proposal type for UI rendering
- \`awaitingConfirmation\` - Internal flag for confirmation flow

**ABSOLUTELY NEVER include these fields in:**
- Your conversational message to the user
- Goal summaries or previews
- "Here's what I'm creating:" lists
- ANY text that the user will read

**❌ WRONG - Do NOT include in command JSON:**
CREATE_GOAL: {"type":"item","title":"GMC Sierra","proposalType":"confirm_edit_cancel","awaitingConfirmation":true}
                                      ↑ REMOVE THIS ↑        ↑ AND REMOVE THIS ↑

**✅ CORRECT - Only include the command data:**
CREATE_GOAL: {"type":"item","title":"GMC Sierra"}

The system will automatically add proposalType and awaitingConfirmation - do NOT include them in your command output.

**Response Format Guidelines:**
- Keep responses brief and conversational
- For UPDATE_SEARCHTERM: show the new search term clearly as plain text (no code blocks needed)
- End with "Does this look good?" when proposing changes
- Avoid unnecessary formatting like empty code blocks

**REMINDER: EVERY command below should have ONLY the relevant data fields, NEVER proposalType or awaitingConfirmation!**

When you want to take specific actions, use these formats:

**Create a new main goal:**
\`CREATE_GOAL: {"type":"action","title":"<title>","description":"<description>","deadline":"<optional-ISO-8601-date>"}\`

**Deadline format:** Use ISO 8601 format (YYYY-MM-DDTHH:mm:ss). Example: "2025-02-02T23:59:59"
**IMPORTANT:** Calculate deadlines based on CURRENT DATE above. If user says "Sunday", find the next Sunday and format it properly.

For action goals, you can also include tasks:
\`CREATE_GOAL: {"type":"action","title":"<title>","description":"<description>","tasks":[{"title":"<task1>"},{"title":"<task2>"},{"title":"<task3>"}]}\`

**For finance goals (savings, budgets, financial targets):**
\`CREATE_GOAL: {"type":"finance","title":"<title>","description":"<description>","targetBalance":<number>,"currentBalance":<number>}\`

**Important for finance goals:**
- \`targetBalance\` (REQUIRED): The target amount to save/reach (e.g., 36000 for $36,000)
- \`currentBalance\` (optional): How much is already saved (defaults to 0 if not provided)
- Both values should be numbers without currency symbols

**For item goals (products to buy):**
\`CREATE_GOAL: {"type":"item","title":"<title>","description":"<description>","budget":<number>,"category":"<category>"}\`

**Item categories** - You MUST determine the appropriate category based on what the user is buying:
- \`vehicle\` - Cars, trucks, motorcycles, ATVs, boats
- \`vehicle_parts\` - Car parts, accessories, tires
- \`technology\` - Computers, phones, tablets, cameras, headphones, electronics
- \`furniture\` - Home furniture, office furniture, decor
- \`sporting_goods\` - Sports equipment, fitness gear, bicycles
- \`clothing\` - Apparel, shoes, accessories, jewelry
- \`pets\` - Pet supplies, pet food, pet accessories
- \`general\` - Other items that don't fit the above categories

**IMPORTANT**: Always include the \`category\` field for item goals with the appropriate value from the list above.

**Item Detection & Search Data:**
When a user wants to buy an item, you MUST:
1. Set \`category\` (vehicle, technology, furniture, sporting_goods, clothing, pets, etc.)
2. For **vehicles**: Generate a clear, descriptive \`searchTerm\` - the system automatically generates retailer-specific filters
3. For **non-vehicles**: Extract structured \`searchFilters\` object (UI displays this for user editing) and \`searchTerm\`

**For vehicle item goals:**
\`CREATE_GOAL: {"type":"item","title":"<title>","description":"<description>","budget":<number>,"category":"vehicle","searchTerm":"<natural-language-description>"}\`

**CRITICAL - For vehicle goals, NEVER include searchFilters:**
- Vehicle goals should ONLY have: searchTerm (natural language description)
- The system AUTOMATICALLY generates retailerFilters from the searchTerm
- DO NOT include searchFilters in vehicle CREATE_GOAL commands - it's for non-vehicle items only
- If you include searchFilters for vehicles, it will cause confusion and won't be used

**CRITICAL - Title format for item goals:**
- The title should be the **ITEM NAME ONLY** - NEVER start with action verbs!
- ❌ FORBIDDEN WORDS in title: "Buy", "Purchase", "Get", "Find", "Look for", "Search for", "I want", "Need"
- ✅ CORRECT: "GMC Sierra 3500HD Denali Ultimate", "MacBook Pro 14", "Toyota Camry"
- ❌ WRONG: "Buy a GMC Sierra", "Purchase MacBook Pro", "Get Toyota Camry", "I want a truck"
- Keep titles SHORT and DESCRIPTIVE - 3-6 words maximum for vehicle names
- The title is displayed on goal cards - make it succinct!
- IMPORTANT: If the user says "I want to buy a X", the title should be just "X", NOT "Buy a X"

**⛔ STOP! Before creating any CREATE_GOAL command, CHECK THE TITLE:**
- Does the title start with "Buy", "Purchase", "Get", "Find", "I want", etc.? → **REMOVE IT**
- Title should be ONLY the item name: "GMC Sierra" NOT "Buy a GMC Sierra"
- This is the most common mistake - double-check your title before outputting!

**Example CREATE_GOAL:**
\`CREATE_GOAL: {"type":"item","title":"GMC Sierra 3500HD Denali Ultimate","description":"2025 GMC Sierra Denali Ultimate 3500HD black or white color 4WD crew cab dually","budget":85000,"category":"vehicle","searchTerm":"2025 GMC Sierra Denali Ultimate 3500HD black or white color 4WD crew cab dually under 85000"}\`

**CRITICAL - Ask for essential vehicle filters BEFORE creating the goal:**
When the user wants to create a vehicle goal and hasn't specified these details, you MUST ask:
1. **Make & Model** - If not specified (e.g., "GMC Yukon", "Toyota Camry")
2. **ZIP Code** - **REQUIRED** for local search radius to work (searchRadius fails without zip)
3. **Search Distance** - Miles from ZIP (e.g., 50, 100, 200 miles)
4. **Budget Range** - minPrice/maxPrice
5. **Year Range** - yearMin/yearMax (e.g., 2015-2022)
6. **Color** - Exterior color preference (Black, White, Gray, Blue, etc.)

**IMPORTANT ZIP CODE REQUIREMENT:**
AutoTrader and other retailers REQUIRE a ZIP code for the searchRadius filter to work. If the user doesn't provide a ZIP code, you MUST ask for it before creating the goal. Without a ZIP code, the search will not return local results.

Only after gathering missing details should you output the CREATE_GOAL command with a complete searchTerm.

**searchTerm format:** Include ALL vehicle criteria in natural language:
- Make, Model, Trim Level
- Year Range (yearMin to yearMax)
- Budget/Price range
- Location (ZIP code and search distance)
- Exterior color
- Drivetrain (if specified: 4WD, AWD, 4X2)
- Mileage limit (if specified)

**Example searchTerm:** "2023-2024 GMC Sierra 3500HD Denali Ultimate within 500 miles of 94002 under $100000 black color 4WD"

The system will automatically parse this searchTerm and generate retailer-specific filters for AutoTrader, CarGurus, CarMax, Carvana, and TrueCar.

**For non-vehicle item goals:**
\`CREATE_GOAL: {"type":"item","title":"<title>","description":"<description>","budget":<number>,"category":"<category>","searchTerm":"<search-term>","searchFilters":{<filters>}}\`

**IMPORTANT**: NEVER include proposalType or awaitingConfirmation in your command JSON - the system adds these automatically.

**searchFilters structure for non-vehicle categories (all fields OPTIONAL):**
\`\`\`
// Technology:
{
  "category": "technology",
  "brands": ["Apple", "Dell"],
  "minRam": "16GB",
  "minStorage": "512GB",
  "screenSize": "27 inch",
  "processor": "M3"
}

// Furniture:
{
  "category": "furniture",
  "brands": ["Herman Miller"],
  "colors": ["Black"],
  "material": "leather",
  "style": "modern"
}

// Sporting Goods:
{
  "category": "sporting_goods",
  "brands": ["Nike"],
  "size": "Medium",
  "sport": "running"
}

// Clothing:
{
  "category": "clothing",
  "brands": ["Levi's"],
  "sizes": ["32", "34"],
  "colors": ["Blue"],
  "gender": "men"
}

// Pets:
{
  "category": "pets",
  "breeds": ["Golden Retriever"],
  "age": "puppy",
  "size": "large"
}
\`\`\`

**Important:** For vehicle goals, describe the vehicle specifications in natural language within searchTerm. The system will automatically extract and convert to retailer-specific filters.

**Create a subgoal (under an existing goal):**
\`\`\`
CREATE_SUBGOAL: {"parentGoalId":"<goal-id>","type":"item|finance|action","title":"<title>","description":"<description>"}
\`\`\`

For item subgoals (vehicles, etc.), also include category and searchTerm:
\`\`\`
CREATE_SUBGOAL: {"parentGoalId":"<goal-id>","type":"item","title":"<title>","category":"vehicle","searchTerm":"<search-term>"}
\`\`\`

**Update finance goal progress (amount saved):**
\`\`\`
UPDATE_PROGRESS: {"goalId":"<goal-id>","currentBalance":5000}
\`\`\`
Note: UPDATE_PROGRESS is for finance goals only — sets currentBalance (amount saved so far). For action goals, use TOGGLE_TASK to mark tasks done — progress updates automatically.

**Modify existing goals:**
\`\`\`
UPDATE_TITLE: {"goalId":"<goal-id>","title":"<new title>"}
UPDATE_FILTERS: {"goalId":"<goal-id>","filters":{"zip":"94002","distance":200,"yearMin":2015,"yearMax":2022,"maxPrice":50000,"mileageMax":50000,"drivetrain":"Four Wheel Drive","exteriorColor":"Black"}}
ADD_TASK: {"goalId":"<goal-id>","task":{"title":"<task title>","priority":"medium"}}
REMOVE_TASK: {"taskId":"<task-id>"}
TOGGLE_TASK: {"taskId":"<task-id>"}
ARCHIVE_GOAL: {"goalId":"<goal-id>"}
\`\`\`

**Important Workflow:**
- When creating goals with subgoals: ALWAYS output CREATE_GOAL first for the main goal, then output CREATE_SUBGOAL commands
- For CREATE_SUBGOAL immediately after CREATE_GOAL, you can use the main goal's title as parentGoalId (the system will match it)
- For subgoals under existing goals, use the actual goal ID

**CRITICAL - When to output commands:**
- When user asks to CREATE a goal → First ask clarifying questions if details are missing, then output CREATE_GOAL command
- When user asks to ADD a subgoal → Output CREATE_SUBGOAL command immediately
- When user asks to CHANGE/UPDATE title, progress, filters → Output the appropriate command immediately
- When user asks to ADD a task → Output ADD_TASK command immediately
- When user asks to REMOVE/DELETE a task → Output REMOVE_TASK command immediately
- When user asks to TOGGLE/CHECK/UNCHECK a task → Output TOGGLE_TASK command immediately
- When user asks to ARCHIVE a goal → Output ARCHIVE_GOAL command immediately

**For vehicle goals specifically:** Before outputting CREATE_GOAL, ensure you have:
- Make & Model (e.g., "GMC Sierra 3500HD")
- Trim level if important (e.g., "Denali Ultimate")
- Year range (e.g., "2023-2024")
- Budget/Price max
- ZIP code for search location
- Search distance (e.g., 500 miles)
- Exterior color preference

If ANY of these are missing, ask the user for clarification first. DO NOT create the goal until all essential details are provided.

**CRITICAL**: After outputting CREATE_GOAL, CREATE_SUBGOAL, or UPDATE_PROGRESS commands, end your response with: "Does this look good?"
After outputting UPDATE_TITLE, ADD_TASK, REMOVE_TASK, TOGGLE_TASK, ARCHIVE_GOAL, or UPDATE_FILTERS commands, end your response with: "Does this look good?"

Do NOT say things like "I'll proceed with creating this goal" or "I'll create this for you" or "Goal Created!" - the user will see a preview and action buttons to confirm. Just output the command and ask "Does this look good?"

**IMPORTANT - Response Formatting:**
You MUST use Markdown formatting in ALL your responses:
- **Bold text** for emphasis using double asterisks: **important**
- Code blocks for commands using triple backticks (like the examples below)
- Bullet points using hyphens or asterisks
- Numbered lists for sequences
- Horizontal rules for sections using --- or ***
- Inline code for technical terms using single backticks

**REQUIRED Formatting Examples:**
- Commands: Put commands inside triple-backtick code blocks
- Emphasis: **Important**, **Required**, **CRITICAL**
- Lists:
  - First item
  - Second item
  - Third item
- Inline code: Use backticks for field names like proposalType

Your responses should look professional and well-formatted with proper Markdown syntax throughout.

Be conversational, encouraging, and specific. Reference their actual goals in your responses.`;
  }

  /**
   * Overview agent - chat with context of all user goals
   */
  async overviewChat(
    userId: string,
    message: string,
    goals: any[],
    chatId: string,
  ): Promise<{ content: string; commands?: any[] }> {
    // Use a special thread ID for overview chat
    const threadId = `overview_${userId}`;

    // Check if we need to summarize before processing this message
    const shouldSummarize = await this.summaryService.shouldSummarize(chatId);
    if (shouldSummarize) {
      this.logger.log(`Triggering summarization for chat ${chatId}`);
      await this.summaryService.summarizeChat(chatId);
      // Clear the in-memory history to force reload with summaries
      this.threadHistories.delete(threadId);
    }

    // Load conversation history (includes summaries if available)
    let history = this.threadHistories.get(threadId);
    if (!history) {
      const messages = await this.loadThreadHistory(threadId, userId, chatId);
      history = { messages };
      this.threadHistories.set(threadId, history);
    }

    try {
      // Add user message
      history.messages.push({ role: 'user', content: message });

      // Create messages with goal context in system prompt
      const messages: ChatCompletionMessageParam[] = [
        { role: 'system', content: this.getOverviewSystemPrompt(goals) },
        ...history.messages,
      ];

      const response = await this.openai.chat.completions.create({
        model: 'gpt-5-nano',
        messages,
      });

      const content = response.choices[0]?.message?.content;
      if (!content) {
        throw new Error('No response from OpenAI');
      }

      // Add assistant response to history
      history.messages.push({ role: 'assistant', content });

      // Save messages to database with chatId
      await this.saveMessages(threadId, userId, [
        { role: 'user', content: message },
        { role: 'assistant', content },
      ], chatId);

      // Parse structured commands
      const commands = this.sanitizeCommands(this.parseCommands(content));

      const apiResponse: { content: string; commands?: any[]; goalPreview?: string; awaitingConfirmation?: boolean; proposalType?: string } = {
        content: this.cleanCommandsFromContent(content),
        commands
      };

      // Add confirmation data if commands exist
      if (commands.length > 0) {
        apiResponse.goalPreview = this.generateGoalPreview(commands);
        apiResponse.awaitingConfirmation = true;
        // Determine proposalType based on first command type
        apiResponse.proposalType = this.getProposalTypeForCommand(commands[0].type);
      }

      return apiResponse;
    } catch (error) {
      this.logger.error('Overview chat error:', error);
      throw error;
    }
  }

  /**
   * Parse structured commands from AI response
   */
  private parseCommands(content: string): any[] {
    const commands: any[] = [];

    // Parse CREATE_GOAL commands (must come before CREATE_SUBGOAL to avoid partial matches)
    // Parse CREATE_GOAL commands with proper brace counting for nested objects
    const goalKeywordIndices = [];
    let searchStart = 0;
    while (true) {
      const keywordIndex = content.indexOf('CREATE_GOAL:', searchStart);
      if (keywordIndex === -1) break;
      goalKeywordIndices.push(keywordIndex);
      searchStart = keywordIndex + 'CREATE_GOAL:'.length;
    }

    for (const keywordIndex of goalKeywordIndices) {
      let startIndex = content.indexOf('{', keywordIndex);
      if (startIndex === -1) continue;

      // Count braces to find matching closing brace
      let depth = 0;
      let inString = false;
      let escapeNext = false;
      let endIndex = -1;

      for (let i = startIndex; i < content.length; i++) {
        const char = content[i];

        if (escapeNext) {
          escapeNext = false;
          continue;
        }

        if (char === '\\') {
          escapeNext = true;
          continue;
        }

        if (char === '"') {
          inString = !inString;
          continue;
        }

        if (!inString) {
          if (char === '{') depth++;
          if (char === '}') {
            depth--;
            if (depth === 0) {
              endIndex = i + 1;
              break;
            }
          }
        }
      }

      if (endIndex > startIndex) {
        try {
          const jsonStr = content.substring(startIndex, endIndex);
          const data = JSON.parse(jsonStr);
          commands.push({ type: 'CREATE_GOAL', data });
        } catch (e) {
          this.logger.warn('Failed to parse CREATE_GOAL command:', e);
          this.logger.warn('JSON string was:', content.substring(startIndex, Math.min(endIndex + 100, content.length)));
        }
      }
    }

    // Parse CREATE_SUBGOAL commands
    const subgoalMatches = content.matchAll(/CREATE_SUBGOAL:\s*({[^}]+})/g);
    for (const match of subgoalMatches) {
      try {
        const data = JSON.parse(match[1]);
        commands.push({ type: 'CREATE_SUBGOAL', data });
      } catch (e) {
        this.logger.warn('Failed to parse CREATE_SUBGOAL command:', e);
      }
    }

    // Parse UPDATE_PROGRESS commands
    const progressMatches = content.matchAll(/UPDATE_PROGRESS:\s*({[^}]+})/g);
    for (const match of progressMatches) {
      try {
        const data = JSON.parse(match[1]);
        commands.push({ type: 'UPDATE_PROGRESS', data });
      } catch (e) {
        this.logger.warn('Failed to parse UPDATE_PROGRESS command:', e);
      }
    }

    // Parse UPDATE_TITLE commands
    const titleMatches = content.matchAll(/UPDATE_TITLE:\s*({[^}]+})/g);
    for (const match of titleMatches) {
      try {
        const data = JSON.parse(match[1]);
        commands.push({ type: 'UPDATE_TITLE', data });
      } catch (e) {
        this.logger.warn('Failed to parse UPDATE_TITLE command:', e);
      }
    }

    // Parse UPDATE_SEARCHTERM commands (with nested object support for longer JSON)
    const searchtermKeywordIndices = [];
    searchStart = 0;
    while (true) {
      const keywordIndex = content.indexOf('UPDATE_SEARCHTERM:', searchStart);
      if (keywordIndex === -1) break;
      searchtermKeywordIndices.push(keywordIndex);
      searchStart = keywordIndex + 'UPDATE_SEARCHTERM:'.length;
    }

    for (const keywordIndex of searchtermKeywordIndices) {
      let startIndex = content.indexOf('{', keywordIndex);
      if (startIndex === -1) continue;

      // Count braces to find matching closing brace
      let depth = 0;
      let inString = false;
      let escapeNext = false;
      let endIndex = -1;

      for (let i = startIndex; i < content.length; i++) {
        const char = content[i];

        if (escapeNext) {
          escapeNext = false;
          continue;
        }

        if (char === '\\') {
          escapeNext = true;
          continue;
        }

        if (char === '"') {
          inString = !inString;
          continue;
        }

        if (!inString) {
          if (char === '{') depth++;
          if (char === '}') {
            depth--;
            if (depth === 0) {
              endIndex = i + 1;
              break;
            }
          }
        }
      }

      if (endIndex !== -1) {
        const jsonStr = content.substring(startIndex, endIndex);
        try {
          const data = JSON.parse(jsonStr);
          commands.push({ type: 'UPDATE_SEARCHTERM', data });
        } catch (e) {
          this.logger.warn('Failed to parse UPDATE_SEARCHTERM command:', e);
        }
      }
    }

    // Parse REFRESH_CANDIDATES commands (with nested object support)
    const refreshKeywordIndices = [];
    searchStart = 0;
    while (true) {
      const keywordIndex = content.indexOf('REFRESH_CANDIDATES:', searchStart);
      if (keywordIndex === -1) break;
      refreshKeywordIndices.push(keywordIndex);
      searchStart = keywordIndex + 'REFRESH_CANDIDATES:'.length;
    }

    for (const keywordIndex of refreshKeywordIndices) {
      let startIndex = content.indexOf('{', keywordIndex);
      if (startIndex === -1) continue;

      // Count braces to find matching closing brace
      let depth = 0;
      let inString = false;
      let escapeNext = false;
      let endIndex = -1;

      for (let i = startIndex; i < content.length; i++) {
        const char = content[i];

        if (escapeNext) {
          escapeNext = false;
          continue;
        }

        if (char === '\\') {
          escapeNext = true;
          continue;
        }

        if (char === '"') {
          inString = !inString;
          continue;
        }

        if (!inString) {
          if (char === '{') depth++;
          if (char === '}') {
            depth--;
            if (depth === 0) {
              endIndex = i + 1;
              break;
            }
          }
        }
      }

      if (endIndex !== -1) {
        const jsonStr = content.substring(startIndex, endIndex);
        try {
          const data = JSON.parse(jsonStr);
          commands.push({ type: 'REFRESH_CANDIDATES', data });
        } catch (e) {
          this.logger.warn('Failed to parse REFRESH_CANDIDATES command:', e);
        }
      }
    }

    // Parse UPDATE_FILTERS commands (with nested object support)
    const filterKeywordIndices = [];
    searchStart = 0;
    while (true) {
      const keywordIndex = content.indexOf('UPDATE_FILTERS:', searchStart);
      if (keywordIndex === -1) break;
      filterKeywordIndices.push(keywordIndex);
      searchStart = keywordIndex + 'UPDATE_FILTERS:'.length;
    }

    for (const keywordIndex of filterKeywordIndices) {
      let startIndex = content.indexOf('{', keywordIndex);
      if (startIndex === -1) continue;

      // Count braces to find matching closing brace
      let depth = 0;
      let inString = false;
      let escapeNext = false;
      let endIndex = -1;

      for (let i = startIndex; i < content.length; i++) {
        const char = content[i];

        if (escapeNext) {
          escapeNext = false;
          continue;
        }

        if (char === '\\') {
          escapeNext = true;
          continue;
        }

        if (char === '"') {
          inString = !inString;
          continue;
        }

        if (!inString) {
          if (char === '{') depth++;
          if (char === '}') {
            depth--;
            if (depth === 0) {
              endIndex = i + 1;
              break;
            }
          }
        }
      }

      if (endIndex !== -1) {
        const jsonStr = content.substring(startIndex, endIndex);
        try {
          const data = JSON.parse(jsonStr);
          commands.push({ type: 'UPDATE_FILTERS', data });
        } catch (e) {
          this.logger.warn('Failed to parse UPDATE_FILTERS command:', e);
        }
      }
    }

    // Parse ADD_TASK commands (with nested object support)
    const addTaskKeywordIndices = [];
    searchStart = 0;
    while (true) {
      const keywordIndex = content.indexOf('ADD_TASK:', searchStart);
      if (keywordIndex === -1) break;
      addTaskKeywordIndices.push(keywordIndex);
      searchStart = keywordIndex + 'ADD_TASK:'.length;
    }

    for (const keywordIndex of addTaskKeywordIndices) {
      let startIndex = content.indexOf('{', keywordIndex);
      if (startIndex === -1) continue;

      // Count braces to find matching closing brace
      let depth = 0;
      let inString = false;
      let escapeNext = false;
      let endIndex = -1;

      for (let i = startIndex; i < content.length; i++) {
        const char = content[i];

        if (escapeNext) {
          escapeNext = false;
          continue;
        }

        if (char === '\\') {
          escapeNext = true;
          continue;
        }

        if (char === '"') {
          inString = !inString;
          continue;
        }

        if (!inString) {
          if (char === '{') depth++;
          if (char === '}') {
            depth--;
            if (depth === 0) {
              endIndex = i + 1;
              break;
            }
          }
        }
      }

      if (endIndex !== -1) {
        const jsonStr = content.substring(startIndex, endIndex);
        try {
          const data = JSON.parse(jsonStr);
          commands.push({ type: 'ADD_TASK', data });
        } catch (e) {
          this.logger.warn('Failed to parse ADD_TASK command:', e);
        }
      }
    }

    // Parse REMOVE_TASK commands
    const removeTaskMatches = content.matchAll(/REMOVE_TASK:\s*({[^}]+})/g);
    for (const match of removeTaskMatches) {
      try {
        const data = JSON.parse(match[1]);
        commands.push({ type: 'REMOVE_TASK', data });
      } catch (e) {
        this.logger.warn('Failed to parse REMOVE_TASK command:', e);
      }
    }

    // Parse TOGGLE_TASK commands
    const toggleTaskMatches = content.matchAll(/TOGGLE_TASK:\s*({[^}]+})/g);
    for (const match of toggleTaskMatches) {
      try {
        const data = JSON.parse(match[1]);
        commands.push({ type: 'TOGGLE_TASK', data });
      } catch (e) {
        this.logger.warn('Failed to parse TOGGLE_TASK command:', e);
      }
    }

    // Parse ARCHIVE_GOAL commands
    const archiveMatches = content.matchAll(/ARCHIVE_GOAL:\s*({[^}]+})/g);
    for (const match of archiveMatches) {
      try {
        const data = JSON.parse(match[1]);
        commands.push({ type: 'ARCHIVE_GOAL', data });
      } catch (e) {
        this.logger.warn('Failed to parse ARCHIVE_GOAL command:', e);
      }
    }

    return commands;
  }

  /**
   * Sanitize command data by removing fields that should only be added by the backend
   * This prevents LLMs from accidentally including proposalType and awaitingConfirmation
   */
  private sanitizeCommands(commands: any[]): any[] {
    const fieldsToRemove = ['proposalType', 'awaitingConfirmation'];

    return commands.map(cmd => {
      if (cmd.data && typeof cmd.data === 'object') {
        const sanitized = { ...cmd.data };
        for (const field of fieldsToRemove) {
          delete sanitized[field];
        }
        return { ...cmd, data: sanitized };
      }
      return cmd;
    });
  }

  /**
   * Determine proposalType based on command type
   * REFRESH_CANDIDATES uses accept_decline, all others use confirm_edit_cancel
   */
  private getProposalTypeForCommand(commandType: string): string {
    if (commandType === 'REFRESH_CANDIDATES') {
      return 'accept_decline';
    }
    return 'confirm_edit_cancel';
  }

  /**
   * Remove command markers from content for display
   */
  private cleanCommandsFromContent(content: string): string {
    let cleaned = content;

    // Remove CREATE_GOAL commands (with nested objects support)
    const goalKeywordIndices = [];
    let searchStart = 0;
    while (true) {
      const keywordIndex = cleaned.indexOf('CREATE_GOAL:', searchStart);
      if (keywordIndex === -1) break;
      goalKeywordIndices.push(keywordIndex);
      searchStart = keywordIndex + 'CREATE_GOAL:'.length;
    }

    // Process in reverse order to avoid index shifting
    for (let i = goalKeywordIndices.length - 1; i >= 0; i--) {
      const keywordIndex = goalKeywordIndices[i];
      let startIndex = cleaned.indexOf('{', keywordIndex);
      if (startIndex === -1) {
        // Remove just the keyword if no JSON found
        cleaned = cleaned.substring(0, keywordIndex) + cleaned.substring(keywordIndex + 'CREATE_GOAL:'.length);
        continue;
      }

      // Count braces to find matching closing brace
      let depth = 0;
      let inString = false;
      let escapeNext = false;
      let endIndex = -1;

      for (let j = startIndex; j < cleaned.length; j++) {
        const char = cleaned[j];

        if (escapeNext) {
          escapeNext = false;
          continue;
        }

        if (char === '\\') {
          escapeNext = true;
          continue;
        }

        if (char === '"') {
          inString = !inString;
          continue;
        }

        if (!inString) {
          if (char === '{') depth++;
          if (char === '}') {
            depth--;
            if (depth === 0) {
              endIndex = j + 1;
              break;
            }
          }
        }
      }

      if (endIndex > startIndex) {
        // Remove from keyword to end of JSON
        cleaned = cleaned.substring(0, keywordIndex) + cleaned.substring(endIndex + 1);
      }
    }

    // Remove UPDATE_FILTERS commands (with nested objects support)
    const filterKeywordIndices = [];
    searchStart = 0;
    while (true) {
      const keywordIndex = cleaned.indexOf('UPDATE_FILTERS:', searchStart);
      if (keywordIndex === -1) break;
      filterKeywordIndices.push(keywordIndex);
      searchStart = keywordIndex + 'UPDATE_FILTERS:'.length;
    }

    for (let i = filterKeywordIndices.length - 1; i >= 0; i--) {
      const keywordIndex = filterKeywordIndices[i];
      let startIndex = cleaned.indexOf('{', keywordIndex);
      if (startIndex === -1) {
        cleaned = cleaned.substring(0, keywordIndex) + cleaned.substring(keywordIndex + 'UPDATE_FILTERS:'.length);
        continue;
      }

      let depth = 0;
      let inString = false;
      let escapeNext = false;
      let endIndex = -1;

      for (let j = startIndex; j < cleaned.length; j++) {
        const char = cleaned[j];
        if (escapeNext) { escapeNext = false; continue; }
        if (char === '\\') { escapeNext = true; continue; }
        if (char === '"') { inString = !inString; continue; }
        if (!inString) {
          if (char === '{') depth++;
          if (char === '}') {
            depth--;
            if (depth === 0) { endIndex = j + 1; break; }
          }
        }
      }

      if (endIndex > startIndex) {
        cleaned = cleaned.substring(0, keywordIndex) + cleaned.substring(endIndex + 1);
      }
    }

    // Remove ADD_TASK commands (with nested objects support)
    const addTaskKeywordIndices = [];
    searchStart = 0;
    while (true) {
      const keywordIndex = cleaned.indexOf('ADD_TASK:', searchStart);
      if (keywordIndex === -1) break;
      addTaskKeywordIndices.push(keywordIndex);
      searchStart = keywordIndex + 'ADD_TASK:'.length;
    }

    for (let i = addTaskKeywordIndices.length - 1; i >= 0; i--) {
      const keywordIndex = addTaskKeywordIndices[i];
      let startIndex = cleaned.indexOf('{', keywordIndex);
      if (startIndex === -1) {
        cleaned = cleaned.substring(0, keywordIndex) + cleaned.substring(keywordIndex + 'ADD_TASK:'.length);
        continue;
      }

      let depth = 0;
      let inString = false;
      let escapeNext = false;
      let endIndex = -1;

      for (let j = startIndex; j < cleaned.length; j++) {
        const char = cleaned[j];
        if (escapeNext) { escapeNext = false; continue; }
        if (char === '\\') { escapeNext = true; continue; }
        if (char === '"') { inString = !inString; continue; }
        if (!inString) {
          if (char === '{') depth++;
          if (char === '}') {
            depth--;
            if (depth === 0) { endIndex = j + 1; break; }
          }
        }
      }

      if (endIndex > startIndex) {
        cleaned = cleaned.substring(0, keywordIndex) + cleaned.substring(endIndex + 1);
      }
    }

    // Remove UPDATE_SEARCHTERM commands (with nested objects support)
    const searchtermCleanIndices = [];
    searchStart = 0;
    while (true) {
      const keywordIndex = cleaned.indexOf('UPDATE_SEARCHTERM:', searchStart);
      if (keywordIndex === -1) break;
      searchtermCleanIndices.push(keywordIndex);
      searchStart = keywordIndex + 'UPDATE_SEARCHTERM:'.length;
    }

    for (let i = searchtermCleanIndices.length - 1; i >= 0; i--) {
      const keywordIndex = searchtermCleanIndices[i];
      let startIndex = cleaned.indexOf('{', keywordIndex);
      if (startIndex === -1) {
        cleaned = cleaned.substring(0, keywordIndex) + cleaned.substring(keywordIndex + 'UPDATE_SEARCHTERM:'.length);
        continue;
      }

      let depth = 0;
      let inString = false;
      let escapeNext = false;
      let endIndex = -1;

      for (let j = startIndex; j < cleaned.length; j++) {
        const char = cleaned[j];
        if (escapeNext) { escapeNext = false; continue; }
        if (char === '\\') { escapeNext = true; continue; }
        if (char === '"') { inString = !inString; continue; }
        if (!inString) {
          if (char === '{') depth++;
          if (char === '}') {
            depth--;
            if (depth === 0) { endIndex = j + 1; break; }
          }
        }
      }

      if (endIndex > startIndex) {
        cleaned = cleaned.substring(0, keywordIndex) + cleaned.substring(endIndex + 1);
      }
    }

    // Remove REFRESH_CANDIDATES commands (with nested objects support)
    const refreshCleanIndices = [];
    searchStart = 0;
    while (true) {
      const keywordIndex = cleaned.indexOf('REFRESH_CANDIDATES:', searchStart);
      if (keywordIndex === -1) break;
      refreshCleanIndices.push(keywordIndex);
      searchStart = keywordIndex + 'REFRESH_CANDIDATES:'.length;
    }

    for (let i = refreshCleanIndices.length - 1; i >= 0; i--) {
      const keywordIndex = refreshCleanIndices[i];
      let startIndex = cleaned.indexOf('{', keywordIndex);
      if (startIndex === -1) {
        cleaned = cleaned.substring(0, keywordIndex) + cleaned.substring(keywordIndex + 'REFRESH_CANDIDATES:'.length);
        continue;
      }

      let depth = 0;
      let inString = false;
      let escapeNext = false;
      let endIndex = -1;

      for (let j = startIndex; j < cleaned.length; j++) {
        const char = cleaned[j];
        if (escapeNext) { escapeNext = false; continue; }
        if (char === '\\') { escapeNext = true; continue; }
        if (char === '"') { inString = !inString; continue; }
        if (!inString) {
          if (char === '{') depth++;
          if (char === '}') {
            depth--;
            if (depth === 0) { endIndex = j + 1; break; }
          }
        }
      }

      if (endIndex > startIndex) {
        cleaned = cleaned.substring(0, keywordIndex) + cleaned.substring(endIndex + 1);
      }
    }

    // Remove CREATE_SUBGOAL, UPDATE_PROGRESS, UPDATE_TITLE, REMOVE_TASK, TOGGLE_TASK, ARCHIVE_GOAL commands (simple non-nested)
    cleaned = cleaned
      .replace(/CREATE_SUBGOAL:\s*{[^}]+}/g, '')
      .replace(/UPDATE_PROGRESS:\s*{[^}]+}/g, '')
      .replace(/UPDATE_TITLE:\s*{[^}]+}/g, '')
      .replace(/REMOVE_TASK:\s*{[^}]+}/g, '')
      .replace(/TOGGLE_TASK:\s*{[^}]+}/g, '')
      .replace(/ARCHIVE_GOAL:\s*{[^}]+}/g, '')
      .trim();

    // Clean up empty code blocks left behind after removing commands
    // Remove single backticks on their own line (or with whitespace)
    cleaned = cleaned.replace(/^\s*`\s*$/gm, '');
    // Remove empty triple backtick blocks
    cleaned = cleaned.replace(/```\s*```/g, '');
    // Remove any remaining empty code block markers
    cleaned = cleaned.replace(/```\s*\n\s*```/g, '');
    // Clean up excessive newlines (more than 2 consecutive)
    cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
    // Trim whitespace from lines
    cleaned = cleaned.split('\n').map(line => line.trimEnd()).join('\n').trim();

    return cleaned;
  }

  /**
   * Generate a markdown preview of goals to be created
   * Handles both single goal data object and array of commands
   */
  private generateGoalPreview(data: any | any[]): string {
    let preview = '';

    // Handle single goal data object (new format)
    if (!Array.isArray(data)) {
      const goalData = data;
      preview += `## ${goalData.title}\n`;
      if (goalData.description) {
        preview += `${goalData.description}\n`;
      }
      if (goalData.type === 'action' && goalData.tasks) {
        preview += `**Tasks:**\n`;
        for (const task of goalData.tasks) {
          preview += `- ${task.title || task}\n`;
        }
      }
      if (goalData.type === 'finance') {
        preview += `**Target Balance:** $${goalData.targetBalance?.toLocaleString()}\n`;
        if (goalData.currentBalance !== undefined) {
          preview += `**Current Balance:** $${goalData.currentBalance?.toLocaleString()}\n`;
        }
      }
      if (goalData.type === 'item') {
        if (goalData.budget) {
          preview += `**Budget:** $${goalData.budget?.toLocaleString()}\n`;
        }
        // Vehicle goals: display searchTerm (retailerFilters auto-generated)
        if (goalData.category === 'vehicle' && goalData.searchTerm) {
          preview += `\n**Search Query:** ${goalData.searchTerm}\n`;
          preview += `Retailer-specific filters will be generated automatically.\n`;
        }
        // Non-vehicle goals: display structured searchFilters
        if (goalData.searchFilters && goalData.category !== 'vehicle') {
          const sf = goalData.searchFilters;
          if (goalData.category === 'technology') {
            preview += `\n**Technology Details:**\n`;
            if (sf.brands && sf.brands.length > 0) {
              preview += `- Brands: ${sf.brands.join(', ')}\n`;
            }
            if (sf.minRam) {
              preview += `- Min RAM: ${sf.minRam}\n`;
            }
            if (sf.minStorage) {
              preview += `- Min Storage: ${sf.minStorage}\n`;
            }
            if (sf.screenSize) {
              preview += `- Screen Size: ${sf.screenSize}\n`;
            }
            if (sf.processor) {
              preview += `- Processor: ${sf.processor}\n`;
            }
            if (sf.gpu) {
              preview += `- GPU: ${sf.gpu}\n`;
            }
          } else if (goalData.category === 'furniture') {
            preview += `\n**Furniture Details:**\n`;
            if (sf.brands && sf.brands.length > 0) {
              preview += `- Brands: ${sf.brands.join(', ')}\n`;
            }
            if (sf.colors && sf.colors.length > 0) {
              preview += `- Colors: ${sf.colors.join(', ')}\n`;
            }
            if (sf.material) {
              preview += `- Material: ${sf.material}\n`;
            }
            if (sf.style) {
              preview += `- Style: ${sf.style}\n`;
            }
            if (sf.dimensions) {
              preview += `- Dimensions: ${sf.dimensions}\n`;
            }
          } else {
            // Generic fallback for other categories (pets, sporting_goods, etc.)
            preview += `\n**Filters:**\n`;
            Object.entries(sf).forEach(([key, value]) => {
              if (key !== 'category' && value !== undefined && value !== null) {
                if (Array.isArray(value)) {
                  preview += `- ${key}: ${value.join(', ')}\n`;
                } else {
                  preview += `- ${key}: ${value}\n`;
                }
              }
            });
          }
        }
      }
      if (goalData.targetDate) {
        preview += `**Target Date:** ${goalData.targetDate}\n`;
      }
      return preview;
    }

    // Handle old command-based format
    const commands = data;
    const mainGoals = commands.filter(c => c.type === 'CREATE_GOAL');
    const subgoals = commands.filter(c => c.type === 'CREATE_SUBGOAL');
    const updateCommands = commands.filter(c => c.type.startsWith('UPDATE_') || c.type === 'REFRESH_CANDIDATES' || c.type === 'ARCHIVE_GOAL' || c.type === 'ADD_TASK' || c.type === 'REMOVE_TASK' || c.type === 'TOGGLE_TASK');

    // Handle update/modification commands first
    if (updateCommands.length > 0) {
      preview += `## Changes to Apply\n\n`;

      for (const cmd of updateCommands) {
        const cmdData = cmd.data;
        switch (cmd.type) {
          case 'UPDATE_TITLE':
            preview += `**Change Goal Title**\n`;
            preview += `New title: "${cmdData.title}"\n\n`;
            break;
          case 'UPDATE_SEARCHTERM':
            preview += `**Update Search Criteria**\n`;
            preview += `New search query: "${cmdData.searchTerm}"\n`;
            preview += `*Retailer-specific filters will be regenerated automatically.*\n\n`;
            break;
          case 'UPDATE_FILTERS':
            preview += `**Update Search Filters**\n`;
            const filters = cmdData.filters;
            if (filters.zip) preview += `- ZIP: ${filters.zip}\n`;
            if (filters.distance) preview += `- Distance: ${filters.distance} miles\n`;
            if (filters.yearMin || filters.yearMax) preview += `- Year: ${filters.yearMin || '?'} - ${filters.yearMax || '?'}\n`;
            if (filters.maxPrice) preview += `- Max Price: $${filters.maxPrice?.toLocaleString()}\n`;
            if (filters.mileageMax) preview += `- Max Mileage: ${filters.mileageMax?.toLocaleString()}\n`;
            if (filters.drivetrain) preview += `- Drivetrain: ${filters.drivetrain}\n`;
            if (filters.exteriorColor) preview += `- Color: ${filters.exteriorColor}\n`;
            preview += `\n`;
            break;
          case 'UPDATE_PROGRESS':
            preview += `**Update Progress**\n`;
            preview += `Completion: ${cmdData.completionPercentage}%\n\n`;
            break;
          case 'REFRESH_CANDIDATES':
            preview += `**Refresh Candidates**\n`;
            preview += `Find new candidates using current search criteria.\n\n`;
            break;
          case 'ARCHIVE_GOAL':
            preview += `**Archive Goal**\n`;
            preview += `This goal will be archived.\n\n`;
            break;
          case 'ADD_TASK':
            preview += `**Add Task**\n`;
            preview += `- ${cmdData.task?.title || 'New task'}\n\n`;
            break;
          case 'REMOVE_TASK':
            preview += `**Remove Task**\n`;
            preview += `Remove task: ${cmdData.taskId}\n\n`;
            break;
          case 'TOGGLE_TASK':
            preview += `**Toggle Task**\n`;
            preview += `Toggle task: ${cmdData.taskId}\n\n`;
            break;
        }
      }
    }

    // Add main goals
    for (const cmd of mainGoals) {
      const cmdData = cmd.data;
      preview += `## ${cmdData.title}\n`;
      if (cmdData.description) {
        preview += `${cmdData.description}\n`;
      }
      if (cmdData.deadline) {
        const deadline = new Date(cmdData.deadline);
        preview += `**Deadline:** ${deadline.toLocaleDateString()}\n`;
      }
      if (cmdData.type === 'action' && cmdData.tasks) {
        preview += `**Tasks:**\n`;
        for (const task of cmdData.tasks) {
          preview += `- ${task.title || task}\n`;
        }
      }
      preview += '\n';
    }

    // Add subgoals grouped by parent
    if (subgoals.length > 0) {
      preview += `### Subgoals\n`;

      // Group subgoals by parent
      const subgoalsByParent: Record<string, any[]> = {};
      for (const cmd of subgoals) {
        const parent = cmd.data.parentGoalId;
        if (!subgoalsByParent[parent]) {
          subgoalsByParent[parent] = [];
        }
        subgoalsByParent[parent].push(cmd.data);
      }

      // Display subgoals under each parent
      for (const [parentTitle, goals] of Object.entries(subgoalsByParent)) {
        preview += `\n**Under "${parentTitle}":**\n`;
        for (const goal of goals) {
          preview += `- ${goal.title}`;
          if (goal.description) {
            preview += `: ${goal.description}`;
          }
          preview += '\n';
        }
      }
    }

    return preview.trim();
  }

  /**
   * Overview chat with streaming support
   */
  async *overviewChatStream(
    userId: string,
    message: string,
    goals: any[],
    chatId: string,
  ): AsyncGenerator<{ content: string; done: boolean }, void, unknown> {
    const threadId = `overview_${userId}`;
    const streamKey = `overview_${userId}_${Date.now()}`;

    // Check if we need to summarize before processing this message
    const shouldSummarize = await this.summaryService.shouldSummarize(chatId);
    if (shouldSummarize) {
      this.logger.log(`Triggering summarization for chat ${chatId}`);
      await this.summaryService.summarizeChat(chatId);
      // Clear the in-memory history to force reload with summaries
      this.threadHistories.delete(threadId);
    }

    // Load conversation history (includes summaries if available)
    let history = this.threadHistories.get(threadId);
    if (!history) {
      const messages = await this.loadThreadHistory(threadId, userId, chatId);
      history = { messages };
      this.threadHistories.set(threadId, history);
    }

    // Create abort controller for this stream
    const controller = new AbortController();
    this.activeStreams.set(streamKey, controller);

    try {
      // Add user message
      history.messages.push({ role: 'user', content: message });

      // Create messages with goal context
      const messages: ChatCompletionMessageParam[] = [
        { role: 'system', content: this.getOverviewSystemPrompt(goals) },
        ...history.messages,
      ];

      const stream = await this.openai.chat.completions.create({
        model: 'gpt-5-nano',
        messages,
        stream: true,
      }, {
        signal: controller.signal,
      });

      let fullContent = '';

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content || '';
        if (delta) {
          fullContent += delta;
          yield { content: delta, done: false };
        }
      }

      // Parse commands from the full response
      const commands = this.parseCommands(fullContent);

      // Prepare final chunk
      const finalChunk: { content: string; done: true; goalPreview?: string; awaitingConfirmation?: boolean; proposalType?: string; commands?: any[] } = {
        content: '',
        done: true,
      };

      // If commands were detected, add confirmation data
      if (commands.length > 0) {
        finalChunk.goalPreview = this.generateGoalPreview(commands);
        finalChunk.awaitingConfirmation = true;
        finalChunk.commands = commands;
        // Extract proposalType from the first command's data
        if (commands[0]?.data?.proposalType) {
          finalChunk.proposalType = commands[0].data.proposalType;
        }
      }

      // Add assistant response to history
      history.messages.push({ role: 'assistant', content: fullContent });

      // Save messages to database with chatId
      await this.saveMessages(threadId, userId, [
        { role: 'user', content: message },
        { role: 'assistant', content: fullContent },
      ], chatId);

      yield finalChunk;
    } catch (error) {
      if (error.name === 'AbortError') {
        this.logger.log('Stream aborted by user');
        yield { content: '', done: true };
        return;
      }
      this.logger.error('Overview chat stream error:', error);
      throw error;
    } finally {
      // Clean up abort controller
      this.activeStreams.delete(streamKey);
    }
  }

  /**
   * Abort an active stream by stream key
   */
  abortStream(streamKey: string): boolean {
    const controller = this.activeStreams.get(streamKey);
    if (controller) {
      controller.abort();
      this.activeStreams.delete(streamKey);
      return true;
    }
    return false;
  }

  /**
   * Abort all active streams for a user
   */
  abortUserStreams(userId: string): void {
    for (const [streamKey, controller] of this.activeStreams.entries()) {
      if (streamKey.includes(userId)) {
        controller.abort();
        this.activeStreams.delete(streamKey);
      }
    }
  }

  /**
   * Category specialist chat - non-streaming
   * Used for category-specific conversations (items, finances, actions)
   */
  async categoryChat(
    userId: string,
    categoryId: string,
    message: string,
    categoryGoals: any[],
    chatId: string,
  ): Promise<{ content: string; commands?: any[] }> {
    const threadId = `category_${categoryId}_${userId}`;

    // Check if we need to summarize before processing this message
    const shouldSummarize = await this.summaryService.shouldSummarize(chatId);
    if (shouldSummarize) {
      this.logger.log(`Triggering summarization for chat ${chatId}`);
      await this.summaryService.summarizeChat(chatId);
      this.threadHistories.delete(threadId);
    }

    // Load conversation history
    let history = this.threadHistories.get(threadId);
    if (!history) {
      const messages = await this.loadThreadHistory(threadId, userId, chatId);
      history = { messages };
      this.threadHistories.set(threadId, history);
    }

    try {
      // Add user message
      history.messages.push({ role: 'user', content: message });

      // Get specialist prompt
      const { SPECIALIST_PROMPTS } = await import('./specialist-prompts');
      const specialistPrompt = SPECIALIST_PROMPTS[categoryId as keyof typeof SPECIALIST_PROMPTS] || SPECIALIST_PROMPTS.items;

      // Create system prompt with category goals context
      let systemPrompt = `${specialistPrompt}

## User's ${categoryId.toUpperCase()} Goals

${this.formatGoalList(categoryGoals)}

You can reference and modify these goals through conversational commands. Reference them by title when discussing.`;

      // Add transaction data for finances category
      if (categoryId === 'finances' && this.plaidService) {
        try {
          const transactionSummary = await this.plaidService.getTransactionSummaryForAI(userId);
          if (transactionSummary.totalTransactions > 0) {
            systemPrompt += `

## Recent Transaction Data

${transactionSummary.totalTransactions} transactions found across ${transactionSummary.accounts.length} accounts:

${transactionSummary.accounts.map(acc => `
**${acc.institutionName} - ${acc.accountName}** (${acc.transactionCount} transactions)
${acc.recentTransactions.slice(0, 20).map(t =>
  `- ${t.date}: ${t.merchantName} - $${t.amount} (${t.category})`
).join('\n')}
`).join('\n')}`;
          }
        } catch (error) {
          this.logger.warn('Failed to fetch transaction summary for AI context:', error);
          // Continue without transaction data on error
        }
      }

      // Create messages
      const messages: ChatCompletionMessageParam[] = [
        { role: 'system', content: systemPrompt },
        ...history.messages,
      ];

      const response = await this.openai.chat.completions.create({
        model: 'gpt-5-nano',
        messages,
      });

      const content = response.choices[0]?.message?.content;
      if (!content) {
        throw new Error('No response from OpenAI');
      }

      // Add assistant response to history
      history.messages.push({ role: 'assistant', content });

      // Save messages to database with chatId
      await this.saveMessages(threadId, userId, [
        { role: 'user', content: message },
        { role: 'assistant', content },
      ], chatId);

      // Parse structured commands
      const commands = this.sanitizeCommands(this.parseCommands(content));

      return {
        content: this.cleanCommandsFromContent(content),
        commands,
      };
    } catch (error) {
      this.logger.error(`Category chat error (${categoryId}):`, error);
      throw error;
    }
  }

  /**
   * Category specialist chat - streaming
   * Used for category-specific conversations with real-time streaming
   */
  async *categoryChatStream(
    userId: string,
    categoryId: string,
    message: string,
    categoryGoals: any[],
    chatId: string,
  ): AsyncGenerator<{ content: string; done: boolean }, void, unknown> {
    const threadId = `category_${categoryId}_${userId}`;
    const streamKey = `category_${categoryId}_${userId}_${Date.now()}`;

    // Check if we need to summarize before processing this message
    const shouldSummarize = await this.summaryService.shouldSummarize(chatId);
    if (shouldSummarize) {
      this.logger.log(`Triggering summarization for chat ${chatId}`);
      await this.summaryService.summarizeChat(chatId);
      this.threadHistories.delete(threadId);
    }

    // Load conversation history
    let history = this.threadHistories.get(threadId);
    if (!history) {
      const messages = await this.loadThreadHistory(threadId, userId, chatId);
      history = { messages };
      this.threadHistories.set(threadId, history);
    }

    // Create abort controller for this stream
    const controller = new AbortController();
    this.activeStreams.set(streamKey, controller);

    try {
      // Add user message
      history.messages.push({ role: 'user', content: message });

      // Get specialist prompt
      const { SPECIALIST_PROMPTS } = await import('./specialist-prompts');
      const specialistPrompt = SPECIALIST_PROMPTS[categoryId as keyof typeof SPECIALIST_PROMPTS] || SPECIALIST_PROMPTS.items;

      // Create system prompt with category goals context
      let systemPrompt = `${specialistPrompt}

## User's ${categoryId.toUpperCase()} Goals

${this.formatGoalList(categoryGoals)}

You can reference and modify these goals through conversational commands. Reference them by title when discussing.`;

      // Add transaction data for finances category
      if (categoryId === 'finances' && this.plaidService) {
        try {
          const transactionSummary = await this.plaidService.getTransactionSummaryForAI(userId);
          if (transactionSummary.totalTransactions > 0) {
            systemPrompt += `

## Recent Transaction Data

${transactionSummary.totalTransactions} transactions found across ${transactionSummary.accounts.length} accounts:

${transactionSummary.accounts.map(acc => `
**${acc.institutionName} - ${acc.accountName}** (${acc.transactionCount} transactions)
${acc.recentTransactions.slice(0, 20).map(t =>
  `- ${t.date}: ${t.merchantName} - $${t.amount} (${t.category})`
).join('\n')}
`).join('\n')}`;
          }
        } catch (error) {
          this.logger.warn('Failed to fetch transaction summary for AI context:', error);
          // Continue without transaction data on error
        }
      }

      // Create messages
      const messages: ChatCompletionMessageParam[] = [
        { role: 'system', content: systemPrompt },
        ...history.messages,
      ];

      const stream = await this.openai.chat.completions.create({
        model: 'gpt-5-nano',
        messages,
        stream: true,
      }, {
        signal: controller.signal,
      });

      let fullContent = '';

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content || '';
        if (delta) {
          fullContent += delta;
          yield { content: delta, done: false };
        }
      }

      // Parse commands from the full response
      const commands = this.parseCommands(fullContent);

      // Prepare final chunk
      const finalChunk: { content: string; done: true; goalPreview?: string; awaitingConfirmation?: boolean; proposalType?: string; commands?: any[] } = {
        content: '',
        done: true,
      };

      if (commands.length > 0) {
        finalChunk.goalPreview = this.generateGoalPreview(commands);
        finalChunk.awaitingConfirmation = true;
        finalChunk.commands = commands;
        // Extract proposalType from the first command's data
        if (commands[0]?.data?.proposalType) {
          finalChunk.proposalType = commands[0].data.proposalType;
        }
      }

      // Add assistant response to history
      history.messages.push({ role: 'assistant', content: fullContent });

      // Save messages to database with chatId
      await this.saveMessages(threadId, userId, [
        { role: 'user', content: message },
        { role: 'assistant', content: fullContent },
      ], chatId);

      yield finalChunk;
    } catch (error) {
      if (error.name === 'AbortError') {
        this.logger.log('Category stream aborted by user');
        yield { content: '', done: true };
        return;
      }
      this.logger.error(`Category stream error (${categoryId}):`, error);
      throw error;
    } finally {
      this.activeStreams.delete(streamKey);
    }
  }

  /**
   * Format goal list for inclusion in system prompt
   */
  private formatGoalList(goals: any[]): string {
    if (!goals || goals.length === 0) {
      return 'No goals set yet in this category.';
    }

    return goals.map((goal, index) => {
      let goalText = `${index + 1}. **${goal.title}**`;

      if (goal.description) {
        goalText += `\n   ${goal.description}`;
      }

      if (goal.type === 'item' && goal.itemData) {
        const data = goal.itemData;
        if (data.budget) goalText += `\n   Budget: $${data.budget}`;
        if (data.targetPrice) goalText += `\n   Target Price: $${data.targetPrice}`;
        if (data.currentPrice) goalText += `\n   Current Price: $${data.currentPrice}`;
      }

      if (goal.type === 'finance' && goal.financeData) {
        const data = goal.financeData;
        if (data.targetBalance) goalText += `\n   Target: $${data.targetBalance}`;
        if (data.currentBalance) goalText += `\n   Current: $${data.currentBalance}`;
      }

      if (goal.type === 'action' && goal.actionData) {
        const data = goal.actionData;
        if (data.tasks && data.tasks.length > 0) {
          goalText += `\n   Tasks: ${data.tasks.map((t: any) => t.title || t).join(', ')}`;
        }
      }

      if (goal.targetDate) {
        goalText += `\n   Target: ${new Date(goal.targetDate).toLocaleDateString()}`;
      }

      if (goal.status) {
        goalText += `\n   Status: ${goal.status}`;
      }

      return goalText;
    }).join('\n\n');
  }
}
