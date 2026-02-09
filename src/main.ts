import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // ADD THIS LINE - Global API prefix for production reverse proxy
  app.setGlobalPrefix('api');

  // Enable CORS for the frontend
  const isDev = process.env.NODE_ENV !== 'production';

  app.enableCors({
    origin: isDev
      ? /https?:\/\/(localhost|127\.0\.0\.1|100\.82\.23\.47)(:\d+)?/  // Allow any port on localhost or your network IP in dev
      : [
          'http://localhost:8080',
          'http://localhost:8081',
          'http://localhost:8082',
          'http://localhost:8083',
          'http://localhost:5173',
          'http://localhost:3000',
          // Tailscale and network IPs for mobile testing
          'http://100.82.23.47:8080',
          'http://100.82.23.47:8081',
          'http://100.82.23.47:8082',
        ],
    credentials: true,
  });

  // Global validation pipe
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      transformOptions: {
        enableImplicitConversion: true,
      },
    }),
  );

  await app.listen(3001);
  console.log('🚀 Neon Goals API running on http://localhost:3001');
}
bootstrap();
