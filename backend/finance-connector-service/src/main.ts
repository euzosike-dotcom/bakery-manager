import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { applySecurityMiddleware, StructuredLogger } from '@metrock/backend-common';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(new StructuredLogger('finance-connector-service'));
  applySecurityMiddleware(app);
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
  );
  const port = process.env.PORT ? Number(process.env.PORT) : 3009;
  await app.listen(port);
  new Logger('Bootstrap').log(`finance-connector-service listening on :${port}`);
}
bootstrap();
