import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { applySecurityMiddleware } from '@metrock/backend-common';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  applySecurityMiddleware(app);
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
  );
  const port = process.env.PORT ? Number(process.env.PORT) : 3007;
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`hr-service listening on :${port}`);
}
bootstrap();
