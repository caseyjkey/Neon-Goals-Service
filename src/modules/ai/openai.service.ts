import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../config/prisma.service';
import OpenAI from 'openai';
import { ChatCompletionMessageParam } from 'openai/resources';

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

  constructor(
    private configService: ConfigService,
    private prisma: PrismaService,
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
   */
  private async loadThreadHistory(threadId: string, userId: string): Promise<ChatCompletionMessageParam[]> {
    // Check in-memory cache first
    const cached = this.threadHistories.get(threadId);
    if (cached) {
      return cached.messages;
    }

    // Load from database
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
   */
  private async saveMessages(
    threadId: string,
    userId: string,
    messages: Array<{ role: string; content: string }>,
  ): Promise<void> {
    await this.prisma.message.createMany({
      data: messages.map(msg => ({
        threadId,
        userId,
        role: msg.role,
        content: msg.content,
      })),
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

3. **Collect Multiple Preferences**: Users can specify multiple options:
   - Multiple trims: "I'm open to either Denali or Denali Ultimate"
   - Multiple colors: "Black, White, or Silver would work"
   - Store these as ARRAYS in the searchFilters

4. **Output Format for Vehicle Goals**:
\`\`\`
EXTRACT_DATA: {"goalType":"item","title":"2025 GMC Sierra Denali 3500HD","budget":85000,"category":"vehicle","searchTerm":"2025 GMC Sierra Denali 3500HD dually","searchFilters":{"category":"vehicle","make":"GMC","model":"Sierra","year":2025,"trims":["Denali","Denali Ultimate"],"series":"3500HD","colors":["Black","White"],"bodyStyle":"Crew Cab","drivetrain":"4WD"}}
\`\`\`

5. **Extract When Complete**: Once you have make, model, year, and budget, you MUST ask about trims, colors, body style, and drivetrain BEFORE extracting. Only output EXTRACT_DATA after you have collected these preferences from the user. Do NOT extract immediately after getting just make/model/year/budget - the configuration preferences are required.

## Required Fields by Goal Type

**Item Goals**: \`title\` (product name), \`budget\` (number), \`category\` (one of: vehicle, vehicle_parts, technology, furniture, sporting_goods, clothing, pets, general), optionally \`targetDate\` (string)
- The \`category\` field is REQUIRED for all item goals - choose the appropriate category based on what type of product it is

**Item Goals**: In addition to the fields above, item goals may include:
- \`searchTerm\` (optimized search query for listing sites)
- \`searchFilters\` (JSON with category-specific preferences - UI displays this for editing)
  - Vehicles: { category, make, model, year, trims (array), series, colors (array), bodyStyle, drivetrain, fuelType, transmission }
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

Item Goal (Vehicle - includes searchTerm and searchFilters):
\`\`\`
EXTRACT_DATA: {"goalType":"item","title":"2025 GMC Sierra Denali 3500HD","budget":85000,"category":"vehicle","searchTerm":"2025 GMC Sierra Denali 3500HD dually","searchFilters":{"category":"vehicle","make":"GMC","model":"Sierra","year":2025,"trims":["Denali"],"series":"3500HD"}}
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
        model: 'gpt-4o-mini',
        messages,
        temperature: 0.7,
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
  ): Promise<{ content: string; commands?: any[] }> {
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
        model: 'gpt-4o-mini',
        messages,
        temperature: 0.7,
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
      const commands = this.parseCommands(content);

      return {
        content: this.cleanCommandsFromContent(content),
        commands
      };
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

When you want to take specific actions, use these formats:

**Create a new main goal:**
\`\`\`
CREATE_GOAL: {"type":"action","title":"<title>","description":"<description>","deadline":"<optional-ISO-8601-date>"}
\`\`\`

**Deadline format:** Use ISO 8601 format (YYYY-MM-DDTHH:mm:ss). Example: "2025-02-02T23:59:59"
**IMPORTANT:** Calculate deadlines based on CURRENT DATE above. If user says "Sunday", find the next Sunday and format it properly.

For action goals, you can also include tasks:
\`\`\`
CREATE_GOAL: {"type":"action","title":"<title>","description":"<description>","tasks":[{"title":"<task1>"},{"title":"<task2>"},{"title":"<task3>"}]}
\`\`\`

**For item goals (products to buy):**
\`\`\`
CREATE_GOAL: {"type":"item","title":"<title>","description":"<description>","budget":<number>,"category":"<category>"}
\`\`\`

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

**Item Detection & Structured Search Data:**
When a user wants to buy an item, you MUST:
1. Set \`category\` (vehicle, technology, furniture, sporting_goods, clothing, pets, etc.)
2. Extract details into a structured \`searchFilters\` object (UI displays this for user editing)
3. Also generate an optimized \`searchTerm\` for listing sites

**For item goals, use the searchFilters object:**
\`\`\`
CREATE_GOAL: {"type":"item","title":"<title>","description":"<description>","budget":<number>,"category":"<category>","searchTerm":"<search-term>","searchFilters":{<filters>}}
\`\`\`

**searchFilters structure (all fields OPTIONAL, varies by category):**
\`\`\`
// Vehicles:
{
  "category": "vehicle",
  "make": "GMC",           // Brand
  "model": "Sierra",       // Model name
  "year": 2025,            // Specific year
  "trims": ["Denali"],     // ARRAY - user can specify multiple!
  "series": "3500HD",      // Truck series
  "colors": ["Black"],     // ARRAY - multiple colors
  "bodyStyle": "Crew Cab",
  "drivetrain": "4WD",
  "fuelType": "Diesel",
  "transmission": "Auto"
}

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
\`\`\`

**Important:** Extract what you can from what the user says. If user only says "Denali truck", extract make="GMC" and model="Sierra", leave others null.

**Vehicle brands/keywords to recognize:**
- **Cars**: Toyota, Honda, Ford, Chevy, BMW, Mercedes, Tesla, etc.
- **Trucks**: F-150, Silverado, Ram, Tacoma, Sierra, etc.
- **SUVs**: RAV4, CR-V, Explorer, Highlander, Grand Cherokee, etc.
- **Luxury**: Denali (GMC), Escalade (Cadillac), Lexus, Porsche, etc.
- **Motorcycles**: Harley, Honda, Kawasaki, Ducati, etc.

**Extraction examples (with category):**
- "I want to buy a 2025 GMC Sierra Denali 3500 Dually" → {category:"vehicle",make:"GMC",model:"Sierra",year:2025,trims:["Denali"],series:"3500HD",searchTerm:"2025 GMC Sierra Denali 3500 dually"}
- "I want either a Denali or Denali Ultimate" → {category:"vehicle",make:"GMC",model:"Sierra",trims:["Denali","Denali Ultimate"]}
- "I want a Ford F-150" → {category:"vehicle",make:"Ford",model:"F-150",searchTerm:"Ford F-150"}
- "Looking for a Tesla Model 3" → {category:"vehicle",make:"Tesla",model:"Model 3",searchTerm:"Tesla Model 3"}
- "Want a Honda CR-V" → {category:"vehicle",make:"Honda",model:"CR-V",searchTerm:"Honda CR-V"}
- "Just want a Denali truck" → {category:"vehicle",make:"GMC",model:"Sierra",trims:["Denali"],searchTerm:"GMC Sierra Denali"}
- "Need a red or black truck" → {category:"vehicle",colors:["red","black"],searchTerm:"red or black truck"}
- "Looking for a diesel dually" → {category:"vehicle",fuelType:"Diesel",bodyStyle:"Dually"}
- "MacBook Pro with 16GB RAM" → {category:"technology",brands:["Apple"],minRam:"16GB",searchTerm:"MacBook Pro 16GB RAM"}

**Inference rules:**
- "Denali" → make="GMC", model="Sierra", trims=["Denali"]
- "Escalade" → make="Cadillac", model="Escalade"
- "dually" or "dual rear wheel" → bodyStyle="Dually" AND series="3500HD" (ALWAYS extract series for dually!)
- "3500HD", "3500", "1 ton" → series="3500HD"
- "2500HD", "2500", "3/4 ton" → series="2500HD"
- "1500", "150", "half ton" → series="1500"
- "Lariat", "Platinum", "Limited", "Denali Ultimate" → add to trims ARRAY
- User can specify multiple trims: "Denali or AT4" → trims=["Denali","AT4"]
- User can specify multiple colors: "Black or White" → colors=["Black","White"]

**Create a subgoal (under an existing goal):**
\`\`\`
CREATE_SUBGOAL: {"parentGoalId":"<goal-id>","type":"item|finance|action","title":"<title>","description":"<description>"}
\`\`\`

For item subgoals (vehicles, etc.), also include category and searchTerm:
\`\`\`
CREATE_SUBGOAL: {"parentGoalId":"<goal-id>","type":"item","title":"<title>","category":"vehicle","searchTerm":"<search-term>"}
\`\`\`

**Update goal progress:**
\`\`\`
UPDATE_PROGRESS: {"goalId":"<goal-id>","completionPercentage":50}
\`\`\`

**Important Workflow:**
- When creating goals with subgoals: ALWAYS output CREATE_GOAL first for the main goal, then output CREATE_SUBGOAL commands
- For CREATE_SUBGOAL immediately after CREATE_GOAL, you can use the main goal's title as parentGoalId (the system will match it)
- For subgoals under existing goals, use the actual goal ID

**CRITICAL**: When you output CREATE_GOAL, CREATE_SUBGOAL, or UPDATE_PROGRESS commands, end your response with the simple question: "Does this look good?"
Do NOT say things like "I'll proceed with creating this goal" or "I'll create this for you" or "Goal Created!" - the user will see a preview and action buttons to confirm. Just ask "Does this look good?"

Be conversational, encouraging, and specific. Reference their actual goals in your responses.`;
  }

  /**
   * Overview agent - chat with context of all user goals
   */
  async overviewChat(
    userId: string,
    message: string,
    goals: any[],
  ): Promise<{ content: string; commands?: any[] }> {
    // Use a special thread ID for overview chat
    const threadId = `overview_${userId}`;

    // Load conversation history
    let history = this.threadHistories.get(threadId);
    if (!history) {
      const messages = await this.loadThreadHistory(threadId, userId);
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
        model: 'gpt-4o-mini',
        messages,
        temperature: 0.7,
      });

      const content = response.choices[0]?.message?.content;
      if (!content) {
        throw new Error('No response from OpenAI');
      }

      // Add assistant response to history
      history.messages.push({ role: 'assistant', content });

      // Save messages to database
      await this.saveMessages(threadId, userId, [
        { role: 'user', content: message },
        { role: 'assistant', content },
      ]);

      // Parse structured commands
      const commands = this.parseCommands(content);

      return {
        content: this.cleanCommandsFromContent(content),
        commands
      };
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

    return commands;
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

    // Remove CREATE_SUBGOAL and UPDATE_PROGRESS commands (simple non-nested)
    cleaned = cleaned
      .replace(/CREATE_SUBGOAL:\s*{[^}]+}/g, '')
      .replace(/UPDATE_PROGRESS:\s*{[^}]+}/g, '')
      .trim();

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
        // Generic searchFilters display for ALL item categories
        if (goalData.searchFilters) {
          const sf = goalData.searchFilters;
          if (goalData.category === 'vehicle') {
            preview += `\n**Vehicle Details:**\n`;
            if (sf.make && sf.model) {
              preview += `- Make/Model: ${sf.make} ${sf.model}\n`;
            }
            if (sf.year) {
              preview += `- Year: ${sf.year}\n`;
            }
            if (sf.trims && sf.trims.length > 0) {
              preview += `- Trims: ${sf.trims.join(', ')}\n`;
            }
            if (sf.series) {
              preview += `- Series: ${sf.series}\n`;
            }
            if (sf.colors && sf.colors.length > 0) {
              preview += `- Colors: ${sf.colors.join(', ')}\n`;
            }
            if (sf.bodyStyle) {
              preview += `- Body Style: ${sf.bodyStyle}\n`;
            }
            if (sf.drivetrain) {
              preview += `- Drivetrain: ${sf.drivetrain}\n`;
            }
          } else if (goalData.category === 'technology') {
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
  ): AsyncGenerator<{ content: string; done: boolean }, void, unknown> {
    const threadId = `overview_${userId}`;

    // Load conversation history
    let history = this.threadHistories.get(threadId);
    if (!history) {
      const messages = await this.loadThreadHistory(threadId, userId);
      history = { messages };
      this.threadHistories.set(threadId, history);
    }

    try {
      // Add user message
      history.messages.push({ role: 'user', content: message });

      // Create messages with goal context
      const messages: ChatCompletionMessageParam[] = [
        { role: 'system', content: this.getOverviewSystemPrompt(goals) },
        ...history.messages,
      ];

      const stream = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages,
        temperature: 0.7,
        stream: true,
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
      const finalChunk: { content: string; done: true; goalPreview?: string; awaitingConfirmation?: boolean; commands?: any[] } = {
        content: '',
        done: true,
      };

      // If commands were detected, add confirmation data
      if (commands.length > 0) {
        finalChunk.goalPreview = this.generateGoalPreview(commands);
        finalChunk.awaitingConfirmation = true;
        finalChunk.commands = commands;
      }

      // Add assistant response to history
      history.messages.push({ role: 'assistant', content: fullContent });

      // Save messages to database
      await this.saveMessages(threadId, userId, [
        { role: 'user', content: message },
        { role: 'assistant', content: fullContent },
      ]);

      yield finalChunk;
    } catch (error) {
      this.logger.error('Overview chat stream error:', error);
      throw error;
    }
  }
}
