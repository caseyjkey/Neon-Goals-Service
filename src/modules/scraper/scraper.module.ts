import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ScraperService } from './scraper.service';
import { ScraperController } from './scraper.controller';
import { VehicleQueryService } from './vehicle-query.service';
import { VehicleQueryController } from './vehicle-query.controller';
import { PrismaService } from '../../config/prisma.service';

@Module({
  imports: [HttpModule],
  controllers: [ScraperController, VehicleQueryController],
  providers: [ScraperService, VehicleQueryService, PrismaService],
  exports: [ScraperService, VehicleQueryService],
})
export class ScraperModule {}
