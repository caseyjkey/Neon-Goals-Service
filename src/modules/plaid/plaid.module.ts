import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PlaidController } from './plaid.controller';
import { PlaidService } from './plaid.service';
import { PlaidSchedulerService } from './plaid-scheduler.service';

@Module({
  imports: [ConfigModule],
  controllers: [PlaidController],
  providers: [PlaidService, PlaidSchedulerService],
  exports: [PlaidService],
})
export class PlaidModule {}
