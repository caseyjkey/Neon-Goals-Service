import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Sse,
  Logger,
  UseGuards,
  Req,
} from '@nestjs/common';
import { Observable, fromEvent, map, merge, of, interval } from 'rxjs';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ProductExtractionService, ProgressData } from './product-extraction.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Request } from 'express';

interface CallbackDto {
  jobId: string;
  result: {
    success: boolean;
    name?: string;
    price?: number;
    imageUrl?: string;
    currency?: string;
    error?: string;
  };
}

interface ProgressDto {
  jobId: string;
  status: string;
  message: string;
}

interface CreateGoalsDto {
  groupId: string;
  groupName: string;
}

@Controller('extraction')
export class ExtractionController {
  private readonly logger = new Logger(ExtractionController.name);

  constructor(
    private extractionService: ProductExtractionService,
    private eventEmitter: EventEmitter2,
  ) {}

  /**
   * Callback endpoint for worker to report extraction results
   * Called by the worker when extraction completes
   */
  @Post('callback')
  async handleCallback(@Body() data: CallbackDto) {
    this.logger.log(`Received callback for job ${data.jobId}`);

    try {
      await this.extractionService.handleCallback(data.jobId, data.result);
      return { acknowledged: true, jobId: data.jobId };
    } catch (error) {
      this.logger.error(`Callback failed for job ${data.jobId}: ${error.message}`);
      return { acknowledged: false, error: error.message };
    }
  }

  /**
   * Progress endpoint for worker to stream progress updates
   * Called by the worker during extraction
   */
  @Post('progress')
  async handleProgress(@Body() data: ProgressDto) {
    this.logger.log(`Received progress for job ${data.jobId}: ${data.status}`);

    try {
      await this.extractionService.handleProgress(data.jobId, {
        status: data.status,
        message: data.message,
      });
      return { acknowledged: true, jobId: data.jobId };
    } catch (error) {
      this.logger.error(`Progress update failed for job ${data.jobId}: ${error.message}`);
      return { acknowledged: false, error: error.message };
    }
  }

  /**
   * SSE endpoint for clients to stream extraction progress
   * Clients subscribe to updates for a specific groupId
   */
  @Sse('stream/:groupId')
  streamExtractions(
    @Param('groupId') groupId: string,
  ): Observable<MessageEvent> {
    this.logger.log(`SSE client connected for group ${groupId}`);

    // Create observables for all event types
    const progressObservable = fromEvent(
      this.eventEmitter,
      'extraction:progress',
    ).pipe(
      map((data: ProgressData) => ({
        data: JSON.stringify({
          type: 'progress',
          ...data,
        }),
      } as MessageEvent)),
    );

    const completeObservable = fromEvent(
      this.eventEmitter,
      'extraction:complete',
    ).pipe(
      map((data: any) => ({
        data: JSON.stringify({
          type: 'complete',
          ...data,
        }),
      } as MessageEvent)),
    );

    const groupCompleteObservable = fromEvent(
      this.eventEmitter,
      'extraction:group_complete',
    ).pipe(
      map((data: any) => ({
        data: JSON.stringify({
          type: 'group_complete',
          groupId: data.groupId,
          results: data.results,
        }),
      } as MessageEvent)),
    );

    // Merge all observables
    const eventStream = merge(progressObservable, completeObservable, groupCompleteObservable);

    // Add a heartbeat to keep the connection alive
    const heartbeat = interval(30000).pipe(
      map(() => ({
        data: JSON.stringify({ type: 'heartbeat' }),
      } as MessageEvent)),
    );

    // Combine events with heartbeat
    return merge(eventStream, heartbeat);
  }

  /**
   * Get status of all jobs in a group
   */
  @Get('jobs/:groupId')
  @UseGuards(JwtAuthGuard)
  async getGroupJobs(@Param('groupId') groupId: string, @Req() req: Request) {
    const jobs = await this.extractionService.getGroupJobs(groupId);
    return { groupId, jobs };
  }

  /**
   * Get status of a single job
   */
  @Get('job/:jobId')
  @UseGuards(JwtAuthGuard)
  async getJobStatus(@Param('jobId') jobId: string) {
    const job = await this.extractionService.getJobStatus(jobId);
    if (!job) {
      return { error: 'Job not found' };
    }
    return job;
  }

  /**
   * Check if a group is complete
   */
  @Get('complete/:groupId')
  @UseGuards(JwtAuthGuard)
  async isGroupComplete(@Param('groupId') groupId: string) {
    const isComplete = await this.extractionService.isGroupComplete(groupId);
    return { groupId, isComplete };
  }

  /**
   * Get results for a completed group
   */
  @Get('results/:groupId')
  @UseGuards(JwtAuthGuard)
  async getGroupResults(@Param('groupId') groupId: string) {
    const results = await this.extractionService.getGroupResults(groupId);
    return { groupId, results };
  }

  /**
   * Create goals from extraction results
   */
  @Post('create-goals')
  @UseGuards(JwtAuthGuard)
  async createGoals(
    @Body() data: CreateGoalsDto,
    @Req() req: Request,
  ) {
    const user = req.user as any;
    const userId = user.id || user.sub;

    this.logger.log(`Creating goals for group ${data.groupId} (user: ${userId})`);

    try {
      const groupGoal = await this.extractionService.createGoalsFromExtractions(
        data.groupId,
        data.groupName,
        userId,
      );
      return { success: true, groupGoal };
    } catch (error) {
      this.logger.error(`Failed to create goals: ${error.message}`);
      return { success: false, error: error.message };
    }
  }
}
